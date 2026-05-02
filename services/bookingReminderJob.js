import cron from "node-cron"
import Booking from "../models/Booking.js"
import SmsMessage from "../models/SmsMessage.js"
import { sendArkeselSms } from "./arkeselSms.js"
import { normalizeGhanaMsisdn, formatPhoneDisplay } from "../utils/phoneGh.js"
import { parseSmsCostPerMessage } from "../utils/smsCost.js"
import { applySmsBranding } from "../utils/smsBranding.js"

const PLACEHOLDER =
    /\{\{\s*(client_name|shoot_title|starts_at|location|admin_name)\s*\}\}/g

function envFlag(key, defaultTrue = true) {
    const v = process.env[key]
    if (v === undefined || v === null || String(v).trim() === "") return defaultTrue
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}

function parsePositiveFloat(raw, fallback) {
    const n = parseFloat(String(raw ?? "").trim())
    if (!Number.isFinite(n) || n <= 0) return fallback
    return n
}

function formatStartsAt(date, timeZone) {
    const d = date instanceof Date ? date : new Date(date)
    if (Number.isNaN(d.getTime())) return ""
    try {
        return new Intl.DateTimeFormat("en-GB", {
            timeZone,
            dateStyle: "medium",
            timeStyle: "short",
        }).format(d)
    } catch {
        return d.toISOString()
    }
}

function renderBookingReminderTemplate(template, ctx) {
    return String(template ?? "").replace(PLACEHOLDER, (_, key) => {
        if (key === "client_name") return ctx.clientName ?? ""
        if (key === "shoot_title") return ctx.shootTitle ?? ""
        if (key === "starts_at") return ctx.startsAt ?? ""
        if (key === "location") return ctx.location ?? ""
        if (key === "admin_name") return ctx.adminName ?? ""
        return ""
    })
}

const DEFAULT_CLIENT_TEMPLATE =
    "Hi {{client_name}}, reminder: your shoot \"{{shoot_title}}\" is in about 24 hours ({{starts_at}}). Location: {{location}}"

const DEFAULT_ADMIN_TEMPLATE =
    "Reminder: \"{{shoot_title}}\" for {{client_name}} at {{starts_at}}. Location: {{location}}"

function parseFallbackAdminPhones() {
    const raw = process.env.BOOKING_REMINDER_ADMIN_PHONE?.trim()
    if (!raw) return []
    return raw
        .split(/[,;\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
}

/**
 * Finds bookings whose startsAt is between (now + hoursBefore - windowH) and (now + hoursBefore + windowH).
 * With hoursBefore=24, windowH=1 and hourly cron, each booking is picked once in a ~2h band before the shoot.
 */
export async function runBookingReminders() {
    if (!envFlag("BOOKING_REMINDER_ENABLED", true)) return

    const hoursBefore = parsePositiveFloat(process.env.BOOKING_REMINDER_HOURS_BEFORE, 24)
    const windowH = parsePositiveFloat(process.env.BOOKING_REMINDER_WINDOW_HOURS, 1)
    const timeZone =
        process.env.BOOKING_REMINDER_TIMEZONE?.trim() || "Africa/Accra"

    const now = Date.now()
    const msBefore = hoursBefore * 60 * 60 * 1000
    const msHalf = windowH * 60 * 60 * 1000
    const minStart = new Date(now + msBefore - msHalf)
    const maxStart = new Date(now + msBefore + msHalf)

    const bookings = await Booking.find({
        startsAt: { $gte: minStart, $lte: maxStart },
        $or: [
            { reminderClientSentAt: null },
            { reminderAdminSentAt: null },
        ],
    })
        .populate({
            path: "client",
            select: "name contact email location",
        })
        .populate({
            path: "createdBy",
            select: "name contact email",
        })
        .lean()

    const clientTpl =
        process.env.SMS_BOOKING_REMINDER_CLIENT_TEMPLATE?.trim() ||
        DEFAULT_CLIENT_TEMPLATE
    const adminTpl =
        process.env.SMS_BOOKING_REMINDER_ADMIN_TEMPLATE?.trim() ||
        DEFAULT_ADMIN_TEMPLATE

    const fallbackAdmins = parseFallbackAdminPhones()

    for (const b of bookings) {
        const client = b.client
        const creator = b.createdBy
        const startsAtLabel = formatStartsAt(b.startsAt, timeZone)
        const loc = (b.location || "").trim()

        const baseCtx = {
            clientName: client?.name || "Client",
            shootTitle: b.title || "",
            startsAt: startsAtLabel,
            location: loc,
            adminName: creator?.name || "",
        }

        if (!b.reminderClientSentAt && client) {
            const msisdn = normalizeGhanaMsisdn(client.contact)
            if (!msisdn) {
                console.warn(
                    `[booking_reminder_client] skipped: invalid phone for client ${client._id}`
                )
            } else {
                const body = renderBookingReminderTemplate(clientTpl, baseCtx).trim()
                const branded = applySmsBranding(body)
                if (branded.trim()) {
                    const arkesel = await sendArkeselSms({
                        recipients: [msisdn],
                        message: branded,
                    })
                    if (!arkesel.ok) {
                        console.warn(
                            `[booking_reminder_client] Arkesel: ${arkesel.error || "failed"} | booking ${b._id}`
                        )
                    }
                    const costPer = parseSmsCostPerMessage()
                    await SmsMessage.create({
                        recipientName: client.name || "",
                        recipientPhone: formatPhoneDisplay(msisdn),
                        recipientKind: "individual",
                        message: branded,
                        messageLength: branded.length,
                        status: arkesel.ok ? "sent" : "failed",
                        costGHS: arkesel.ok ? costPer : 0,
                        errorMessage: arkesel.ok ? "" : (arkesel.error || "Send failed"),
                        arkeselRaw: arkesel.data || null,
                        client: client._id,
                        folder: null,
                        booking: b._id,
                        recipientType: "client",
                        trigger: "booking_reminder_client",
                        createdBy: b.createdBy?._id || undefined,
                    })
                    if (arkesel.ok) {
                        await Booking.updateOne(
                            { _id: b._id },
                            { $set: { reminderClientSentAt: new Date() } }
                        )
                    }
                }
            }
        }

        if (!b.reminderAdminSentAt) {
            const fromUser =
                creator && creator.contact
                    ? normalizeGhanaMsisdn(creator.contact)
                    : null
            const adminNumbers = []
            if (fromUser) adminNumbers.push(fromUser)
            for (const f of fallbackAdmins) {
                const n = normalizeGhanaMsisdn(f)
                if (n && !adminNumbers.includes(n)) adminNumbers.push(n)
            }

            if (adminNumbers.length === 0) {
                console.warn(
                    `[booking_reminder_admin] skipped: no phone (set User.contact for creator or BOOKING_REMINDER_ADMIN_PHONE) | booking ${b._id}`
                )
            } else {
                const body = renderBookingReminderTemplate(adminTpl, baseCtx).trim()
                const branded = applySmsBranding(body)
                if (branded.trim()) {
                    const arkesel = await sendArkeselSms({
                        recipients: adminNumbers,
                        message: branded,
                    })
                    if (!arkesel.ok) {
                        console.warn(
                            `[booking_reminder_admin] Arkesel: ${arkesel.error || "failed"} | booking ${b._id}`
                        )
                    }
                    const costPer = parseSmsCostPerMessage()
                    const display = adminNumbers.map(formatPhoneDisplay).join(", ")
                    await SmsMessage.create({
                        recipientName: creator?.name || "Admin",
                        recipientPhone: display,
                        recipientKind: "individual",
                        message: branded,
                        messageLength: branded.length,
                        status: arkesel.ok ? "sent" : "failed",
                        costGHS: arkesel.ok ? costPer : 0,
                        errorMessage: arkesel.ok ? "" : (arkesel.error || "Send failed"),
                        arkeselRaw: arkesel.data || null,
                        client: client?._id || null,
                        folder: null,
                        booking: b._id,
                        recipientType: "admin",
                        trigger: "booking_reminder_admin",
                        createdBy: b.createdBy?._id || undefined,
                    })
                    if (arkesel.ok) {
                        await Booking.updateOne(
                            { _id: b._id },
                            { $set: { reminderAdminSentAt: new Date() } }
                        )
                    }
                }
            }
        }
    }
}

/**
 * Schedules {@link runBookingReminders}. Default cron is hourly so the ~24h window is hit for any shoot time.
 * Use BOOKING_REMINDER_TIMEZONE (default Africa/Accra). A once-daily cron (e.g. 8:00) cannot align with true 24h-before for all start times.
 */
export function startBookingReminderCron() {
    if (!envFlag("BOOKING_REMINDER_ENABLED", true)) {
        console.log("[booking-reminder] disabled (BOOKING_REMINDER_ENABLED=false)")
        return
    }

    const tz = process.env.BOOKING_REMINDER_TIMEZONE?.trim() || "Africa/Accra"
    const pattern =
        process.env.BOOKING_REMINDER_CRON?.trim() || "0 * * * *"

    if (!cron.validate(pattern)) {
        console.warn(
            `[booking-reminder] invalid BOOKING_REMINDER_CRON=${JSON.stringify(pattern)}; not scheduled`
        )
        return
    }

    cron.schedule(
        pattern,
        () => {
            runBookingReminders().catch((err) => {
                console.error("[booking-reminder] run failed:", err)
            })
        },
        { timezone: tz }
    )

    console.log(
        `[booking-reminder] scheduled cron=${JSON.stringify(pattern)} tz=${JSON.stringify(tz)}`
    )
}
