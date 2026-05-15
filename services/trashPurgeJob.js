import cron from "node-cron"
import Folder from "../models/Folder.js"
import FolderMedia from "../models/FolderMedia.js"
import {
    purgeFolderWhole,
    hardRemoveMediaDocument,
} from "../controllers/folderMediaController.js"
import { getTrashRetentionDays, purgeCutoffDate } from "../utils/softDelete.js"

const BATCH = 200

function envFlag(key, defaultTrue = true) {
    const v = process.env[key]
    if (v === undefined || v === null || String(v).trim() === "") return defaultTrue
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}

/**
 * Hard-deletes folders whose `deletedAt` is past the retention window, then
 * purges individually trashed media (`deletedBy: media`) whose parent folder is still active.
 */
export async function runTrashPurgeJob() {
    const cutoff = purgeCutoffDate()

    const expiredFolders = await Folder.find({ deletedAt: { $lte: cutoff } })
        .select("_id usingDefaultCover coverImage backgroundMusic deletedAt")
        .limit(BATCH)
        .lean()

    for (const f of expiredFolders) {
        await purgeFolderWhole(f)
        console.log(`[trash-purge] permanently removed gallery ${String(f._id)}`)
    }

    for (let i = 0; i < 50; i++) {
        const batch = await FolderMedia.find({
            deletedAt: { $lte: cutoff },
            deletedBy: "media",
        }).limit(BATCH)

        if (!batch.length) break

        let progressed = false
        for (const doc of batch) {
            const parent = await Folder.findById(doc.folder).select("deletedAt").lean()
            if (!parent) {
                await hardRemoveMediaDocument(doc)
                progressed = true
                continue
            }
            if (parent.deletedAt) {
                continue
            }
            await hardRemoveMediaDocument(doc)
            progressed = true
        }

        if (!progressed) break
    }
}

export function startTrashPurgeCron() {
    if (!envFlag("TRASH_PURGE_ENABLED", true)) {
        console.log("[trash-purge] disabled (TRASH_PURGE_ENABLED=false)")
        return
    }

    const tz = process.env.TRASH_PURGE_TIMEZONE?.trim() || "Africa/Accra"
    let pattern =
        process.env.TRASH_PURGE_CRON?.trim() || "15 4 * * *"

    if (!cron.validate(pattern)) {
        console.warn(
            `[trash-purge] invalid TRASH_PURGE_CRON=${JSON.stringify(pattern)}; not scheduled`
        )
        return
    }

    cron.schedule(
        pattern,
        () => {
            runTrashPurgeJob().catch((err) => {
                console.error("[trash-purge] run failed:", err)
            })
        },
        { timezone: tz }
    )

    console.log(
        `[trash-purge] scheduled cron=${JSON.stringify(pattern)} tz=${JSON.stringify(
            tz
        )} SOFT_DELETE_RETENTION_DAYS=${getTrashRetentionDays()}`
    )
}
