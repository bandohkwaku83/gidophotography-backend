import mongoose from "mongoose"
import FolderMedia from "../models/FolderMedia.js"
import { folderMediaSetMatch } from "./folderSetQuery.js"

const ACTIVE_MEDIA_MATCH = { deletedAt: null }
const REORDERABLE_KINDS = ["raw", "final"]

function bucketKey(folderId, setId, kind) {
    return `${String(folderId)}:${setId == null ? "null" : String(setId)}:${kind}`
}

function mediaBucketMatch(folderId, kind, setId) {
    return {
        folder: folderId,
        kind,
        ...ACTIVE_MEDIA_MATCH,
        ...folderMediaSetMatch(setId),
    }
}

/** Highest sortOrder in a folder / set / kind bucket, or -1 when empty. */
export async function getMaxSortOrder(folderId, kind, setId) {
    const max = await FolderMedia.findOne(mediaBucketMatch(folderId, kind, setId))
        .sort({ sortOrder: -1, createdAt: -1 })
        .select("sortOrder")
        .lean()
    return Number.isFinite(max?.sortOrder) ? max.sortOrder : -1
}

/** Next sortOrder values for `count` new rows (append at end of bucket). */
export async function allocateSortOrders(folderId, kind, setId, count) {
    if (count <= 0) return []
    const start = (await getMaxSortOrder(folderId, kind, setId)) + 1
    return Array.from({ length: count }, (_, i) => start + i)
}

/**
 * Assign sequential sortOrder at the end of the target bucket (General when setId is null).
 * Used when media moves between sets (e.g. set delete → General).
 */
export async function appendMediaToSetBucketEnd(folderId, fromSetId, toSetId, kinds = REORDERABLE_KINDS) {
    for (const kind of kinds) {
        const docs = await FolderMedia.find({
            folder: folderId,
            kind,
            set: fromSetId,
            ...ACTIVE_MEDIA_MATCH,
        })
            .sort({ sortOrder: 1, createdAt: 1 })
            .select("_id")

        if (!docs.length) continue

        let next = (await getMaxSortOrder(folderId, kind, toSetId)) + 1
        const bulk = docs.map((doc) => ({
            updateOne: {
                filter: { _id: doc._id },
                update: {
                    $set: {
                        set: toSetId,
                        sortOrder: next++,
                    },
                },
            },
        }))
        await FolderMedia.bulkWrite(bulk)
    }
}

/**
 * One-time style backfill: within each (folder, set, kind) bucket that still has rows
 * without sortOrder, assign 0..n-1 by createdAt so existing galleries keep stable order.
 */
export async function backfillMediaSortOrders() {
    const rows = await FolderMedia.find({
        kind: { $in: REORDERABLE_KINDS },
    })
        .select("_id folder set kind sortOrder createdAt")
        .lean()

    const buckets = new Map()
    for (const row of rows) {
        const key = bucketKey(row.folder, row.set ?? null, row.kind)
        if (!buckets.has(key)) buckets.set(key, [])
        buckets.get(key).push(row)
    }

    let updated = 0
    for (const items of buckets.values()) {
        const needsBackfill = items.some(
            (item) => item.sortOrder == null || item.sortOrder === undefined
        )
        if (!needsBackfill) continue

        items.sort(
            (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        )

        const bulk = items.map((item, idx) => ({
            updateOne: {
                filter: { _id: item._id },
                update: { $set: { sortOrder: idx } },
            },
        }))
        if (bulk.length) {
            await FolderMedia.bulkWrite(bulk)
            updated += bulk.length
        }
    }

    if (updated > 0) {
        console.log(`[media-sort] Backfilled sortOrder on ${updated} media row(s)`)
    }
}

/**
 * Apply a full ordered id list for one bucket. Returns { updatedCount } or throws with `.status` / `.message`.
 */
export async function reorderFolderMediaBucket(folderId, kind, setId, orderedIds) {
    if (!REORDERABLE_KINDS.includes(kind)) {
        const err = new Error('kind must be "raw" or "final"')
        err.status = 400
        throw err
    }
    if (!Array.isArray(orderedIds)) {
        const err = new Error("orderedIds must be an array")
        err.status = 400
        throw err
    }
    if (orderedIds.length > 5000) {
        const err = new Error("Too many ids (max 5000)")
        err.status = 400
        throw err
    }

    const normalized = orderedIds.map((id) => String(id).trim())
    for (const id of normalized) {
        if (!mongoose.Types.ObjectId.isValid(id)) {
            const err = new Error(`Invalid media id: ${id}`)
            err.status = 400
            throw err
        }
    }
    const unique = [...new Set(normalized)]
    if (unique.length !== normalized.length) {
        const err = new Error("orderedIds must not contain duplicates")
        err.status = 400
        throw err
    }

    const existing = await FolderMedia.find(mediaBucketMatch(folderId, kind, setId))
        .select("_id")
        .lean()
    const existingIds = new Set(existing.map((d) => String(d._id)))

    if (unique.length !== existingIds.size) {
        const err = new Error(
            "orderedIds must include every active item in this collection exactly once"
        )
        err.status = 400
        throw err
    }
    for (const id of unique) {
        if (!existingIds.has(id)) {
            const err = new Error(
                "One or more ids do not belong to this folder, set, or media kind"
            )
            err.status = 400
            throw err
        }
    }

    const bulk = unique.map((id, idx) => ({
        updateOne: {
            filter: { _id: id, folder: folderId, kind },
            update: { $set: { sortOrder: idx } },
        },
    }))
    await FolderMedia.bulkWrite(bulk)

    return { updatedCount: unique.length }
}
