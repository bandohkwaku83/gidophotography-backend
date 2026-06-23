/**
 * Public client gallery links (SMS {{gallery_link}}, folder.shareUrl, etc.).
 *
 * Env (first non-empty, non-localhost wins):
 *   GALLERY_PUBLIC_URL — preferred for live client links (set on the VPS)
 *   PUBLIC_GALLERY_URL — alias
 *   FRONTEND_URL — legacy; skipped when localhost
 *
 * Fallback when only localhost (or nothing) is configured:
 *   GALLERY_PUBLIC_URL_FALLBACK (default https://gidophotography.com)
 *
 * Set GALLERY_USE_LOCALHOST_LINKS=true only for local gallery testing.
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
function galleryPublicUrlFallback() {
    return (
        normalizeBaseUrl(process.env.GALLERY_PUBLIC_URL_FALLBACK) ||
        DEFAULT_PRODUCTION_GALLERY_BASE
    )
}

function localhostGalleryBase() {
    return normalizeBaseUrl(process.env.FRONTEND_URL) || "http://localhost:3000"
}

function allowLocalhostGalleryLinks() {
    const v = String(process.env.GALLERY_USE_LOCALHOST_LINKS || "")
        .trim()
        .toLowerCase()
    return v === "1" || v === "true" || v === "yes"
}

export function resolveGalleryPublicBaseUrl() {
    const candidates = [
        process.env.GALLERY_PUBLIC_URL,
        process.env.PUBLIC_GALLERY_URL,
        process.env.FRONTEND_URL,
    ]
        .map(normalizeBaseUrl)
        .filter(Boolean)

    for (const url of candidates) {
        if (isLocalDevUrl(url)) continue
        return url
    }

    if (allowLocalhostGalleryLinks()) {
        return localhostGalleryBase()
    }

    return galleryPublicUrlFallback()
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

/** Logged at startup when client links would not use FRONTEND_URL as-is. */
export function galleryUrlConfigWarning() {
    const frontend = normalizeBaseUrl(process.env.FRONTEND_URL)
    const gallery = normalizeBaseUrl(process.env.GALLERY_PUBLIC_URL)
    if (gallery && !isLocalDevUrl(gallery)) return null
    if (!frontend || !isLocalDevUrl(frontend)) return null
    if (allowLocalhostGalleryLinks()) return null

    const resolved = resolveGalleryPublicBaseUrl()
    const envNote = isProduction()
        ? "NODE_ENV=production"
        : "GALLERY_USE_LOCALHOST_LINKS is not set"
    return (
        `FRONTEND_URL is ${frontend} (${envNote}) — client gallery/SMS links use ${resolved} instead. ` +
        "Set GALLERY_PUBLIC_URL to your live gallery origin (e.g. https://gidophotography.com)."
    )
}
