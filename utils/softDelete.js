import dotenv from "dotenv"

dotenv.config()

/** Retention window for restores (folders + individually deleted media). */
export function getTrashRetentionDays() {
    const n = Number.parseInt(
        process.env.SOFT_DELETE_RETENTION_DAYS || "30",
        10
    )
    if (!Number.isFinite(n) || n < 1) return 30
    return Math.min(Math.floor(n), 365 * 10)
}

export function getTrashRetentionMs() {
    return getTrashRetentionDays() * 24 * 60 * 60 * 1000
}

/** Deleted items with deletedAt at or before this instant are permanently purged. */
export function purgeCutoffDate(now = new Date()) {
    return new Date(now.getTime() - getTrashRetentionMs())
}

/** @param {Date | string | undefined | null} deletedAt */
export function isWithinRestoreWindow(deletedAt, now = new Date()) {
    if (!deletedAt) return false
    const d = deletedAt instanceof Date ? deletedAt : new Date(deletedAt)
    if (Number.isNaN(d.getTime())) return false
    return d > purgeCutoffDate(now)
}

/** When the trash window closes (exclusive of restore). */
export function restoreDeadlineISO(deletedAt) {
    if (!deletedAt) return null
    const d =
        deletedAt instanceof Date ? new Date(deletedAt) : new Date(deletedAt)
    if (Number.isNaN(d.getTime())) return null
    const deadline = new Date(d.getTime() + getTrashRetentionMs())
    return deadline.toISOString()
}

export const ACTIVE_FOLDER_MATCH = { deletedAt: null }

/** Only media visible in galleries and uploads. */
export const ACTIVE_MEDIA_MATCH = { deletedAt: null }
