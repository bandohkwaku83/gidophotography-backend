import path from "path"

/** Escape a string for safe use inside a RegExp source (basename only). */
export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Find existing folder media with the same original basename (case-insensitive).
 * Matches "IMG.jpg", "img.JPG", and "album/IMG.jpg" when basename matches.
 */
export async function findDuplicateFolderMedia(
    FolderMedia,
    folderId,
    kind,
    originalFilename
) {
    const bn = path.basename(String(originalFilename || "").trim() || "file")
    const regex = new RegExp(`(^|[\\\\/])${escapeRegex(bn)}$`, "i")
    return FolderMedia.findOne({
        folder: folderId,
        kind,
        deletedAt: null,
        originalFilename: regex,
    })
}

/** Same basename rule as duplicate checks: trim, default "file", case-insensitive key. */
export function basenameDuplicateKey(originalFilename) {
    return path
        .basename(String(originalFilename || "").trim() || "file")
        .toLowerCase()
}

/**
 * One DB round-trip for all folder media of a kind; O(1) duplicate lookups while uploading.
 * Values are live Mongoose docs (last wins if duplicate basenames exist in DB).
 */
export async function loadFolderMediaByBasenameMap(FolderMedia, folderId, kind) {
    const docs = await FolderMedia.find({
        folder: folderId,
        kind,
        deletedAt: null,
    }).sort({
        createdAt: 1,
    })
    const map = new Map()
    for (const doc of docs) {
        const k = basenameDuplicateKey(doc.originalFilename)
        if (k) map.set(k, doc)
    }
    return map
}

/** Max basenames processed in one duplicate-preview call (avoids huge payloads / timeouts). */
export const DUPLICATE_PREVIEW_MAX_FILENAMES = 5000

const OR_CHUNK = 80

/**
 * Batch duplicate check for JSON preview (one or a few DB round-trips instead of N findOne calls).
 * @returns {{ conflicts: Array<{ originalFilename: string, basename: string, existingMediaId: unknown }>, truncated: boolean }}
 */
export async function findDuplicateFolderMediaBatch(
    FolderMedia,
    folderId,
    kind,
    filenames
) {
    const list = Array.isArray(filenames) ? filenames : []
    const truncated = list.length > DUPLICATE_PREVIEW_MAX_FILENAMES
    const capped = list.slice(0, DUPLICATE_PREVIEW_MAX_FILENAMES)

    const uniqueByLower = new Map()
    for (const rawName of capped) {
        if (rawName == null) continue
        const name = String(rawName).trim()
        if (!name) continue
        const bn = path.basename(name)
        const dedupeKey = bn.toLowerCase()
        if (!uniqueByLower.has(dedupeKey)) {
            uniqueByLower.set(dedupeKey, { displayName: name, bn })
        }
    }

    if (uniqueByLower.size === 0) {
        return { conflicts: [], truncated }
    }

    const keys = [...uniqueByLower.keys()]
    const chunks = []
    for (let i = 0; i < keys.length; i += OR_CHUNK) {
        chunks.push(keys.slice(i, i + OR_CHUNK))
    }

    const existingByLower = new Map()
    const chunkResults = await Promise.all(
        chunks.map((keyChunk) => {
            const $or = keyChunk.map((dedupeKey) => {
                const { bn } = uniqueByLower.get(dedupeKey)
                return {
                    originalFilename: new RegExp(
                        `(^|[\\\\/])${escapeRegex(bn)}$`,
                        "i"
                    ),
                }
            })
            return FolderMedia.find({
                folder: folderId,
                kind,
                deletedAt: null,
                $or,
            })
                .select("_id originalFilename")
                .lean()
        })
    )

    for (const docs of chunkResults) {
        for (const doc of docs) {
            const key = path.basename(doc.originalFilename || "").toLowerCase()
            if (key && !existingByLower.has(key)) {
                existingByLower.set(key, {
                    _id: doc._id,
                    originalFilename: doc.originalFilename,
                })
            }
        }
    }

    const conflicts = []
    for (const [dedupeKey, { displayName, bn }] of uniqueByLower) {
        if (existingByLower.has(dedupeKey)) {
            const ex = existingByLower.get(dedupeKey)
            conflicts.push({
                originalFilename: displayName,
                basename: bn,
                existingMediaId: ex._id,
            })
        }
    }

    return { conflicts, truncated }
}
