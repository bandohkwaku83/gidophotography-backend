import Client from "../models/Client.js"
import Folder from "../models/Folder.js"
import { buildPublicUrl } from "./folderMediaController.js"
import { normalizeFolderStatus } from "../constants/folderStatus.js"

const parseLimit = (raw, fallback, { min = 1, max = 50 } = {}) => {
    const n = parseInt(raw, 10)
    if (Number.isNaN(n)) return fallback
    return Math.min(Math.max(n, min), max)
}

/**
 * Single payload for the studio dashboard: KPIs, recent galleries, activity feed.
 * Query: recentLimit (default 8), activityLimit (default 15)
 */
export const getDashboard = async (req, res) => {
    try {
        const recentLimit = parseLimit(req.query.recentLimit, 8)
        const activityLimit = parseLimit(req.query.activityLimit, 15)

        const [
            totalClients,
            totalGalleries,
            completedGalleries,
        ] = await Promise.all([
            Client.countDocuments(),
            Folder.countDocuments(),
            Folder.countDocuments({
                status: { $in: ["delivered", "completed"] },
            }),
        ])

        const inProgressGalleries = Math.max(0, totalGalleries - completedGalleries)

        const recentFolders = await Folder.find()
            .populate("client", "name")
            .sort({ updatedAt: -1 })
            .limit(recentLimit)
            .lean()

        const recentGalleries = recentFolders.map((f) => ({
            id: f._id,
            title: f.eventName,
            clientName: f.client?.name?.trim() || "Unknown client",
            coverImageUrl: buildPublicUrl(req, f.coverImage),
            status: normalizeFolderStatus(f.status),
            updatedAt: f.updatedAt,
            createdAt: f.createdAt,
        }))

        const [folderRows, clientRows] = await Promise.all([
            Folder.find()
                .select("eventName createdAt updatedAt")
                .sort({ updatedAt: -1 })
                .limit(30)
                .lean(),
            Client.find()
                .select("name createdAt updatedAt")
                .sort({ updatedAt: -1 })
                .limit(30)
                .lean(),
        ])

        const activities = []

        for (const f of folderRows) {
            const created = new Date(f.createdAt).getTime()
            const updated = new Date(f.updatedAt).getTime()
            const isCreate = Math.abs(updated - created) < 3000
            activities.push({
                action: isCreate ? "Created" : "Updated",
                targetType: "gallery",
                targetName: f.eventName,
                galleryId: f._id,
                at: f.updatedAt,
            })
        }

        for (const c of clientRows) {
            const created = new Date(c.createdAt).getTime()
            const updated = new Date(c.updatedAt).getTime()
            const isCreate = Math.abs(updated - created) < 3000
            activities.push({
                action: isCreate ? "Created" : "Updated",
                targetType: "client",
                targetName: c.name,
                clientId: c._id,
                at: c.updatedAt,
            })
        }

        activities.sort(
            (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()
        )

        return res.status(200).json({
            user: {
                _id: req.user._id,
                name: req.user.name || "",
                email: req.user.email,
            },
            serverDate: new Date().toISOString(),
            stats: {
                totalClients,
                totalGalleries,
                inProgressGalleries,
                completedGalleries,
            },
            recentGalleries,
            activity: activities.slice(0, activityLimit),
        })
    } catch (error) {
        console.error("Dashboard error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
