import fs from "fs"
import path from "path"
import sharp from "sharp"
import {
    isObjectStorageS3,
    resolveLocalAbsolutePath,
    uploadLocalFileThenRemove,
    deleteStoredAsset,
} from "../services/objectStorage.js"
import { isRasterImageMime } from "./finalLockedPreview.js"

const thumbMaxEdge = (() => {
    const n = Number(process.env.THUMBNAIL_MAX_EDGE)
    if (Number.isFinite(n) && n >= 64 && n <= 4096) return Math.floor(n)
    return 800
})()

const thumbQuality = (() => {
    const n = Number(process.env.THUMBNAIL_WEBP_QUALITY)
    if (Number.isFinite(n) && n >= 1 && n <= 100) return Math.floor(n)
    return 82
})()

/**
 * Logical stored path for a WebP thumbnail next to the original
 * (e.g. uploads/.../photo-abc.jpg → uploads/.../photo-abc.thumb.webp).
 */
export function thumbRelativePathForMedia(storedPath) {
    const norm = String(storedPath || "")
        .replace(/\\/g, "/")
        .replace(/^\//, "")
    if (!norm) return ""
    const dir = path.posix.dirname(norm)
    const base = path.posix.basename(norm)
    const i = base.lastIndexOf(".")
    const stem = i === -1 ? base : base.slice(0, i)
    return path.posix.join(dir, `${stem}.thumb.webp`)
}

export async function writeRasterThumbnailFromFile(
    sourceAbsolutePath,
    destAbsolutePath
) {
    await fs.promises.mkdir(path.dirname(destAbsolutePath), { recursive: true })
    await sharp(sourceAbsolutePath, {
        failOn: "none",
        limitInputPixels: 268_402_689,
    })
        .rotate()
        .resize({
            width: thumbMaxEdge,
            height: thumbMaxEdge,
            fit: "inside",
            withoutEnlargement: true,
        })
        .webp({ quality: thumbQuality, effort: 4 })
        .toFile(destAbsolutePath)
}

/**
 * Writes `doc.thumbPath` and uploads to S3 when configured. Uses the watermarked
 * display JPEG as source when `watermarkOn` and `displayDiskPath` exist (client-safe thumb).
 * @param {import("mongoose").Document} doc FolderMedia with `filePath`, `mimeType`
 * @param {import("multer").File} f
 * @param {boolean} watermarkOn
 * @param {string} [displayDiskPath]
 */
export async function finalizeRasterThumbnail(
    doc,
    f,
    watermarkOn,
    displayDiskPath
) {
    if (!isRasterImageMime(doc.mimeType)) {
        if (doc.thumbPath) {
            await deleteStoredAsset(doc.thumbPath)
            doc.thumbPath = ""
        }
        return
    }

    let sourceAbs = f.path
    if (watermarkOn && displayDiskPath) {
        try {
            if (fs.existsSync(displayDiskPath)) sourceAbs = displayDiskPath
        } catch (_) {}
    }
    if (!sourceAbs || !fs.existsSync(sourceAbs)) {
        console.warn(
            "Thumbnail skipped (missing source):",
            f.originalname || doc.originalFilename
        )
        return
    }

    const thumbRel = thumbRelativePathForMedia(doc.filePath)
    if (!thumbRel) return
    const thumbAbs = resolveLocalAbsolutePath(thumbRel)
    try {
        await writeRasterThumbnailFromFile(sourceAbs, thumbAbs)
    } catch (e) {
        console.warn(
            "Thumbnail not generated:",
            f.originalname || doc.originalFilename,
            e?.message
        )
        return
    }

    doc.thumbPath = thumbRel
    if (isObjectStorageS3()) {
        await uploadLocalFileThenRemove(thumbAbs, thumbRel, "image/webp")
    }
}
