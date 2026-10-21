import crypto from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import sharp from "sharp"
import FolderMedia from "../models/FolderMedia.js"
import { buildPublicAssetUrl } from "./assetUrl.js"
import { writeRasterDisplaySet } from "./mediaThumbnail.js"
import { ACTIVE_MEDIA_MATCH } from "./softDelete.js"
import {
    deleteStoredAsset,
    getObjectStreamForStoredPath,
    isObjectStorageS3,
    resolveLocalAbsolutePath,
    uploadLocalFileThenRemove,
} from "../services/objectStorage.js"

export const GALLERY_MARK_POSITIONS = [
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "center",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
]

export const GALLERY_MARK_LOGO_MAX_BYTES = Math.round(1.2 * 1024 * 1024)

const sharpOpts = {
    failOn: "none",
    limitInputPixels: 268_402_689,
}

function isRasterStill(mime) {
    const m = String(mime || "").toLowerCase()
    return (
        m.startsWith("image/jpeg") ||
        m.startsWith("image/jpg") ||
        m.startsWith("image/png") ||
        m.startsWith("image/webp") ||
        m.startsWith("image/gif") ||
        m.startsWith("image/tiff") ||
        m.startsWith("image/heic") ||
        m.startsWith("image/heif")
    )
}

function parseBool(raw) {
    if (raw === undefined) return undefined
    if (raw === true || raw === 1) return true
    if (raw === false || raw === 0) return false
    if (raw === null) return null
    const s = String(raw).toLowerCase().trim()
    if (s === "true" || s === "1" || s === "yes" || s === "on") return true
    if (s === "false" || s === "0" || s === "no" || s === "off") return false
    return null
}

function parseBoundedInt(raw, min, max, label) {
    const n =
        typeof raw === "number" && Number.isFinite(raw)
            ? raw
            : Number.parseFloat(String(raw).trim())
    if (!Number.isFinite(n)) {
        return { error: `${label} must be a number from ${min} to ${max}` }
    }
    const rounded = Math.round(n)
    if (rounded < min || rounded > max) {
        return { error: `${label} must be a number from ${min} to ${max}` }
    }
    return { value: rounded }
}

/** Settings that change the pixels baked onto a final. */
export function galleryMarkStampKey(folder) {
    const mark = folder?.galleryMark || {}
    if (!mark.enabled || !mark.logoPath) return "off"
    return [
        mark.position || "bottom-right",
        mark.size ?? 18,
        mark.opacity ?? 90,
        mark.inset ?? 5,
        mark.plate === false ? 0 : 1,
        mark.logoPath,
    ].join("|")
}

export function isGalleryMarkActive(folder) {
    return galleryMarkStampKey(folder) !== "off"
}

export function publicGalleryMark(req, folder) {
    const mark = folder?.galleryMark || {}
    const logoPath = mark.logoPath || ""
    return {
        enabled: Boolean(mark.enabled) && Boolean(logoPath),
        position: mark.position || "bottom-right",
        size: mark.size ?? 18,
        opacity: mark.opacity ?? 90,
        inset: mark.inset ?? 5,
        plate: mark.plate !== false,
        name: mark.logoName || "",
        logoName: mark.logoName || "",
        logoPath,
        logoUrl: logoPath ? buildPublicAssetUrl(req, logoPath) : "",
    }
}

/**
 * Read a gallery-mark update from JSON or multipart text.
 * `src` is ignored except an empty src, which removes the logo.
 * @returns {{ present: false } | { error: string } | { present: true, patch: object, removeLogo: boolean }}
 */
export function readGalleryMarkPatch(body) {
    if (!body || typeof body !== "object") return { present: false }
    const removeFlag = parseBool(body.removeGalleryMarkLogo)
    if (removeFlag === null) {
        return { error: "removeGalleryMarkLogo must be true or false" }
    }
    const bracketed = {}
    let hasBracket = false
    for (const [key, value] of Object.entries(body)) {
        const match =
            key.match(/^galleryMark\[(\w+)\]$/) ||
            key.match(/^galleryMark\.(\w+)$/)
        if (!match) continue
        hasBracket = true
        bracketed[match[1]] = value
    }

    const hasKey = Object.prototype.hasOwnProperty.call(body, "galleryMark")
    if (!hasKey && !hasBracket && removeFlag !== true) return { present: false }

    let input = hasBracket ? bracketed : {}
    if (hasKey) {
        let raw = body.galleryMark
        if (typeof raw === "string") {
            const trimmed = raw.trim()
            if (!trimmed) return { error: "galleryMark must be a JSON object" }
            try {
                raw = JSON.parse(trimmed)
            } catch {
                return { error: "galleryMark must be a JSON object" }
            }
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            return { error: "galleryMark must be a JSON object" }
        }
        input = raw
    }

    const patch = {}
    if (input.enabled !== undefined) {
        const parsed = parseBool(input.enabled)
        if (parsed === null) {
            return { error: "galleryMark.enabled must be true or false" }
        }
        patch.enabled = parsed
    }
    if (input.position !== undefined) {
        const position = String(input.position).trim()
        if (!GALLERY_MARK_POSITIONS.includes(position)) {
            return {
                error: `galleryMark.position must be one of: ${GALLERY_MARK_POSITIONS.join(", ")}`,
            }
        }
        patch.position = position
    }
    for (const [key, min, max] of [
        ["size", 8, 36],
        ["opacity", 15, 100],
        ["inset", 2, 16],
    ]) {
        if (input[key] === undefined) continue
        const parsed = parseBoundedInt(input[key], min, max, `galleryMark.${key}`)
        if (parsed.error) return { error: parsed.error }
        patch[key] = parsed.value
    }
    if (input.plate !== undefined) {
        const parsed = parseBool(input.plate)
        if (parsed === null) {
            return { error: "galleryMark.plate must be true or false" }
        }
        patch.plate = parsed
    }
    if (typeof input.name === "string") {
        patch.logoName = input.name.trim().slice(0, 240)
    }

    let removeLogo = removeFlag === true
    if (parseBool(input.removeLogo) === true) removeLogo = true
    if (
        Object.prototype.hasOwnProperty.call(input, "src") &&
        (input.src === null || input.src === "")
    ) {
        removeLogo = true
    }
    if (
        Object.prototype.hasOwnProperty.call(input, "logo") &&
        (input.logo === null || input.logo === "")
    ) {
        removeLogo = true
    }

    return { present: true, patch, removeLogo }
}

export function assignGalleryMark(folder, patch, { logoPath, logoName, removeLogo } = {}) {
    const current = folder.galleryMark?.toObject
        ? folder.galleryMark.toObject()
        : { ...(folder.galleryMark || {}) }
    const next = {
        enabled: Boolean(current.enabled),
        position: current.position || "bottom-right",
        size: current.size ?? 18,
        opacity: current.opacity ?? 90,
        inset: current.inset ?? 5,
        plate: current.plate !== false,
        logoPath: current.logoPath || "",
        logoName: current.logoName || "",
        ...patch,
    }
    if (removeLogo) {
        next.logoPath = ""
        next.logoName = ""
        next.enabled = false
    }
    if (logoPath) {
        next.logoPath = logoPath
        if (logoName) next.logoName = logoName
    }
    if (!next.logoPath) next.enabled = false
    folder.galleryMark = next
    folder.markModified?.("galleryMark")
    return next
}

function orientedSize(meta) {
    const w = meta?.width || 0
    const h = meta?.height || 0
    const o = meta?.orientation || 1
    if (o >= 5 && o <= 8) return { width: h, height: w }
    return { width: w, height: h }
}

function desiredLogoBox(photoW, photoH, aspect, settings) {
    const S = Math.min(photoW, photoH)
    const pad = settings.plate ? 0.007 * S : 0
    const maxBoxH = 0.46 * S
    let innerW = (settings.size / 100) * S - 2 * pad
    innerW = Math.max(1, innerW)
    let innerH = innerW / aspect
    if (innerH + 2 * pad > maxBoxH) {
        innerH = Math.max(1, maxBoxH - 2 * pad)
        innerW = Math.max(1, innerH * aspect)
    }
    return { pad, innerW, innerH }
}

function pinBox(photoW, photoH, boxW, boxH, position, margin) {
    const m = Math.round(margin)
    const centerX = Math.round((photoW - boxW) / 2)
    const centerY = Math.round((photoH - boxH) / 2)
    const right = Math.round(photoW - boxW - m)
    const bottom = Math.round(photoH - boxH - m)
    const spots = {
        "top-left": [m, m],
        "top-center": [centerX, m],
        "top-right": [right, m],
        "middle-left": [m, centerY],
        center: [centerX, centerY],
        "middle-right": [right, centerY],
        "bottom-left": [m, bottom],
        "bottom-center": [centerX, bottom],
        "bottom-right": [right, bottom],
    }
    let [left, top] = spots[position] || spots["bottom-right"]
    left = Math.max(0, Math.min(left, Math.max(0, photoW - boxW)))
    top = Math.max(0, Math.min(top, Math.max(0, photoH - boxH)))
    return { left, top }
}

async function pngFromRaw(data, width, height) {
    return sharp(data, {
        raw: { width, height, channels: 4 },
    })
        .png()
        .toBuffer()
}

async function withAlphaScale(pngBuffer, scale) {
    if (scale >= 0.999) return pngBuffer
    const { data, info } = await sharp(pngBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    const out = Buffer.from(data)
    for (let i = 3; i < out.length; i += 4) {
        out[i] = Math.round(out[i] * scale)
    }
    return pngFromRaw(out, info.width, info.height)
}

async function recolor(pngBuffer, rgb) {
    const { data, info } = await sharp(pngBuffer)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true })
    const out = Buffer.from(data)
    for (let i = 0; i < out.length; i += 4) {
        out[i] = rgb[0]
        out[i + 1] = rgb[1]
        out[i + 2] = rgb[2]
    }
    return pngFromRaw(out, info.width, info.height)
}

async function roundedRect(width, height, radius, rgba) {
    const w = Math.max(1, Math.round(width))
    const h = Math.max(1, Math.round(height))
    const r = Math.max(0, Math.min(radius, Math.floor(w / 2), Math.floor(h / 2)))
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${w}" height="${h}" rx="${r}" ry="${r}" fill="${rgba}"/></svg>`
    return sharp(Buffer.from(svg)).png().toBuffer()
}

async function transparentCanvas(width, height) {
    return sharp({
        create: {
            width: Math.max(1, Math.round(width)),
            height: Math.max(1, Math.round(height)),
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
    })
        .png()
        .toBuffer()
}

/**
 * Build the logo chip (or bare logo) and where it sits on a photo of the given size.
 * @returns {Promise<{ png: Buffer, left: number, top: number } | null>}
 */
export async function buildGalleryMarkOverlay(photoW, photoH, logoPath, settings) {
    if (!photoW || !photoH || !logoPath) return null
    const logoMeta = await sharp(logoPath, {
        ...sharpOpts,
        density: 300,
    }).metadata()
    const oriented = orientedSize(logoMeta)
    const aspect =
        oriented.width > 0 && oriented.height > 0
            ? oriented.width / oriented.height
            : 1
    const box = desiredLogoBox(photoW, photoH, aspect, settings)
    const resized = await sharp(logoPath, { ...sharpOpts, density: 300 })
        .rotate()
        .resize({
            width: Math.max(1, Math.round(box.innerW)),
            height: Math.max(1, Math.round(box.innerH)),
            fit: "inside",
            withoutEnlargement: false,
        })
        .ensureAlpha()
        .png()
        .toBuffer({ resolveWithObject: true })

    const logoW = resized.info.width
    const logoH = resized.info.height
    const padPx = settings.plate ? Math.max(0, Math.round(box.pad)) : 0
    const boxW = logoW + padPx * 2
    const boxH = logoH + padPx * 2
    const margin = (settings.inset / 100) * Math.min(photoW, photoH)
    const spot = pinBox(
        photoW,
        photoH,
        boxW,
        boxH,
        settings.position || "bottom-right",
        margin
    )

    const blurRoom = 20
    const canvasW = boxW + blurRoom * 2
    const canvasH = boxH + blurRoom * 2
    const layers = []

    if (settings.plate !== false) {
        const shadowRect = await roundedRect(boxW, boxH, 6, "black")
        const shadowLayer = await withAlphaScale(
            await sharp(await transparentCanvas(canvasW, canvasH))
                .composite([
                    { input: shadowRect, left: blurRoom, top: blurRoom + 2 },
                ])
                .blur(4)
                .png()
                .toBuffer(),
            0.28
        )
        layers.push({ input: shadowLayer, left: 0, top: 0 })
        layers.push({
            input: await roundedRect(boxW, boxH, 6, "rgba(255,255,255,0.92)"),
            left: blurRoom,
            top: blurRoom,
        })
        layers.push({
            input: resized.data,
            left: blurRoom + padPx,
            top: blurRoom + padPx,
        })
    } else {
        const white = await recolor(resized.data, [255, 255, 255])
        const black = await recolor(resized.data, [0, 0, 0])
        const haloPad = 8
        const halo = await withAlphaScale(
            await sharp(white)
                .extend({
                    top: haloPad,
                    bottom: haloPad,
                    left: haloPad,
                    right: haloPad,
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .blur(0.3)
                .png()
                .toBuffer(),
            0.95
        )
        const drop = await withAlphaScale(
            await sharp(black)
                .extend({
                    top: haloPad,
                    bottom: haloPad,
                    left: haloPad,
                    right: haloPad,
                    background: { r: 0, g: 0, b: 0, alpha: 0 },
                })
                .blur(1)
                .png()
                .toBuffer(),
            0.55
        )
        layers.push({
            input: drop,
            left: blurRoom - haloPad,
            top: blurRoom - haloPad + 1,
        })
        layers.push({
            input: halo,
            left: blurRoom - haloPad,
            top: blurRoom - haloPad,
        })
        layers.push({ input: resized.data, left: blurRoom, top: blurRoom })
    }

    let overlay = await sharp(await transparentCanvas(canvasW, canvasH))
        .composite(layers)
        .png()
        .toBuffer()
    const opacity = Math.min(1, Math.max(0, (settings.opacity ?? 90) / 100))
    overlay = await withAlphaScale(overlay, opacity)

    return {
        png: overlay,
        left: spot.left - blurRoom,
        top: spot.top - blurRoom,
    }
}

async function clipComposite(photoW, photoH, overlay) {
    const meta = await sharp(overlay.png).metadata()
    let srcLeft = 0
    let srcTop = 0
    let srcW = meta.width || 0
    let srcH = meta.height || 0
    let left = overlay.left
    let top = overlay.top
    if (left < 0) {
        srcLeft = -left
        srcW -= srcLeft
        left = 0
    }
    if (top < 0) {
        srcTop = -top
        srcH -= srcTop
        top = 0
    }
    if (left + srcW > photoW) srcW = photoW - left
    if (top + srcH > photoH) srcH = photoH - top
    srcW = Math.round(srcW)
    srcH = Math.round(srcH)
    if (srcW < 1 || srcH < 1) return null
    const input =
        srcLeft === 0 &&
        srcTop === 0 &&
        srcW === meta.width &&
        srcH === meta.height
            ? overlay.png
            : await sharp(overlay.png)
                  .extract({
                      left: Math.round(srcLeft),
                      top: Math.round(srcTop),
                      width: srcW,
                      height: srcH,
                  })
                  .png()
                  .toBuffer()
    return { input, left: Math.round(left), top: Math.round(top) }
}

function markedOutput(mime) {
    const m = String(mime || "").toLowerCase()
    if (m.includes("png")) {
        return { ext: "png", contentType: "image/png" }
    }
    if (m.includes("webp")) {
        return { ext: "webp", contentType: "image/webp" }
    }
    return { ext: "jpg", contentType: "image/jpeg" }
}

export function contentTypeForStoredPath(storedPath) {
    const ext = path.posix.extname(String(storedPath || "")).toLowerCase()
    if (ext === ".png") return "image/png"
    if (ext === ".webp") return "image/webp"
    if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg"
    return "application/octet-stream"
}

function markedRelativePath(storedPath, token, ext) {
    const norm = String(storedPath || "")
        .replace(/\\/g, "/")
        .replace(/^\//, "")
    const dir = path.posix.dirname(norm)
    const base = path.posix.basename(norm)
    const dot = base.lastIndexOf(".")
    const stem = dot === -1 ? base : base.slice(0, dot)
    return path.posix.join(dir, `${stem}.mark-${token}.${ext}`)
}

export function markedAssetPaths(doc) {
    const paths = []
    if (doc?.markedFilePath) paths.push(String(doc.markedFilePath))
    if (doc?.markedThumbPath) paths.push(String(doc.markedThumbPath))
    if (Array.isArray(doc?.markedVariants)) {
        for (const variant of doc.markedVariants) {
            if (variant?.path) paths.push(String(variant.path))
        }
    }
    return [...new Set(paths.filter(Boolean))]
}

export async function clearFinalMark(doc) {
    for (const storedPath of markedAssetPaths(doc)) {
        await deleteStoredAsset(storedPath)
    }
    if (!doc) return
    doc.markedFilePath = ""
    doc.markedThumbPath = ""
    doc.markedVariants = []
}

async function materializeStoredFile(storedPath) {
    if (!storedPath) throw new Error("missing stored file")
    if (!isObjectStorageS3()) {
        const abs = resolveLocalAbsolutePath(storedPath)
        if (!abs || !fs.existsSync(abs)) {
            throw new Error("Gallery mark source file is missing")
        }
        return { path: abs, cleanup: false }
    }
    const out = await getObjectStreamForStoredPath(storedPath)
    if (!out?.Body) throw new Error("Gallery mark source file is missing")
    const tmp = path.join(
        os.tmpdir(),
        `gmark-${crypto.randomBytes(8).toString("hex")}`
    )
    const body =
        typeof out.Body.pipe === "function" ? out.Body : Readable.from(out.Body)
    await pipeline(body, fs.createWriteStream(tmp))
    return { path: tmp, cleanup: true }
}

async function writeMarkedFile(sourceAbs, storedPath, logoPath, settings, mime) {
    const meta = await sharp(sourceAbs, sharpOpts).metadata()
    const { width, height } = orientedSize(meta)
    if (!width || !height) throw new Error("Could not read photo size")

    const overlay = await buildGalleryMarkOverlay(width, height, logoPath, settings)
    const placed = overlay ? await clipComposite(width, height, overlay) : null
    const spec = markedOutput(mime)
    const token = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`
    const rel = markedRelativePath(storedPath, token, spec.ext)
    const abs = resolveLocalAbsolutePath(rel)
    await fs.promises.mkdir(path.dirname(abs), { recursive: true })

    let pipeline = sharp(sourceAbs, sharpOpts).rotate()
    if (placed) pipeline = pipeline.composite([placed])
    if (spec.ext === "png") await pipeline.png().toFile(abs)
    else if (spec.ext === "webp") {
        await pipeline.webp({ quality: 90, effort: 4 }).toFile(abs)
    } else {
        await pipeline.jpeg({ quality: 92, mozjpeg: true, progressive: true }).toFile(abs)
    }

    let variants = []
    let thumbPath = ""
    try {
        const display = await writeRasterDisplaySet(abs, rel)
        variants = display?.variants || []
        thumbPath = display?.thumbPath || ""
    } catch (error) {
        console.warn("Gallery mark sizes skipped:", error?.message)
    }

    return {
        filePath: rel,
        abs,
        contentType: spec.contentType,
        variants,
        thumbPath,
    }
}

/**
 * Stamp one final from a local original, or clear the stamp when the mark is off.
 * Does not save the document.
 */
export async function applyGalleryMarkToFinal(doc, sourceAbs, folder, logoAbs) {
    if (!isGalleryMarkActive(folder) || !isRasterStill(doc?.mimeType)) {
        await clearFinalMark(doc)
        return
    }
    const previous = markedAssetPaths(doc)
    let opened = null
    let logoPath = logoAbs
    try {
        if (!logoPath) {
            opened = await materializeStoredFile(folder.galleryMark.logoPath)
            logoPath = opened.path
        }
        const written = await writeMarkedFile(
            sourceAbs,
            doc.filePath,
            logoPath,
            folder.galleryMark,
            doc.mimeType
        )
        doc.markedFilePath = written.filePath
        doc.markedThumbPath = written.thumbPath
        doc.markedVariants = written.variants
        if (isObjectStorageS3()) {
            await uploadLocalFileThenRemove(
                written.abs,
                written.filePath,
                written.contentType
            )
            for (const variant of written.variants) {
                await uploadLocalFileThenRemove(
                    resolveLocalAbsolutePath(variant.path),
                    variant.path,
                    "image/webp"
                )
            }
        }
        const next = new Set(markedAssetPaths(doc))
        for (const oldPath of previous) {
            if (!next.has(oldPath)) await deleteStoredAsset(oldPath)
        }
    } finally {
        if (opened?.cleanup) {
            await fs.promises.unlink(opened.path).catch(() => {})
        }
    }
}

export async function applyGalleryMarkToStoredFinal(doc, folder) {
    if (!doc?.filePath) return
    if (!isGalleryMarkActive(folder) || !isRasterStill(doc.mimeType)) {
        await clearFinalMark(doc)
        return
    }
    const opened = await materializeStoredFile(doc.filePath)
    try {
        await applyGalleryMarkToFinal(doc, opened.path, folder)
    } finally {
        if (opened.cleanup) await fs.promises.unlink(opened.path).catch(() => {})
    }
}

/** Rebuild or remove stamps for every final still in the folder. */
export async function restampFolderFinals(folder) {
    const docs = await FolderMedia.find({
        folder: folder._id,
        kind: "final",
        ...ACTIVE_MEDIA_MATCH,
    })
    let logo = null
    try {
        if (isGalleryMarkActive(folder)) {
            logo = await materializeStoredFile(folder.galleryMark.logoPath)
        }
        for (const doc of docs) {
            try {
                if (!logo || !isRasterStill(doc.mimeType)) {
                    await clearFinalMark(doc)
                } else {
                    const source = await materializeStoredFile(doc.filePath)
                    try {
                        await applyGalleryMarkToFinal(
                            doc,
                            source.path,
                            folder,
                            logo.path
                        )
                    } finally {
                        if (source.cleanup) {
                            await fs.promises.unlink(source.path).catch(() => {})
                        }
                    }
                }
                await doc.save()
            } catch (error) {
                console.warn(
                    "Gallery mark skipped:",
                    doc.originalFilename || doc._id,
                    error?.message
                )
            }
        }
    } finally {
        if (logo?.cleanup) await fs.promises.unlink(logo.path).catch(() => {})
    }
}

export function deliveryFileForFinal(folder, doc) {
    if (isGalleryMarkActive(folder) && doc?.markedFilePath) {
        const storedPath = doc.markedFilePath
        const ext = path.posix.extname(storedPath)
        const original = doc.originalFilename || path.posix.basename(storedPath)
        const stem = original.replace(/\.[^.]+$/, "") || "download"
        return {
            storedPath,
            contentType: contentTypeForStoredPath(storedPath),
            downloadName: `${stem}${ext}`,
        }
    }
    return {
        storedPath: doc?.filePath || "",
        contentType: doc?.mimeType || "application/octet-stream",
        downloadName:
            doc?.originalFilename ||
            path.posix.basename(doc?.filePath || "") ||
            "download",
    }
}

/**
 * Draw the folder logo onto an already-decoded photo buffer.
 * Returns the same buffer when the mark cannot be drawn.
 */
export async function openGalleryMarkLogo(folder) {
    if (!isGalleryMarkActive(folder)) return null
    return materializeStoredFile(folder.galleryMark.logoPath)
}

export async function compositeGalleryMarkBuffer(imageBuffer, logoPath, settings) {
    const meta = await sharp(imageBuffer, sharpOpts).metadata()
    if (!meta?.width || !meta?.height || !logoPath) return imageBuffer
    const overlay = await buildGalleryMarkOverlay(
        meta.width,
        meta.height,
        logoPath,
        settings
    )
    if (!overlay) return imageBuffer
    const placed = await clipComposite(meta.width, meta.height, overlay)
    if (!placed) return imageBuffer
    return sharp(imageBuffer, sharpOpts).composite([placed]).toBuffer()
}
