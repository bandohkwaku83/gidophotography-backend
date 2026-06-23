/**
 * Public client gallery links (SMS {{gallery_link}}, folder.shareUrl, etc.).
 *
 * Env (first non-empty wins when no request header):
 *   GALLERY_PUBLIC_URL — preferred for live client links (set on the VPS)
 *   PUBLIC_GALLERY_URL — alias
 *   FRONTEND_URL — legacy; ignored in production when localhost
 *
 * Request header (wins when set to a non-localhost origin):
 *   X-Gallery-Public-Origin — sent by the Next admin app (NEXT_PUBLIC_SITE_URL)
 *
 * Production fallback when only localhost is configured:
 *   GALLERY_PUBLIC_URL_FALLBACK (default https://gidophotography.com)
 */

const LOCALHOST_RE =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

const GALLERY_PUBLIC_ORIGIN_HEADER = "x-gallery-public-origin"

const DEFAULT_PRODUCTION_GALLERY_BASE = "https://gidophotography.com"

function normalizeBaseUrl(raw) {
    return String(raw || "")
        .trim()
        .replace(/\/+$/, "")
}

function isLocalDevUrl(url) {
    return LOCALHOST_RE.test(normalizeBaseUrl(url))
}

function isProduction() {
    return String(process.env.NODE_ENV || "").toLowerCase() === "production"
}

function publicOriginFromRequest(req) {
    if (!req?.headers) return ""
    const raw =
        req.headers[GALLERY_PUBLIC_ORIGIN_HEADER] ??
        req.headers["X-Gallery-Public-Origin"]
    const v = Array.isArray(raw) ? raw[0] : raw
    return normalizeBaseUrl(v)
}

/**
 * Origin used for `/g/:id` links sent to clients.
 * @param {import("express").Request} [req]
 * @returns {string}
 */
export function resolveGalleryPublicBaseUrl(req) {
    const fromReq = publicOriginFromRequest(req)
    if (fromReq && !isLocalDevUrl(fromReq)) {
        return fromReq
    }

    const candidates = [
        process.env.GALLERY_PUBLIC_URL,
        process.env.PUBLIC_GALLERY_URL,
        process.env.FRONTEND_URL,
    ]
        .map(normalizeBaseUrl)
        .filter(Boolean)

    for (const url of candidates) {
        if (isProduction() && isLocalDevUrl(url)) continue
        return url
    }

    if (isProduction()) {
        return (
            normalizeBaseUrl(process.env.GALLERY_PUBLIC_URL_FALLBACK) ||
            DEFAULT_PRODUCTION_GALLERY_BASE
        )
    }

    return normalizeBaseUrl(process.env.FRONTEND_URL) || "http://localhost:3000"
}

/**
 * Builds the public gallery URL for a folder (same logic as folderController).
 * Kept in utils so SMS and other modules can use it without circular imports.
 * @param {object} folder
 * @param {string} [baseOverride]
 */
export const buildGalleryShareUrl = (folder, baseOverride) => {
    if (!folder?.share?.enabled) return ""
    const base = normalizeBaseUrl(baseOverride) || resolveGalleryPublicBaseUrl()
    if (!base) return ""
    const segment = String(process.env.FRONTEND_SHARE_PATH || "g")
        .replace(/^\/+|\/+$/g, "")
        .trim()
    const pathSeg = segment || "g"
    const id = folder.share.slug || folder.share.code
    return `${base}/${pathSeg}/${id}`
}

/** Logged at startup when production would have used a localhost FRONTEND_URL. */
export function galleryUrlConfigWarning() {
    const frontend = normalizeBaseUrl(process.env.FRONTEND_URL)
    const gallery = normalizeBaseUrl(process.env.GALLERY_PUBLIC_URL)
    if (!isProduction()) return null
    if (gallery) return null
    if (frontend && isLocalDevUrl(frontend)) {
        const resolved = resolveGalleryPublicBaseUrl()
        return (
            `FRONTEND_URL is ${frontend} but NODE_ENV=production — client gallery/SMS links use ${resolved} instead. ` +
            "Set GALLERY_PUBLIC_URL on the server to your live gallery origin (e.g. https://gidophotography.com)."
        )
    }
    return null
}
