import path from "path"

/** Escape a string for safe use inside a RegExp source (basename only). */
export function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Find existing folder media with the same original basename (case-insensitive).
 * Matches "IMG.jpg", "img.JPG", and "album/IMG.jpg" when basename matches.
 */
export async function findDuplicateFolderMedia(
    FolderMedia,
    folderId,
    kind,
    originalFilename
) {
    const bn = path.basename(String(originalFilename || "").trim() || "file")
    const regex = new RegExp(`(^|[\\\\/])${escapeRegex(bn)}$`, "i")
    return FolderMedia.findOne({
        folder: folderId,
        kind,
        originalFilename: regex,
    })
}
