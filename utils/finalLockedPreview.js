import sharp from "sharp"

const MAX_EDGE = 1600

const escapeXml = (s) =>
    String(s)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")

function lockedOverlaySvg(width, height) {
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const m = Math.min(w, h)
    const fontSize = Math.max(40, Math.min(140, Math.round(m * 0.12)))
    const strokeW = Math.max(1, Math.round(fontSize * 0.018))
    const stamp = escapeXml(
        process.env.FINAL_LOCKED_WATERMARK_TEXT?.trim() || "LOCKED"
    )
    const footer = escapeXml(
        "Balance due — preview only · full files after payment"
    )
    const stampAttrs = `fill="rgba(255,255,255,0.38)" stroke="rgba(0,0,0,0.08)" stroke-width="${strokeW}" stroke-linejoin="round" paint-order="stroke fill"`
    const positions = [
        [Math.round(w * 0.25), Math.round(h * 0.3)],
        [Math.round(w * 0.55), Math.round(h * 0.52)],
        [Math.round(w * 0.78), Math.round(h * 0.72)],
    ]
    const texts = positions
        .map(
            ([x, y]) =>
                `<text x="${x}" y="${y}" dominant-baseline="middle" text-anchor="middle"
    transform="rotate(-28 ${x} ${y})"
    ${stampAttrs} font-size="${fontSize}" font-weight="700" font-family="system-ui,sans-serif">${stamp}</text>`
        )
        .join("\n  ")
    const subFs = Math.max(14, Math.round(m * 0.028))
    const footerStroke = Math.max(1, Math.round(subFs * 0.03))
    return Buffer.from(
        `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${texts}
  <text x="${Math.round(w / 2)}" y="${
            h - Math.max(16, Math.round(subFs * 1.3))
        }" fill="rgba(255,255,255,0.62)" stroke="rgba(0,0,0,0.1)" stroke-width="${footerStroke}" stroke-linejoin="round" paint-order="stroke fill" font-size="${subFs}" font-weight="500" font-family="system-ui,sans-serif" text-anchor="middle">${footer}</text>
</svg>`
    )
}

/**
 * Streams a downscaled, watermarked JPEG to the response (best-effort protection
 * vs serving originals while payment is pending; screenshots cannot be blocked in HTTP).
 * @param {import("express").Response} res
 * @param {Buffer} imageBuffer
 */
export async function pipeLockedFinalJpegToResponse(res, imageBuffer) {
    const pipeline = sharp(imageBuffer, {
        failOn: "none",
        limitInputPixels: 268_402_689,
    }).rotate()

    const resized = pipeline.resize({
        width: MAX_EDGE,
        height: MAX_EDGE,
        fit: "inside",
        withoutEnlargement: true,
    })

    const { data, info } = await resized
        .toBuffer({ resolveWithObject: true })
        .catch(() => ({ data: null, info: null }))

    if (!data || !info?.width || !info?.height) {
        return false
    }

    const overlay = lockedOverlaySvg(info.width, info.height)
    res.setHeader("Content-Type", "image/jpeg")
    res.setHeader("Cache-Control", "private, no-store")
    res.setHeader("X-Content-Type-Options", "nosniff")

    const out = await sharp(data)
        .composite([{ input: overlay, blend: "over" }])
        .jpeg({ quality: 82, mozjpeg: true })
        .toBuffer()
        .catch(() => null)

    if (!out) return false
    res.send(out)
    return true
}

export function isRasterImageMime(mime) {
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
