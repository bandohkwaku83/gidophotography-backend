import multer from "multer"
import path from "path"
import fs from "fs"
import crypto from "crypto"
import dotenv from "dotenv"

dotenv.config()

const mbFromEnv = (key, fallbackMb) => {
    const n = Number(process.env[key])
    return Number.isFinite(n) && n > 0 ? n : fallbackMb
}

const MAX_FOLDER_FILE_MB = mbFromEnv("FOLDER_MAX_UPLOAD_MB", 500)
const MAX_COVER_AND_SETTINGS_MB = mbFromEnv("COVER_MAX_UPLOAD_MB", 50)

const buildStorage = (subdir) => {
    const dir = path.join("uploads", subdir)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

    return multer.diskStorage({
        destination: (req, file, cb) => cb(null, dir),
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname)
            const base = path
                .basename(file.originalname, ext)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(0, 40)
            const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`
            cb(null, `${base || "file"}-${unique}${ext}`)
        },
    })
}

const imageFileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true)
    cb(new Error("Only image files are allowed"))
}

export const uploadCover = multer({
    storage: buildStorage("covers"),
    fileFilter: imageFileFilter,
    limits: { fileSize: MAX_COVER_AND_SETTINGS_MB * 1024 * 1024 },
})

export const uploadSettingsImage = multer({
    storage: buildStorage("settings"),
    fileFilter: imageFileFilter,
    limits: { fileSize: MAX_COVER_AND_SETTINGS_MB * 1024 * 1024 },
})

const ACCEPT_IMAGE_EXT = new Set([
    ".jpg",
    ".jpeg",
    ".png",
    ".gif",
    ".webp",
    ".heic",
    ".heif",
    ".tif",
    ".tiff",
    ".bmp",
    ".dng",
    ".arw",
    ".cr2",
    ".cr3",
    ".nef",
    ".orf",
    ".rw2",
    ".raf",
])

const folderMediaFileFilter = (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) return cb(null, true)
    if (file.mimetype.startsWith("video/")) return cb(null, true)
    const ext = path.extname(file.originalname || "").toLowerCase()
    if (file.mimetype === "application/octet-stream" && ACCEPT_IMAGE_EXT.has(ext)) {
        return cb(null, true)
    }
    cb(
        new Error(
            `Unsupported file type (${file.mimetype}). Use images or common camera raw formats.`
        )
    )
}

const folderMediaStorage = (subKind) =>
    multer.diskStorage({
        destination: (req, file, cb) => {
            const folderId = req.params.id
            const dir = path.join(
                "uploads",
                "folders",
                folderId,
                subKind === "final" ? "finals" : "raw"
            )
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
            cb(null, dir)
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname)
            const base = path
                .basename(file.originalname, ext)
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .slice(0, 40)
            const unique = `${Date.now()}-${crypto.randomBytes(8).toString("hex")}`
            cb(null, `${base || "photo"}-${unique}${ext}`)
        },
    })

const MAX_FILES_PER_REQUEST = 1000
const MAX_FILE_SIZE_BYTES = MAX_FOLDER_FILE_MB * 1024 * 1024

const folderMediaLimits = {
    fileSize: MAX_FILE_SIZE_BYTES,
    files: MAX_FILES_PER_REQUEST,
    fieldSize: 2 * 1024 * 1024,
    fields: 200,
    parts: 32000,
}

const MULTIPART_FILE_FIELDS = [
    "file",
    "files",
    "file[]",
    "files[]",
    "photo",
    "photos",
    "photo[]",
    "photos[]",
    "image",
    "images",
    "image[]",
    "images[]",
]

const buildFolderMultipart = (subKind) =>
    multer({
        storage: folderMediaStorage(subKind),
        fileFilter: folderMediaFileFilter,
        limits: folderMediaLimits,
    }).fields(
        MULTIPART_FILE_FIELDS.map((name) => ({
            name,
            maxCount: MAX_FILES_PER_REQUEST,
        }))
    )

export const uploadFolderRaw = buildFolderMultipart("raw")
export const uploadFolderFinal = buildFolderMultipart("final")

export const collectFolderUploadFiles = (req) => {
    const out = []
    if (!req.files) return out
    if (Array.isArray(req.files)) {
        out.push(...req.files)
        return out.slice(0, MAX_FILES_PER_REQUEST)
    }
    for (const name of MULTIPART_FILE_FIELDS) {
        const chunk = req.files[name]
        if (!chunk) continue
        if (Array.isArray(chunk)) out.push(...chunk)
        else out.push(chunk)
    }
    return out.slice(0, MAX_FILES_PER_REQUEST)
}
