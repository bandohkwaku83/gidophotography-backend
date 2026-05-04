import mongoose from "mongoose"
import Notification from "../models/Notification.js"

const parseLimit = (raw, fallback = 30, max = 100) => {
    const n = parseInt(String(raw ?? "").trim(), 10)
    if (!Number.isFinite(n) || n < 1) return fallback
    return Math.min(n, max)
}

const parseSkip = (raw) => {
    const n = parseInt(String(raw ?? "").trim(), 10)
    if (!Number.isFinite(n) || n < 0) return 0
    return Math.min(n, 10_000)
}

const serializeNotification = (doc) => ({
    _id: doc._id,
    type: doc.type,
    title: doc.title,
    body: doc.body,
    readAt: doc.readAt,
    folder: doc.folder,
    booking: doc.booking,
    shareIdentifier: doc.shareIdentifier || "",
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
})

export const listNotifications = async (req, res) => {
    try {
        const limit = parseLimit(req.query.limit, 30, 100)
        const skip = parseSkip(req.query.skip)
        const unreadOnly =
            req.query.unreadOnly === "true" ||
            req.query.unreadOnly === "1" ||
            req.query.unreadOnly === true

        const filter = { recipient: req.user._id }
        if (unreadOnly) filter.readAt = null

        const [items, total, unreadCount] = await Promise.all([
            Notification.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .lean(),
            Notification.countDocuments(filter),
            Notification.countDocuments({
                recipient: req.user._id,
                readAt: null,
            }),
        ])

        return res.status(200).json({
            notifications: items.map(serializeNotification),
            count: items.length,
            total,
            unreadCount,
            skip,
            limit,
        })
    } catch (error) {
        console.error("List notifications error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getUnreadNotificationCount = async (req, res) => {
    try {
        const unreadCount = await Notification.countDocuments({
            recipient: req.user._id,
            readAt: null,
        })
        return res.status(200).json({ unreadCount })
    } catch (error) {
        console.error("Unread notification count error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const markNotificationRead = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid notification id" })
        }

        const doc = await Notification.findOneAndUpdate(
            { _id: id, recipient: req.user._id },
            { $set: { readAt: new Date() } },
            { new: true }
        ).lean()

        if (!doc) {
            return res.status(404).json({ message: "Notification not found" })
        }

        return res.status(200).json({
            message: "Marked as read",
            notification: serializeNotification(doc),
        })
    } catch (error) {
        console.error("Mark notification read error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const markAllNotificationsRead = async (req, res) => {
    try {
        const result = await Notification.updateMany(
            { recipient: req.user._id, readAt: null },
            { $set: { readAt: new Date() } }
        )

        return res.status(200).json({
            message: "All notifications marked as read",
            modifiedCount: result.modifiedCount,
        })
    } catch (error) {
        console.error("Mark all notifications read error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
