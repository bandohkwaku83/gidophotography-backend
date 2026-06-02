import mongoose from "mongoose"
import Folder from "../models/Folder.js"
import FolderSet from "../models/FolderSet.js"
import FolderMedia from "../models/FolderMedia.js"

const ACTIVE_MEDIA_MATCH = { deletedAt: null }

async function assertFolder(folderId) {
    if (!mongoose.Types.ObjectId.isValid(folderId)) {
        return { error: { status: 400, message: "Invalid folder id" } }
    }
    const folder = await Folder.findOne({ _id: folderId, deletedAt: null })
    if (!folder) {
        return { error: { status: 404, message: "Folder not found" } }
    }
    return { folder }
}

async function buildSetsPayload(folderId) {
    const sets = await FolderSet.find({
        folder: folderId,
        deletedAt: null,
    })
        .sort({ sortOrder: 1, createdAt: 1 })
        .lean()

    const counts = await FolderMedia.aggregate([
        {
            $match: {
                folder: new mongoose.Types.ObjectId(folderId),
                ...ACTIVE_MEDIA_MATCH,
            },
        },
        {
            $group: {
                _id: { set: "$set", kind: "$kind" },
                count: { $sum: 1 },
            },
        },
    ])

    const rawCountBySet = new Map()
    const selectionCountBySet = new Map()
    const finalCountBySet = new Map()
    const bucketForKind = (kind) => {
        if (kind === "selection") return selectionCountBySet
        if (kind === "final") return finalCountBySet
        return rawCountBySet
    }
    let generalRawCount = 0
    let generalSelectionCount = 0
    let generalFinalCount = 0
    for (const row of counts) {
        const id = row?._id?.set ?? null
        const kind = row?._id?.kind || "raw"
        const bucket = bucketForKind(kind)
        if (id == null) {
            if (kind === "selection") generalSelectionCount += row.count
            else if (kind === "final") generalFinalCount += row.count
            else generalRawCount += row.count
        } else {
            bucket.set(String(id), row.count)
        }
    }

    const serialized = sets.map((s) => ({
        _id: s._id,
        name: s.name,
        sortOrder: s.sortOrder ?? 0,
        rawCount: rawCountBySet.get(String(s._id)) ?? 0,
        selectionCount: selectionCountBySet.get(String(s._id)) ?? 0,
        finalCount: finalCountBySet.get(String(s._id)) ?? 0,
        mediaCount:
            (rawCountBySet.get(String(s._id)) ?? 0) +
            (selectionCountBySet.get(String(s._id)) ?? 0) +
            (finalCountBySet.get(String(s._id)) ?? 0),
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
    }))

    const totalRaw = generalRawCount + serialized.reduce((n, x) => n + x.rawCount, 0)
    const totalSelection =
        generalSelectionCount + serialized.reduce((n, x) => n + x.selectionCount, 0)
    const totalFinal = generalFinalCount + serialized.reduce((n, x) => n + x.finalCount, 0)

    return {
        sets: serialized,
        generalRawCount,
        generalSelectionCount,
        generalFinalCount,
        generalMediaCount:
            generalRawCount + generalSelectionCount + generalFinalCount,
        totalRawMediaCount: totalRaw,
        totalSelectionCount: totalSelection,
        totalFinalCount: totalFinal,
        totalMediaCount: totalRaw + totalSelection + totalFinal,
    }
}

export async function listFolderSetsForFolder(folderId) {
    return buildSetsPayload(folderId)
}

export const listFolderSets = async (req, res) => {
    try {
        const { id } = req.params
        const check = await assertFolder(id)
        if (check.error) {
            return res.status(check.error.status).json({ message: check.error.message })
        }
        const payload = await buildSetsPayload(id)
        return res.status(200).json({ folderId: id, ...payload })
    } catch (error) {
        console.error("List folder sets error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const createFolderSet = async (req, res) => {
    try {
        const { id } = req.params
        const check = await assertFolder(id)
        if (check.error) {
            return res.status(check.error.status).json({ message: check.error.message })
        }

        const name = String(req.body?.name ?? "").trim()
        if (!name) {
            return res.status(400).json({ message: "Set name is required." })
        }
        if (name.length > 120) {
            return res.status(400).json({ message: "Set name must be 120 characters or fewer." })
        }

        const existing = await FolderSet.findOne({
            folder: id,
            deletedAt: null,
            name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
        })
        if (existing) {
            return res.status(409).json({ message: "A set with this name already exists." })
        }

        const maxOrder = await FolderSet.findOne({
            folder: id,
            deletedAt: null,
        })
            .sort({ sortOrder: -1 })
            .select("sortOrder")
            .lean()

        const doc = await FolderSet.create({
            folder: id,
            name,
            sortOrder: (maxOrder?.sortOrder ?? -1) + 1,
        })

        const payload = await buildSetsPayload(id)
        return res.status(201).json({
            message: "Set created",
            set: {
                _id: doc._id,
                name: doc.name,
                sortOrder: doc.sortOrder,
                rawCount: 0,
                selectionCount: 0,
                finalCount: 0,
                mediaCount: 0,
                createdAt: doc.createdAt,
                updatedAt: doc.updatedAt,
            },
            ...payload,
        })
    } catch (error) {
        console.error("Create folder set error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const updateFolderSet = async (req, res) => {
    try {
        const { id, setId } = req.params
        const check = await assertFolder(id)
        if (check.error) {
            return res.status(check.error.status).json({ message: check.error.message })
        }
        if (!mongoose.Types.ObjectId.isValid(setId)) {
            return res.status(400).json({ message: "Invalid set id" })
        }

        const set = await FolderSet.findOne({
            _id: setId,
            folder: id,
            deletedAt: null,
        })
        if (!set) {
            return res.status(404).json({ message: "Set not found" })
        }

        const name = req.body?.name != null ? String(req.body.name).trim() : undefined
        if (name !== undefined) {
            if (!name) {
                return res.status(400).json({ message: "Set name cannot be empty." })
            }
            if (name.length > 120) {
                return res.status(400).json({ message: "Set name must be 120 characters or fewer." })
            }
            const clash = await FolderSet.findOne({
                folder: id,
                deletedAt: null,
                _id: { $ne: setId },
                name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
            })
            if (clash) {
                return res.status(409).json({ message: "A set with this name already exists." })
            }
            set.name = name
        }

        if (req.body?.sortOrder != null) {
            const n = Number(req.body.sortOrder)
            if (Number.isFinite(n)) set.sortOrder = Math.floor(n)
        }

        await set.save()
        const payload = await buildSetsPayload(id)
        return res.status(200).json({
            message: "Set updated",
            set: {
                _id: set._id,
                name: set.name,
                sortOrder: set.sortOrder,
                rawCount:
                    payload.sets.find((s) => String(s._id) === String(set._id))?.rawCount ?? 0,
                selectionCount:
                    payload.sets.find((s) => String(s._id) === String(set._id))
                        ?.selectionCount ?? 0,
                finalCount:
                    payload.sets.find((s) => String(s._id) === String(set._id))?.finalCount ?? 0,
                mediaCount:
                    payload.sets.find((s) => String(s._id) === String(set._id))?.mediaCount ?? 0,
                createdAt: set.createdAt,
                updatedAt: set.updatedAt,
            },
            ...payload,
        })
    } catch (error) {
        console.error("Update folder set error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteFolderSet = async (req, res) => {
    try {
        const { id, setId } = req.params
        const check = await assertFolder(id)
        if (check.error) {
            return res.status(check.error.status).json({ message: check.error.message })
        }
        if (!mongoose.Types.ObjectId.isValid(setId)) {
            return res.status(400).json({ message: "Invalid set id" })
        }

        const set = await FolderSet.findOne({
            _id: setId,
            folder: id,
            deletedAt: null,
        })
        if (!set) {
            return res.status(404).json({ message: "Set not found" })
        }

        const now = new Date()
        set.deletedAt = now
        await set.save()

        await FolderMedia.updateMany(
            { folder: id, set: setId, ...ACTIVE_MEDIA_MATCH },
            { $set: { set: null } }
        )

        const payload = await buildSetsPayload(id)
        return res.status(200).json({
            message: "Set deleted. Its uploads were moved to General.",
            ...payload,
        })
    } catch (error) {
        console.error("Delete folder set error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
