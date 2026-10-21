import fs from "fs"
import path from "path"
import sharp from "sharp"
import { encode as encodeBlurHash } from "blurhash"
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

/** Display widths for srcset. The browser picks one; the original file is never resized. */
const displayWidths = [480, 800, 1600, 2560]

function storedStem(storedPath) {
    const norm = String(storedPath || "")
        .replace(/\\/g, "/")
        .replace(/^\//, "")
    if (!norm) return null
    const dir = path.posix.dirname(norm)
    const base = path.posix.basename(norm)
    const i = base.lastIndexOf(".")
    const stem = i === -1 ? base : base.slice(0, i)
    return { dir, stem }
}

/**
 * Logical stored path for a WebP thumbnail next to the original
 * (e.g. uploads/.../photo-abc.jpg → uploads/.../photo-abc.thumb.webp).
 */
export function thumbRelativePathForMedia(storedPath) {
    const parts = storedStem(storedPath)
    if (!parts) return ""
    return path.posix.join(parts.dir, `${parts.stem}.thumb.webp`)
}

function variantRelativePathForMedia(storedPath, width) {
    const parts = storedStem(storedPath)
    if (!parts) return ""
    return path.posix.join(parts.dir, `${parts.stem}.w${width}.webp`)
}

/** Pixel size after applying the EXIF orientation flag (swap for sideways photos). */
function orientedSize(meta) {
    const w = meta?.width || 0
    const h = meta?.height || 0
    const o = meta?.orientation || 1
    if (o >= 5 && o <= 8) return { width: h, height: w }
    return { width: w, height: h }
}

function plannedDisplayWidths(originalWidth) {
    const caps = [...new Set([480, thumbMaxEdge, ...displayWidths])]
        .filter((n) => n >= 64 && n <= 4096)
        .sort((a, b) => a - b)
    if (!originalWidth) return caps
    const smaller = caps.filter((w) => w < originalWidth)
    const largest = Math.min(originalWidth, caps[caps.length - 1])
    return [...new Set([...smaller, largest])].sort((a, b) => a - b)
}

export function derivativeStoredPaths(doc) {
    const paths = []
    if (doc?.thumbPath) paths.push(String(doc.thumbPath))
    if (Array.isArray(doc?.variants)) {
        for (const variant of doc.variants) {
            if (variant?.path) paths.push(String(variant.path))
        }
    }
    return [...new Set(paths.filter(Boolean))]
}

export async function deleteMediaDerivatives(doc) {
    for (const storedPath of derivativeStoredPaths(doc)) {
        await deleteStoredAsset(storedPath)
    }
    if (!doc) return
    doc.thumbPath = ""
    doc.variants = []
    doc.width = 0
    doc.height = 0
    doc.blurHash = ""
}

function pickThumbPath(variants) {
    if (!variants.length) return ""
    const under = variants.filter((v) => v.width <= thumbMaxEdge)
    const pool = under.length ? under : variants
    return pool.reduce((best, variant) =>
        Math.abs(variant.width - thumbMaxEdge) <
        Math.abs(best.width - thumbMaxEdge)
            ? variant
            : best
    ).path
}

const sharpInputOpts = {
    failOn: "none",
    limitInputPixels: 268_402_689,
}

export async function writeRasterThumbnailFromFile(
    sourceAbsolutePath,
    destAbsolutePath
) {
    await fs.promises.mkdir(path.dirname(destAbsolutePath), { recursive: true })
    await sharp(sourceAbsolutePath, sharpInputOpts)
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
 * Reads the file once into a display-sized copy, then writes a blur hash and one WebP per width.
 * Originals stay untouched so downloads keep full quality.
 * @returns {{ width: number, height: number, blurHash: string, variants: { width: number, path: string }[], thumbPath: string } | null}
 */
export async function writeRasterDisplaySet(sourceAbsolutePath, storedPath) {
    const meta = await sharp(sourceAbsolutePath, sharpInputOpts).metadata()
    const { width, height } = orientedSize(meta)
    const targets = plannedDisplayWidths(width)
    if (!targets.length || !storedPath) return null

    const maxEdge = targets[targets.length - 1]
    const master = await sharp(sourceAbsolutePath, sharpInputOpts)
        .rotate()
        .resize({
            width: maxEdge,
            height: maxEdge,
            fit: "inside",
            withoutEnlargement: true,
        })
        .png()
        .toBuffer()

    let blurHash = ""
    try {
        const tiny = await sharp(master)
            .resize(32, 32, { fit: "inside", withoutEnlargement: true })
            .ensureAlpha()
            .raw()
            .toBuffer({ resolveWithObject: true })
        const px = tiny.info.width
        const py = tiny.info.height
        if (px > 0 && py > 0 && tiny.data.length >= px * py * 4) {
            blurHash = encodeBlurHash(
                new Uint8ClampedArray(
                    tiny.data.buffer,
                    tiny.data.byteOffset,
                    tiny.data.byteLength
                ),
                px,
                py,
                Math.min(4, px),
                Math.min(3, py)
            )
        }
    } catch (e) {
        console.warn("BlurHash skipped:", e?.message)
    }

    const variants = []
    const written = []
    try {
        const seen = new Set()
        for (const target of targets) {
            const rel = variantRelativePathForMedia(storedPath, target)
            if (!rel) continue
            const abs = resolveLocalAbsolutePath(rel)
            await fs.promises.mkdir(path.dirname(abs), { recursive: true })
            const info = await sharp(master)
                .resize({
                    width: target,
                    height: target,
                    fit: "inside",
                    withoutEnlargement: true,
                })
                .webp({ quality: thumbQuality, effort: 4 })
                .toFile(abs)
            const outWidth = info.width || target
            if (seen.has(outWidth)) {
                await deleteStoredAsset(rel)
                continue
            }
            seen.add(outWidth)
            written.push(rel)
            variants.push({ width: outWidth, path: rel })
        }
    } catch (e) {
        for (const rel of written) await deleteStoredAsset(rel)
        throw e
    }

    if (!variants.length) return null
    return {
        width,
        height,
        blurHash,
        variants,
        thumbPath: pickThumbPath(variants),
    }
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
        await deleteMediaDerivatives(doc)
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

    const previousPaths = derivativeStoredPaths(doc)
    let display
    try {
        display = await writeRasterDisplaySet(sourceAbs, doc.filePath)
    } catch (e) {
        console.warn(
            "Thumbnail not generated:",
            f.originalname || doc.originalFilename,
            e?.message
        )
        return
    }
    if (!display) return

    if (sourceAbs !== f.path && f.path && fs.existsSync(f.path)) {
        try {
            const originalMeta = await sharp(f.path, sharpInputOpts).metadata()
            const originalSize = orientedSize(originalMeta)
            if (originalSize.width && originalSize.height) {
                display.width = originalSize.width
                display.height = originalSize.height
            }
        } catch (_) {}
    }

    doc.thumbPath = display.thumbPath
    doc.variants = display.variants
    doc.width = display.width
    doc.height = display.height
    doc.blurHash = display.blurHash

    if (isObjectStorageS3()) {
        for (const variant of display.variants) {
            await uploadLocalFileThenRemove(
                resolveLocalAbsolutePath(variant.path),
                variant.path,
                "image/webp"
            )
        }
    }

    const nextPaths = new Set(derivativeStoredPaths(doc))
    for (const oldPath of previousPaths) {
        if (!nextPaths.has(oldPath)) await deleteStoredAsset(oldPath)
    }
}
