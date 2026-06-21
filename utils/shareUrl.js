/**
 * Public client gallery links (SMS {{gallery_link}}, folder.shareUrl, etc.).
 *
 * Env (first non-empty wins):
 *   GALLERY_PUBLIC_URL — preferred for live client links (set on the VPS)
 *   PUBLIC_GALLERY_URL — alias
 *   FRONTEND_URL — legacy; ignored in production when localhost
 *
 * Production fallback when only localhost is configured:
 *   GALLERY_PUBLIC_URL_FALLBACK (default https://gidophotography.com)
 */

const LOCALHOST_RE =
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i

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

/**
 * Origin used for `/share/:id` links sent to clients.
 * @returns {string}
 */
export function resolveGalleryPublicBaseUrl() {
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
 */
export const buildGalleryShareUrl = (folder) => {
    if (!folder?.share?.enabled) return ""
    const base = resolveGalleryPublicBaseUrl()
    if (!base) return ""
    const segment = String(process.env.FRONTEND_SHARE_PATH || "share")
        .replace(/^\/+|\/+$/g, "")
        .trim()
    const pathSeg = segment || "share"
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
