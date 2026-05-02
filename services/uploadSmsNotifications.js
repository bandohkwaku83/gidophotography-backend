/**
 * Called after raw/final uploads when readUploadCompleteNotify(req) is true.
 * Notifications are debounced per folder so parallel/chunked uploads (multiple HTTP
 * requests) still produce one SMS (SMS_UPLOAD_NOTIFY_DEBOUNCE_MS).
 */
import Client from "../models/Client.js"
import Folder from "../models/Folder.js"
import SmsMessage from "../models/SmsMessage.js"
import { sendArkeselSms } from "./arkeselSms.js"
import { normalizeGhanaMsisdn, formatPhoneDisplay } from "../utils/phoneGh.js"
import { replaceSmsPlaceholders } from "../utils/smsPlaceholders.js"
import { buildGalleryShareUrl } from "../utils/shareUrl.js"
import { parseSmsCostPerMessage } from "../utils/smsCost.js"
import { applySmsBranding } from "../utils/smsBranding.js"

/** Debounce window after the last upload request before sending one SMS (ms). */
function parseUploadNotifyDebounceMs() {
    const raw = process.env.SMS_UPLOAD_NOTIFY_DEBOUNCE_MS
    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return 2500
    }
    const n = parseInt(String(raw), 10)
    if (!Number.isFinite(n)) return 2500
    return Math.min(Math.max(n, 400), 120000)
}

const rawNotifyTimers = new Map()
const finalNotifyTimers = new Map()

function envFlag(key, defaultTrue = true) {
    const v = process.env[key]
    if (v === undefined || v === null || String(v).trim() === "") return defaultTrue
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}

/** Unset → one SMS (studio default copy). Set SMS_FINAL_UNPAID_SPLIT_SEND=true to send link in a follow-up text if your gateway blocks long messages. */
function envSplitFinalUnpaidSms() {
    const v = process.env.SMS_FINAL_UNPAID_SPLIT_SEND
    if (v === undefined || v === null || String(v).trim() === "") return false
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}

function parseFinalUnpaidSplitDelayMs() {
    const n = parseInt(process.env.SMS_FINAL_UNPAID_SPLIT_DELAY_MS || "1200", 10)
    if (!Number.isFinite(n)) return 1200
    return Math.min(Math.max(n, 400), 15000)
}

async function sendFolderClientSms({
    folder,
    client,
    template,
    userId,
    trigger,
    applyBranding = true,
}) {
    const msisdn = normalizeGhanaMsisdn(client.contact)
    if (!msisdn) {
        console.warn(
            `[SMS ${trigger}] skipped: invalid phone for client ${client._id}`
        )
        return
    }

    const rendered = replaceSmsPlaceholders(template, {
        clientName: client.name,
        folder,
    })

    if (!rendered.trim()) return

    const branded = applyBranding ? applySmsBranding(rendered) : rendered
    if (!branded.trim()) return

    const arkesel = await sendArkeselSms({
        recipients: [msisdn],
        message: branded,
    })

    if (!arkesel.ok) {
        const preview = branded.slice(0, 280).replace(/\n/g, "\\n")
        console.warn(`[SMS ${trigger}] Arkesel: ${arkesel.error || "failed"} | ${preview}`)
    }

    const costPer = parseSmsCostPerMessage()
    await SmsMessage.create({
        recipientName: client.name,
        recipientPhone: formatPhoneDisplay(msisdn),
        recipientKind: "individual",
        message: branded,
        messageLength: branded.length,
        status: arkesel.ok ? "sent" : "failed",
        costGHS: arkesel.ok ? costPer : 0,
        errorMessage: arkesel.ok ? "" : (arkesel.error || "Send failed"),
        arkeselRaw: arkesel.data || null,
        client: client._id,
        folder: folder._id,
        recipientType: "client",
        trigger,
        createdBy: userId || undefined,
    })
}

const DEFAULT_RAW_UPLOAD_TEMPLATE_WITH_LINK =
    "Hi {{client_name}}, your photos have been uploaded. Please review them and select your preferred images for editing. {{gallery_link}}"

const DEFAULT_RAW_UPLOAD_TEMPLATE_NO_LINK =
    "Hi {{client_name}}, your photos have been uploaded. Please review them and select your preferred images for editing."

async function runRawUploadSms(folderId, userId) {
    if (!envFlag("SMS_NOTIFY_ON_RAW_UPLOAD", true)) return

    const folder = await Folder.findById(folderId)
    if (!folder) return

    const envRaw = process.env.SMS_NOTIFY_RAW_TEMPLATE?.trim()
    let template
    if (envRaw) {
        template = envRaw
    } else if (folder.share?.enabled) {
        template = DEFAULT_RAW_UPLOAD_TEMPLATE_WITH_LINK
    } else {
        template = DEFAULT_RAW_UPLOAD_TEMPLATE_NO_LINK
    }

    const client = await Client.findById(folder.client)
    if (!client) return

    await sendFolderClientSms({
        folder,
        client,
        template,
        userId,
        trigger: "raw_upload",
    })
}

const DEFAULT_FINAL_TEMPLATE_WITH_LINK =
    "Hi {{client_name}}, your final photos are ready. View your gallery: {{gallery_link}}"

const DEFAULT_FINAL_TEMPLATE_NO_LINK =
    "Hi {{client_name}}, your final photos are ready. We'll share your gallery link when it's available."

/**
 * Gallery URL for SMS: Arkesel often flags `https://` + money text in one message.
 * Default strips the scheme (many phones still open the host path).
 * SMS_FINAL_UNPAID_URL_FORMAT: noscheme (default) | full | none
 */
function galleryLinkForUnpaidSms(folder) {
    const raw = buildGalleryShareUrl(folder)
    if (!raw) return ""
    const mode = (process.env.SMS_FINAL_UNPAID_URL_FORMAT || "noscheme")
        .trim()
        .toLowerCase()
    if (mode === "none" || mode === "off") return ""
    if (mode === "full") return raw
    return raw.replace(/^https?:\/\//i, "").trim()
}

/**
 * Optional extra lines for unpaid SMS (e.g. bank details). Default template does not
 * include {{payment_block}}; add that token to SMS_NOTIFY_FINAL_UNPAID_TEMPLATE if needed.
 */
const DEFAULT_FINAL_UNPAID_PAYMENT_BLOCK = ""

const DEFAULT_FINAL_UNPAID_TEMPLATE = `Hi {{client_name}},

Your photos are ready. You can complete the remaining payment to access them.

{{outstanding_amount}} GHS

{{gallery_link}}

MoMo: 0247928392 (Kojo Ennin)

Thank you.

signed
GidoPhotography/weddings and vows`

/** When split: intro + amount (no gallery URL). */
const DEFAULT_FINAL_UNPAID_PART1 = `Hi {{client_name}},

Your photos are ready. You can complete the remaining payment to access them.

{{outstanding_amount}} GHS`

/** When split: gallery link, MoMo line, thank you, signature. */
const DEFAULT_FINAL_UNPAID_PART2 = `{{gallery_link}}

MoMo: 0247928392 (Kojo Ennin)

Thank you.

signed
GidoPhotography/weddings and vows`

function replaceUnpaidSmsPlaceholders(template, ctx) {
    const { amountStr, paymentBlock, clientName, folder } = ctx
    let t = String(template)
    t = t.replace(/\{\{\s*outstanding_amount\s*\}\}/gi, amountStr)
    t = t.replace(/\{\{\s*payment_block\s*\}\}/gi, paymentBlock)
    let galleryLinkOverride
    if (Object.prototype.hasOwnProperty.call(ctx, "galleryLinkForSms")) {
        galleryLinkOverride = ctx.galleryLinkForSms
    } else {
        galleryLinkOverride = galleryLinkForUnpaidSms(folder)
    }
    return replaceSmsPlaceholders(t, {
        clientName,
        folder,
        galleryLinkOverride,
    })
}

async function runFinalUploadSmsInternal(folder, userId) {
    if (!envFlag("SMS_NOTIFY_ON_FINAL_UPLOAD", true)) return

    const envFinal = process.env.SMS_NOTIFY_FINAL_TEMPLATE?.trim()
    let template
    if (envFinal) {
        template = envFinal
    } else if (folder.share?.enabled) {
        template = DEFAULT_FINAL_TEMPLATE_WITH_LINK
    } else {
        template = DEFAULT_FINAL_TEMPLATE_NO_LINK
    }

    const client = await Client.findById(folder.client)
    if (!client) return

    await sendFolderClientSms({
        folder,
        client,
        template,
        userId,
        trigger: "final_upload",
    })
}

async function runFinalUnpaidUploadSms(folder, userId) {
    if (!envFlag("SMS_NOTIFY_ON_FINAL_UPLOAD", true)) return

    const client = await Client.findById(folder.client)
    if (!client) return

    const amt = folder.finalDelivery?.outstandingAmountGHS
    const amountStr =
        amt != null && Number.isFinite(Number(amt)) ? String(amt) : ""

    const paymentBlock =
        process.env.SMS_FINAL_UNPAID_PAYMENT_BLOCK?.trim() ||
        DEFAULT_FINAL_UNPAID_PAYMENT_BLOCK

    const split = envSplitFinalUnpaidSms()

    if (split) {
        const part1Tpl =
            process.env.SMS_NOTIFY_FINAL_UNPAID_PART1?.trim() ||
            DEFAULT_FINAL_UNPAID_PART1
        const rendered1 = replaceUnpaidSmsPlaceholders(part1Tpl, {
            amountStr,
            paymentBlock: "",
            clientName: client.name,
            folder,
            galleryLinkForSms: galleryLinkForUnpaidSms(folder),
        })
        await sendFolderClientSms({
            folder,
            client,
            template: rendered1,
            userId,
            trigger: "final_delivery_unpaid",
            applyBranding: false,
        })

        const part2Tpl =
            process.env.SMS_NOTIFY_FINAL_UNPAID_PART2?.trim() ||
            DEFAULT_FINAL_UNPAID_PART2
        const rendered2 = replaceUnpaidSmsPlaceholders(part2Tpl, {
            amountStr,
            paymentBlock,
            clientName: client.name,
            folder,
            galleryLinkForSms: galleryLinkForUnpaidSms(folder),
        })
        const suffix = process.env.SMS_FINAL_UNPAID_PART2_SUFFIX?.trim() || ""
        const part2Core = [rendered2, suffix].filter(Boolean).join("\n\n").trim()
        if (part2Core) {
            await new Promise((r) => setTimeout(r, parseFinalUnpaidSplitDelayMs()))
            await sendFolderClientSms({
                folder,
                client,
                template: part2Core,
                userId,
                trigger: "final_delivery_unpaid",
                applyBranding: false,
            })
        }
        return
    }

    const envTpl = process.env.SMS_NOTIFY_FINAL_UNPAID_TEMPLATE?.trim()
    const template = envTpl || DEFAULT_FINAL_UNPAID_TEMPLATE

    const rendered = replaceUnpaidSmsPlaceholders(template, {
        amountStr,
        paymentBlock,
        clientName: client.name,
        folder,
        galleryLinkForSms: galleryLinkForUnpaidSms(folder),
    })

    await sendFolderClientSms({
        folder,
        client,
        template: rendered,
        userId,
        trigger: "final_delivery_unpaid",
        applyBranding: false,
    })
}

async function runFinalUploadSmsRouter(folderId, userId) {
    const folder = await Folder.findById(folderId)
    if (!folder) return

    const amt = folder.finalDelivery?.outstandingAmountGHS
    if (amt != null && Number(amt) > 0) {
        await runFinalUnpaidUploadSms(folder, userId)
    } else {
        await runFinalUploadSmsInternal(folder, userId)
    }
}

function debounceFolderNotify(timerMap, folderId, userId, runner, label) {
    const key = String(folderId)
    const prev = timerMap.get(key)
    if (prev) clearTimeout(prev)

    const ms = parseUploadNotifyDebounceMs()
    const tid = setTimeout(() => {
        timerMap.delete(key)
        runner(folderId, userId).catch((err) =>
            console.error(`[SMS ${label}]`, err)
        )
    }, ms)

    timerMap.set(key, tid)
}

/** Does not block the HTTP response; one SMS after uploads settle (debounced). */
export function scheduleRawUploadSms(folderId, userId) {
    debounceFolderNotify(
        rawNotifyTimers,
        folderId,
        userId,
        runRawUploadSms,
        "raw_upload"
    )
}

export function scheduleFinalUploadSms(folderId, userId) {
    debounceFolderNotify(
        finalNotifyTimers,
        folderId,
        userId,
        runFinalUploadSmsRouter,
        "final_upload"
    )
}
