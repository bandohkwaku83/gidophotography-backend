import path from "path"

/** Video extensions (lowercase, with dot) — fallback when MIME is missing or octet-stream. */
export const ACCEPT_VIDEO_EXT = new Set([
    ".264",
    ".265",
    ".3g2",
    ".3gp",
    ".3gp2",
    ".3gpp",
    ".amv",
    ".asf",
    ".avi",
    ".braw",
    ".cine",
    ".dat",
    ".divx",
    ".drc",
    ".dv",
    ".f4v",
    ".flc",
    ".fli",
    ".flv",
    ".gxf",
    ".h264",
    ".h265",
    ".hevc",
    ".insv",
    ".isma",
    ".ismv",
    ".ismy",
    ".m1v",
    ".m2p",
    ".m2t",
    ".m2ts",
    ".m2v",
    ".m4p",
    ".m4v",
    ".mj2",
    ".mjpeg",
    ".mjpg",
    ".mk3d",
    ".mkv",
    ".mng",
    ".mod",
    ".mov",
    ".movie",
    ".mp2",
    ".mp4",
    ".mp4v",
    ".mpa",
    ".mpe",
    ".mpeg",
    ".mpeg2",
    ".mpeg4",
    ".mpg",
    ".mpv",
    ".mts",
    ".mxf",
    ".nut",
    ".nsv",
    ".ogm",
    ".ogg",
    ".ogv",
    ".ogx",
    ".qt",
    ".r3d",
    ".rm",
    ".rmvb",
    ".roq",
    ".svi",
    ".swf",
    ".tod",
    ".ts",
    ".tsa",
    ".tsv",
    ".vob",
    ".viv",
    ".webm",
    ".wm",
    ".wmv",
    ".wmx",
    ".wtv",
    ".wvx",
    ".xvid",
    ".y4m",
    ".yuv",
])

/** Some clients send video containers as application/* instead of video/*. */
export const VIDEO_APPLICATION_MIMES = new Set([
    "application/mp4",
    "application/x-mp4",
    "application/x-matroska",
    "application/vnd.rn-realmedia",
    "application/vnd.rn-realmedia-vbr",
    "application/x-flash-video",
    "application/x-shockwave-flash",
])

export function videoExtensionFromFilename(filename) {
    return path.extname(String(filename || "")).toLowerCase()
}

export function isVideoExtension(ext) {
    return ACCEPT_VIDEO_EXT.has(String(ext || "").toLowerCase())
}

/**
 * @param {{ mimeType?: string, filename?: string, originalname?: string }} file
 */
export function isVideoFile(file) {
    const mime = String(file?.mimeType || file?.mimetype || "")
        .toLowerCase()
        .trim()
    if (mime.startsWith("video/")) return true
    if (VIDEO_APPLICATION_MIMES.has(mime)) return true

    const ext = videoExtensionFromFilename(
        file?.filename || file?.originalname || ""
    )
    if (
        isVideoExtension(ext) &&
        (mime === "" || mime === "application/octet-stream")
    ) {
        return true
    }
    return false
}
