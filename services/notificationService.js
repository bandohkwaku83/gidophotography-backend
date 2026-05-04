import mongoose from "mongoose"
import User from "../models/User.js"
import Folder from "../models/Folder.js"
import Notification from "../models/Notification.js"

async function adminRecipientIds() {
    const rows = await User.find({ role: "admin" }).select("_id").lean()
    return rows.map((r) => r._id)
}

function shareLinkLabel(folder) {
    const slug = folder?.share?.slug
    if (slug) return String(slug)
    if (folder?.share?.code) return String(folder.share.code)
    return ""
}

/**
 * Notify every admin user about gallery selection activity (fire-and-forget).
 * @param {object} opts
 * @param {'selection_add'|'selection_remove'|'selection_sync'|'selection_submit'} opts.type
 * @param {import('mongoose').Types.ObjectId|string} opts.folderId
 * @param {string} [opts.shareIdentifier] slug or code from public share URL
 * @param {object} [opts.detail] optional counts for sync
 */
export async function notifyAdminsOfFolderSelection(opts) {
    try {
        const { type, folderId, shareIdentifier = "", detail = {} } = opts
        if (!folderId || !mongoose.Types.ObjectId.isValid(String(folderId))) {
            return
        }

        const [recipients, folder] = await Promise.all([
            adminRecipientIds(),
            Folder.findById(folderId)
                .populate("client", "name")
                .select("eventName client share")
                .lean(),
        ])

        if (!recipients.length || !folder) return

        const clientName = folder.client?.name?.trim() || "Client"
        const event = folder.eventName?.trim() || "Gallery"
        const ident =
            shareIdentifier ||
            shareLinkLabel(folder) ||
            String(folder._id)

        let title = "Gallery activity"
        let body = ""

        switch (type) {
            case "selection_add":
                title = "New client selection"
                body = `${clientName} added a photo to their picks in “${event}”.`
                break
            case "selection_remove":
                title = "Client updated selection"
                body = `${clientName} removed a photo from their picks in “${event}”.`
                break
            case "selection_sync":
                title = "Client updated selections"
                body = `${clientName} synced their picks in “${event}” (${detail.added ?? 0} added, ${detail.removed ?? 0} removed).`
                break
            case "selection_submit":
                title = "Selection submitted"
                body = `${clientName} submitted their photo choices for “${event}”.`
                break
            default:
                body = `Activity in “${event}”.`
        }

        const fid = new mongoose.Types.ObjectId(String(folderId))
        const docs = recipients.map((recipient) => ({
            recipient,
            type,
            title,
            body,
            folder: fid,
            booking: null,
            shareIdentifier: ident,
        }))

        await Notification.insertMany(docs)
    } catch (err) {
        console.error("[notifications] notifyAdminsOfFolderSelection:", err)
    }
}

/**
 * One in-app reminder per admin for an upcoming booking (cron / booking reminders).
 */
export async function notifyAdminsOfBookingReminder({
    bookingId,
    title,
    body,
}) {
    try {
        if (!bookingId || !mongoose.Types.ObjectId.isValid(String(bookingId))) {
            return
        }
        const recipients = await adminRecipientIds()
        if (!recipients.length) return

        const bid = new mongoose.Types.ObjectId(String(bookingId))
        const docs = recipients.map((recipient) => ({
            recipient,
            type: "booking_reminder_admin",
            title: title || "Booking reminder",
            body: body || "",
            folder: null,
            booking: bid,
            shareIdentifier: "",
        }))

        await Notification.insertMany(docs)
    } catch (err) {
        console.error("[notifications] notifyAdminsOfBookingReminder:", err)
    }
}
