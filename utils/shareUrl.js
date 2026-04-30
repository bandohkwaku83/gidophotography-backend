/**
 * Builds the public gallery URL for a folder (same logic as folderController).
 * Kept in utils so SMS and other modules can use it without circular imports.
 */
export const buildGalleryShareUrl = (folder) => {
    if (!folder?.share?.enabled) return ""
    const base = (process.env.FRONTEND_URL || "").replace(/\/+$/, "").trim()
    if (!base) return ""
    const segment = String(process.env.FRONTEND_SHARE_PATH || "share")
        .replace(/^\/+|\/+$/g, "")
        .trim()
    const pathSeg = segment || "share"
    const id = folder.share.slug || folder.share.code
    return `${base}/${pathSeg}/${id}`
}
