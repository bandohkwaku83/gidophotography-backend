import mongoose from "mongoose"
import Folder from "../models/Folder.js"
import FolderSet from "../models/FolderSet.js"
import FolderMedia from "../models/FolderMedia.js"
import { appendMediaToSetBucketEnd } from "../utils/mediaSortOrder.js"
import { galleryCollectionFieldsFromFolder } from "../utils/galleryCollections.js"
import { getFolderMediaCollections, loadActiveSharedFolder } from "./folderMediaController.js"
import {
    accessCodesMatch,
    clearUnlockFailures,
    generateAccessCode,
    mergeUnlockedSets,
    normalizeAccessCodeVersion,
    readRequestCookie,
    recordUnlockFailure,
    SET_ACCESS_COOKIE,
    decodeSetAccessToken,
    setAccessCookieOptions,
    setAccessTtlSeconds,
    signSetAccessToken,
    unlockAttemptLimited,
    unlockFailureKey,
} from "../utils/collectionLock.js"

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

function optionalBoolean(body, key) {
    if (body == null || !Object.prototype.hasOwnProperty.call(body, key)) {
        return { ok: true, present: false }
    }
    if (typeof body[key] !== "boolean") {
        return { ok: false, message: `${key} must be a boolean` }
    }
    return { ok: true, present: true, value: body[key] }
}

function ensureAccessCode(set) {
    if (!set.accessCode) {
        set.accessCode = generateAccessCode()
        set.accessCodeVersion = 1
        return
    }
    set.accessCodeVersion = normalizeAccessCodeVersion(set.accessCodeVersion)
}

/** Keep an existing code, or create one the first time the set is locked. */
function lockSet(set) {
    ensureAccessCode(set)
    set.locked = true
}

function unlockSet(set) {
    set.locked = false
}

/** New code, lock the set, and invalidate unlock cookies for the previous code. */
function regenerateSetAccessCode(set) {
    const current = normalizeAccessCodeVersion(set.accessCodeVersion)
    set.accessCode = generateAccessCode()
    set.accessCodeVersion = current + 1
    set.locked = true
}

async function buildSetsPayload(folderId, { audience = "studio", unlockedSetIds = null } = {}) {
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

    const unlocked =
        unlockedSetIds instanceof Set
            ? unlockedSetIds
            : new Set(unlockedSetIds || [])

    const serialized = sets.map((s) => {
        const rawCount = rawCountBySet.get(String(s._id)) ?? 0
        const selectionCount = selectionCountBySet.get(String(s._id)) ?? 0
        const finalCount = finalCountBySet.get(String(s._id)) ?? 0
        const locked = Boolean(s.locked)
        const row = {
            _id: s._id,
            name: s.name,
            sortOrder: s.sortOrder ?? 0,
            locked,
            rawCount,
            selectionCount,
            finalCount,
            mediaCount: rawCount + selectionCount + finalCount,
            createdAt: s.createdAt,
            updatedAt: s.updatedAt,
        }
        if (audience === "public") {
            row.unlocked = !locked || unlocked.has(String(s._id))
        } else {
            row.accessCode = s.accessCode || null
        }
        return row
    })

    let totalRaw = generalRawCount + serialized.reduce((n, x) => n + x.rawCount, 0)
    let totalSelection =
        generalSelectionCount + serialized.reduce((n, x) => n + x.selectionCount, 0)
    let totalFinal = generalFinalCount + serialized.reduce((n, x) => n + x.finalCount, 0)

    if (audience === "public") {
        for (const row of serialized) {
            if (row.locked && !row.unlocked) {
                totalRaw -= row.rawCount
                totalSelection -= row.selectionCount
                totalFinal -= row.finalCount
            }
        }
    }

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

export async function listFolderSetsForFolder(folderId, options) {
    return buildSetsPayload(folderId, options)
}

function setRowFromPayload(payload, setId) {
    return payload.sets.find((s) => String(s._id) === String(setId)) ?? null
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

        const lockedField = optionalBoolean(req.body, "locked")
        if (!lockedField.ok) {
            return res.status(400).json({ message: lockedField.message })
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

        const docFields = {
            folder: id,
            name,
            sortOrder: (maxOrder?.sortOrder ?? -1) + 1,
            locked: false,
            accessCode: null,
            accessCodeVersion: 1,
        }
        if (lockedField.value === true) {
            docFields.locked = true
            docFields.accessCode = generateAccessCode()
            docFields.accessCodeVersion = 1
        }

        const doc = await FolderSet.create(docFields)

        const payload = await buildSetsPayload(id)
        const set = setRowFromPayload(payload, doc._id)
        if (!set || (set.locked && !set.accessCode)) {
            return res.status(500).json({ message: "Server error" })
        }
        return res.status(201).json({
            message: "Set created",
            set,
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

        const lockedField = optionalBoolean(req.body, "locked")
        if (!lockedField.ok) {
            return res.status(400).json({ message: lockedField.message })
        }
        const regenerateField = optionalBoolean(req.body, "regenerateAccessCode")
        if (!regenerateField.ok) {
            return res.status(400).json({ message: regenerateField.message })
        }

        if (regenerateField.value === true) {
            regenerateSetAccessCode(set)
        } else if (lockedField.present) {
            if (lockedField.value) lockSet(set)
            else unlockSet(set)
        }

        await set.save()
        const payload = await buildSetsPayload(id)
        const setRow = setRowFromPayload(payload, set._id)
        if (!setRow || (setRow.locked && !setRow.accessCode)) {
            return res.status(500).json({ message: "Server error" })
        }
        return res.status(200).json({
            message: "Set updated",
            set: setRow,
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

        await appendMediaToSetBucketEnd(id, setId, null)
        await FolderMedia.updateMany(
            { folder: id, set: setId, kind: "selection", ...ACTIVE_MEDIA_MATCH },
            { $set: { set: null } }
        )

        const payload = await buildSetsPayload(id)
        return res.status(200).json({
            message:
                "Set deleted. Its uploads were moved to General at the end of each collection.",
            ...payload,
        })
    } catch (error) {
        console.error("Delete folder set error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const reorderFolderSets = async (req, res) => {
    try {
        const { id } = req.params
        const check = await assertFolder(id)
        if (check.error) {
            return res.status(check.error.status).json({ message: check.error.message })
        }
        const { folder } = check

        const orderedKeys = req.body?.orderedKeys
        if (!Array.isArray(orderedKeys) || orderedKeys.length === 0) {
            return res.status(400).json({
                message: "orderedKeys must be a non-empty array",
            })
        }

        const normalized = orderedKeys.map((k) => String(k).trim())
        const unique = new Set(normalized)
        if (unique.size !== normalized.length) {
            return res.status(400).json({ message: "orderedKeys must not contain duplicates" })
        }

        const generalCount = normalized.filter((k) => k === "general").length
        if (generalCount !== 1) {
            return res.status(400).json({
                message: 'orderedKeys must include exactly one "general" entry',
            })
        }

        const setKeys = normalized.filter((k) => k !== "general")
        for (const key of setKeys) {
            if (!mongoose.Types.ObjectId.isValid(key)) {
                return res.status(400).json({ message: `Invalid set id: ${key}` })
            }
        }

        const activeSets = await FolderSet.find({ folder: id, deletedAt: null }).select(
            "_id"
        )
        const activeSetIds = new Set(activeSets.map((s) => String(s._id)))

        if (setKeys.length !== activeSetIds.size) {
            return res.status(400).json({
                message:
                    "orderedKeys must list every named collection on this folder plus general exactly once",
            })
        }
        for (const key of setKeys) {
            if (!activeSetIds.has(key)) {
                return res.status(400).json({
                    message: "One or more set ids do not belong to this folder",
                })
            }
        }

        const setBulk = []
        for (let i = 0; i < normalized.length; i++) {
            const key = normalized[i]
            if (key === "general") {
                folder.generalSetSortOrder = i
            } else {
                setBulk.push({
                    updateOne: {
                        filter: { _id: key, folder: id, deletedAt: null },
                        update: { $set: { sortOrder: i } },
                    },
                })
            }
        }

        await folder.save()
        if (setBulk.length) {
            await FolderSet.bulkWrite(setBulk)
        }

        const setsPayload = await buildSetsPayload(id)
        const media = await getFolderMediaCollections(req, id, {
            galleryConfig: galleryCollectionFieldsFromFolder(folder),
        })

        return res.status(200).json({
            message: "Collection order updated",
            updatedCount: normalized.length,
            generalSetSortOrder: folder.generalSetSortOrder,
            ...galleryCollectionFieldsFromFolder(folder),
            sets: setsPayload.sets,
            uploadsBySet: media.uploadsBySet,
            finalsBySet: media.finalsBySet,
            selectionBySet: media.selectionBySet,
        })
    } catch (error) {
        console.error("Reorder folder sets error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const unlockSharedFolderSet = async (req, res) => {
    try {
        const { identifier, setId } = req.params
        if (!mongoose.Types.ObjectId.isValid(setId)) {
            return res.status(400).json({ message: "Invalid set id" })
        }

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res.status(loaded.error.status).json({ message: loaded.error.message })
        }
        const { folder } = loaded

        const set = await FolderSet.findOne({
            _id: setId,
            folder: folder._id,
            deletedAt: null,
        })
        if (!set) {
            return res.status(404).json({ message: "Set not found" })
        }
        if (!set.locked) {
            return res.status(400).json({ message: "This collection is not locked." })
        }

        const limitKey = unlockFailureKey(req, identifier, setId)
        const limited = unlockAttemptLimited(limitKey)
        if (limited.limited) {
            res.set("Retry-After", String(limited.retryAfterSec))
            return res.status(429).json({ message: "Too many attempts. Try again later." })
        }

        const provided = typeof req.body?.code === "string" ? req.body.code : ""
        const stored = set.accessCode || ""
        if (!stored || !accessCodesMatch(provided, stored)) {
            recordUnlockFailure(limitKey)
            return res.status(401).json({ message: "Invalid code" })
        }

        clearUnlockFailures(limitKey)

        const activeSets = await FolderSet.find({
            folder: folder._id,
            deletedAt: null,
        })
            .select("_id locked accessCodeVersion")
            .lean()
        const previous = decodeSetAccessToken(
            readRequestCookie(req, SET_ACCESS_COOKIE),
            identifier
        )
        const sets = mergeUnlockedSets(previous?.sets, activeSets, set)
        const ttlSec = setAccessTtlSeconds(folder)
        const token = signSetAccessToken(identifier, sets, ttlSec)

        res.cookie(SET_ACCESS_COOKIE, token, setAccessCookieOptions(identifier, ttlSec))
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({
            unlocked: true,
            setId: String(set._id),
        })
    } catch (error) {
        console.error("Unlock shared folder set error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
