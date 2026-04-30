import mongoose from "mongoose"
import Client from "../models/Client.js"
import Folder from "../models/Folder.js"
import SmsMessage from "../models/SmsMessage.js"
import { sendArkeselSms } from "../services/arkeselSms.js"
import { normalizeGhanaMsisdn, formatPhoneDisplay } from "../utils/phoneGh.js"
import {
    SMS_PLACEHOLDER_DEFS,
    replaceSmsPlaceholders,
    templateNeedsFolder,
} from "../utils/smsPlaceholders.js"
import { parseSmsCostPerMessage } from "../utils/smsCost.js"
import { applySmsBranding } from "../utils/smsBranding.js"

/**
 * Frontends often send `client`, `selectedClientId`, or `{ client: { _id } }` instead of `clientId`.
 */
function resolveSingleClientId(body) {
    const raw =
        body?.clientId ??
        body?.client_id ??
        body?.client ??
        body?.selectedClientId ??
        body?.selectedClient
    if (raw !== undefined && raw !== null && typeof raw === "object") {
        const id = raw._id ?? raw.id
        if (id !== undefined && id !== null) return String(id).trim()
    }
    if (typeof raw === "string") return raw.trim()
    return ""
}

export const getSmsMeta = async (req, res) => {
    try {
        const bulkDefault =
            process.env.SMS_BULK_DEFAULT_CLIENT_NAME?.trim() || "there"
        return res.status(200).json({
            placeholders: SMS_PLACEHOLDER_DEFS,
            recipientTypes: [
                { id: "all_clients", label: "All clients" },
                { id: "client", label: "Single client" },
            ],
            configured: !!(process.env.ARKESEL_API_KEY && process.env.ARKESEL_SENDER_ID),
            bulkSend:
                "Manual sends use one Arkesel API request per dispatch. For all_clients, {{client_name}} is replaced once with SMS_BULK_DEFAULT_CLIENT_NAME or the default \"there\", since every recipient gets the same message body.",
            smsBulkDefaultClientName: bulkDefault,
            smsBranding: {
                prefixSet: !!(process.env.SMS_BRAND_PREFIX || "").trim(),
                suffixSet: !!(process.env.SMS_BRAND_SUFFIX || "").trim(),
            },
            singleClientIdFields: [
                "clientId",
                "client_id",
                "client (Mongo id string or { _id })",
                "selectedClientId",
                "selectedClient",
            ],
        })
    } catch (error) {
        console.error("SMS meta error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

const parsePage = (raw, fallback = 1) => {
    const n = parseInt(raw, 10)
    if (Number.isNaN(n) || n < 1) return fallback
    return n
}

const parseLimit = (raw, fallback = 10, { max = 100 } = {}) => {
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) return fallback
    return Math.min(Math.max(n, 1), max)
}

export const listSmsMessages = async (req, res) => {
    try {
        const page = parsePage(req.query.page, 1)
        const limit = parseLimit(req.query.limit, 10)
        const { search, status } = req.query

        const filter = {}
        if (status && ["sent", "failed", "pending"].includes(status)) {
            filter.status = status
        }
        if (search && String(search).trim()) {
            const q = String(search).trim()
            filter.$or = [
                { message: { $regex: q, $options: "i" } },
                { recipientName: { $regex: q, $options: "i" } },
                { recipientPhone: { $regex: q, $options: "i" } },
            ]
        }

        const skip = (page - 1) * limit
        const [items, total] = await Promise.all([
            SmsMessage.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            SmsMessage.countDocuments(filter),
        ])

        return res.status(200).json({
            messages: items,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit) || 1,
            },
        })
    } catch (error) {
        console.error("List SMS error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const sendBulkSms = async (req, res) => {
    try {
        const { recipientType, folderId, message } = req.body

        if (!message || typeof message !== "string" || !message.trim()) {
            return res.status(400).json({ message: "Message is required" })
        }

        const template = message.trim()

        if (!recipientType || !["all_clients", "client"].includes(recipientType)) {
            return res.status(400).json({
                message: "recipientType must be all_clients or client",
            })
        }

        let resolvedClientId = ""
        if (recipientType === "client") {
            resolvedClientId = resolveSingleClientId(req.body)
            if (
                !resolvedClientId ||
                !mongoose.Types.ObjectId.isValid(resolvedClientId)
            ) {
                return res.status(400).json({
                    message:
                        "A client id is required when recipientType is client (use clientId, client_id, client, selectedClientId, or selectedClient — see GET /api/sms/meta)",
                })
            }
        }

        if (templateNeedsFolder(template) && !folderId) {
            return res.status(400).json({
                message:
                    "folderId is required when the message uses {{event_date}} or {{gallery_link}}",
            })
        }

        let folderDoc = null
        if (folderId) {
            if (!mongoose.Types.ObjectId.isValid(folderId)) {
                return res.status(400).json({ message: "Invalid folder id" })
            }
            folderDoc = await Folder.findById(folderId)
            if (!folderDoc) {
                return res.status(404).json({ message: "Folder not found" })
            }
            if (recipientType === "client") {
                const fid = String(folderDoc.client)
                if (fid !== String(resolvedClientId)) {
                    return res.status(400).json({
                        message: "Folder does not belong to the selected client",
                    })
                }
            }
        }

        let clients = []
        if (recipientType === "all_clients") {
            clients = await Client.find().sort({ createdAt: -1 }).lean()
        } else {
            const c = await Client.findById(resolvedClientId).lean()
            if (!c) {
                return res.status(404).json({ message: "Client not found" })
            }
            clients = [c]
        }

        if (!clients.length) {
            return res.status(400).json({ message: "No recipients found" })
        }

        const costPer = parseSmsCostPerMessage()
        const skipped = []
        const valid = []

        for (const client of clients) {
            const msisdn = normalizeGhanaMsisdn(client.contact)
            if (!msisdn) {
                skipped.push({
                    clientId: client._id,
                    name: client.name,
                    reason: "Invalid or unsupported phone number",
                })
                continue
            }
            valid.push({ client, msisdn })
        }

        if (valid.length === 0) {
            return res.status(400).json({
                message: "No recipients with a valid Ghana phone number",
                skipped,
            })
        }

        const bulkDefault =
            process.env.SMS_BULK_DEFAULT_CLIENT_NAME?.trim() || "there"

        const rendered = replaceSmsPlaceholders(template, {
            clientName:
                recipientType === "all_clients"
                    ? bulkDefault
                    : valid[0].client.name,
            folder: folderDoc,
        })

        if (!rendered.trim()) {
            return res.status(400).json({
                message: "Message is empty after placeholders",
            })
        }

        const branded = applySmsBranding(rendered)
        if (!branded.trim()) {
            return res.status(400).json({
                message: "Message is empty after branding",
            })
        }

        const arkesel = await sendArkeselSms({
            recipients: valid.map((v) => v.msisdn),
            message: branded,
        })

        const sentOk = arkesel.ok
        const results = []

        for (const { client, msisdn } of valid) {
            const row = await SmsMessage.create({
                recipientName: client.name,
                recipientPhone: formatPhoneDisplay(msisdn),
                recipientKind: "individual",
                message: branded,
                messageLength: branded.length,
                status: sentOk ? "sent" : "failed",
                costGHS: sentOk ? costPer : 0,
                errorMessage: sentOk ? "" : (arkesel.error || "Send failed"),
                arkeselRaw: arkesel.data || null,
                client: client._id,
                folder: folderDoc ? folderDoc._id : null,
                recipientType,
                trigger: "manual",
                createdBy: req.user?._id,
            })

            results.push({
                id: row._id,
                clientId: client._id,
                status: row.status,
                error: row.errorMessage || undefined,
            })
        }

        const sent = results.filter((r) => r.status === "sent").length
        const failed = results.filter((r) => r.status === "failed").length

        return res.status(200).json({
            message: `SMS dispatch finished: ${sent} sent, ${failed} failed, ${skipped.length} skipped (one API request to Arkesel)`,
            summary: {
                sent,
                failed,
                skipped: skipped.length,
                arkeselRequests: 1,
            },
            results,
            skipped,
        })
    } catch (error) {
        console.error("Send SMS error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
