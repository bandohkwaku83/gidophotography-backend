import fs from "fs"
import path from "path"
import sharp from "sharp"

const MAX_PREVIEW_EDGE = 2048

const escapeXml = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

const stampText = () =>
    escapeXml(process.env.WATERMARK_PREVIEW_TEXT?.trim() || "PREVIEW")

/** Three large diagonal stamps, spread so wide and tall images both get clear coverage. */
const tripleStampOverlaySvg = (width, height, { footerLine = null } = {}) => {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const m = Math.min(w, h)
    const fontSize = Math.max(48, Math.min(158, Math.round(m * 0.155)))
    const stamp = stampText()
    const strokeW = Math.max(1, Math.round(fontSize * 0.018))
    const stampAttrs = `fill="rgba(255,255,255,0.4)" stroke="rgba(0,0,0,0.07)" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke fill"`
    const positions = [
        [Math.round(w * 0.22), Math.round(h * 0.28)],
        [Math.round(w * 0.52), Math.round(h * 0.48)],
        [Math.round(w * 0.78), Math.round(h * 0.68)],
    ]
    const texts = positions
        .map(
            ([x, y]) =>
                `<text x="${x}" y="${y}" dominant-baseline="middle" text-anchor="middle"
    transform="rotate(-32 ${x} ${y})"
    ${stampAttrs} font-size="${fontSize}" font-weight="600" font-family="system-ui,sans-serif">${stamp}</text>`
        )
        .join("\n  ")
    const subFs = footerLine
        ? Math.max(16, Math.round(m * 0.036))
        : 0
    const footerStroke = Math.max(1, Math.round(subFs * 0.03))
    const footer = footerLine
        ? `\n  <text x="${Math.round(w / 2)}" y="${
              h - Math.max(20, Math.round(subFs * 1.4))
          }" fill="rgba(255,255,255,0.65)" stroke="rgba(0,0,0,0.09)" stroke-width="${footerStroke}" stroke-linejoin="round" paint-order="stroke fill" font-size="${subFs}" font-weight="500" font-family="system-ui,sans-serif" text-anchor="middle">${escapeXml(
              footerLine
          )}</text>`
        : ""
    return Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${texts}${footer}
</svg>`
    )
}

/** Synthetic video placeholder: same triple stamp + fixed footer (no folder title). */
const videoPlaceholderOverlaySvg = (width, height) =>
    tripleStampOverlaySvg(width, height, {
        footerLine: "Video — preview only",
    })

/**
 * Builds a watermarked JPEG next to the raw upload for gallery preview.
 * @returns {{ ok: true, relativePath: string, absolutePath: string } | { ok: false, error: string }}
 */
export async function generateRawDisplayAsset({
    sourcePath,
    outputAbsolutePath,
    relativePath,
    mimeType,
}) {
    try {
        const isVideo = String(mimeType || "").startsWith("video/")
        if (isVideo) {
            const w = 1280
            const h = 720
            await sharp({
                create: {
                    width: w,
                    height: h,
                    channels: 3,
                    background: { r: 28, g: 30, b: 36 },
                },
            })
                .composite([
                    { input: videoPlaceholderOverlaySvg(w, h), blend: "over" },
                ])
                .jpeg({ quality: 86, mozjpeg: true })
                .toFile(outputAbsolutePath)
            return { ok: true, relativePath, absolutePath: outputAbsolutePath }
        }

        if (!String(mimeType || "").startsWith("image/")) {
            return { ok: false, error: "not_image_or_video" }
        }

        const pipeline = sharp(sourcePath, { failOn: "none" }).rotate()

        const resized = pipeline.resize({
            width: MAX_PREVIEW_EDGE,
            height: MAX_PREVIEW_EDGE,
            fit: "inside",
            withoutEnlargement: true,
        })

        const { data, info } = await resized
            .toBuffer({ resolveWithObject: true })
            .catch(() => ({ data: null, info: null }))
        if (!data || !info?.width || !info?.height) {
            return { ok: false, error: "sharp_decode_failed" }
        }

        const overlay = tripleStampOverlaySvg(info.width, info.height)
        await sharp(data)
            .composite([{ input: overlay, blend: "over" }])
            .jpeg({ quality: 86, mozjpeg: true })
            .toFile(outputAbsolutePath)

        return { ok: true, relativePath, absolutePath: outputAbsolutePath }
    } catch (e) {
        if (fs.existsSync(outputAbsolutePath)) {
            try {
                fs.unlinkSync(outputAbsolutePath)
            } catch (_) {}
        }
        return { ok: false, error: e?.message || "unknown" }
    }
}

export function buildWatermarkedDisplayPaths(rawDiskPath, folderId) {
    const dir = path.dirname(rawDiskPath)
    const base = path.basename(rawDiskPath, path.extname(rawDiskPath))
    const fileName = `${base}-wm.jpg`
    const absolutePath = path.join(dir, fileName)
    const relativePath = path.posix.join(
        "uploads",
        "folders",
        String(folderId),
        "raw",
        fileName
    )
    return { absolutePath, relativePath, fileName }
}
