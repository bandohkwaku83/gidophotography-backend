import mongoose from "mongoose"

/**
 * Normalize set id from multipart / JSON body.
 * @returns {null | string} null = uncategorized; string = ObjectId hex; undefined = omit filter
 */
export function parseSetIdInput(raw) {
    if (raw === undefined) return undefined
    if (raw === null) return null
    const s = String(raw).trim()
    if (!s || s === "null" || s === "none" || s === "general") return null
    if (!mongoose.Types.ObjectId.isValid(s)) return "__invalid__"
    return s
}

/** Mongo filter for raw media scoped to a set (or uncategorized). */
export function folderMediaSetMatch(setId) {
    if (setId === undefined) return {}
    if (setId === null) {
        return { $or: [{ set: null }, { set: { $exists: false } }] }
    }
    return { set: setId }
}
