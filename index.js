import fs from "fs"
import express from "express"
import mongoose from "mongoose"
import dotenv from "dotenv"
import path from "path"
import multer from "multer"
import sharp from "sharp"
import { folderUploadMaxFilesPerRequest } from "./middleware/upload.js"
import authRoutes from "./routes/authRoutes.js"
import clientRoutes from "./routes/clientRoutes.js"
import folderRoutes from "./routes/folderRoutes.js"
import settingsRoutes from "./routes/settingsRoutes.js"
import shareRoutes from "./routes/shareRoutes.js"
import dashboardRoutes from "./routes/dashboardRoutes.js"
import usageRoutes from "./routes/usageRoutes.js"
import smsRoutes from "./routes/smsRoutes.js"
import bookingRoutes from "./routes/bookingRoutes.js"
import notificationRoutes from "./routes/notificationRoutes.js"
import { mongoUrlFromEnv } from "./utils/mongoUrlFromEnv.js"
import { buildCorsMiddleware } from "./utils/corsMiddleware.js"
import { isObjectStorageS3 } from "./services/objectStorage.js"
import { startBookingReminderCron } from "./services/bookingReminderJob.js"

// Explicit path so .env is loaded even if cwd differs; override beats empty shell exports
const envPath = path.join(process.cwd(), ".env")
const envLoaded = dotenv.config({ path: envPath, override: true })

const sharpConcurrency = Number(process.env.SHARP_CONCURRENCY)
if (
    Number.isFinite(sharpConcurrency) &&
    sharpConcurrency >= 1 &&
    sharpConcurrency <= 32
) {
    sharp.concurrency(Math.floor(sharpConcurrency))
}

const app = express()

app.use(buildCorsMiddleware())
/** Large duplicate-preview payloads (many long paths) exceed the old 100kb default. */
app.use(express.json({ limit: "12mb" }))

const uploadsCacheSecRaw = process.env.UPLOADS_CACHE_MAX_AGE_SEC
const uploadsCacheSec =
    uploadsCacheSecRaw === undefined || uploadsCacheSecRaw === ""
        ? 7 * 24 * 60 * 60
        : Number(uploadsCacheSecRaw)
const uploadsLongCache =
    Number.isFinite(uploadsCacheSec) && uploadsCacheSec > 0
const uploadsStaticOpts = {
    etag: true,
    lastModified: true,
    ...(uploadsLongCache
        ? { maxAge: uploadsCacheSec * 1000, immutable: true }
        : {}),
}
app.use(
    "/uploads",
    express.static(path.join(process.cwd(), "uploads"), uploadsStaticOpts)
)

app.get("/", (req, res) => {
    res.json({ message: "GidoStorage API is running" })
})

app.use("/api/auth", authRoutes)
app.use("/api/clients", clientRoutes)
app.use("/api/folders", folderRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/share", shareRoutes)
app.use("/api/dashboard", dashboardRoutes)
app.use("/api/usage", usageRoutes)
app.use("/api/sms", smsRoutes)
app.use("/api/bookings", bookingRoutes)
app.use("/api/notifications", notificationRoutes)

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const hints = {
            LIMIT_FILE_SIZE:
                err.field === "backgroundMusic"
                    ? "Audio file exceeds GALLERY_MUSIC_MAX_UPLOAD_MB (default 40MB). Raise GALLERY_MUSIC_MAX_UPLOAD_MB in .env or use a shorter track."
                    : "File exceeds FOLDER_MAX_UPLOAD_MB (default 500MB per file for gallery uploads). Raise it in .env or split the upload.",
            LIMIT_FILE_COUNT:
                `Too many files in one request. Max is ${folderUploadMaxFilesPerRequest} per upload (FOLDER_MAX_FILES_PER_UPLOAD in .env); send another batch if needed.`,
            LIMIT_FIELD_COUNT:
                "Too many non-file fields in one multipart request. Reduce extra form fields or split the batch.",
            LIMIT_PART_COUNT:
                `Too many multipart parts in one request. Try splitting the upload or lowering FOLDER_MAX_FILES_PER_UPLOAD (current max files: ${folderUploadMaxFilesPerRequest}).`,
            LIMIT_UNEXPECTED_FILE:
                'Use a supported file field name: "files" or "files[]" (recommended for many), or file, file[], photo, photos[], image, images[], video, videos[]. Text fields like selectionMediaId are allowed next to files.',
        }
        return res.status(400).json({
            message: err.message,
            code: err.code,
            hint: hints[err.code] || null,
        })
    }
    if (err && typeof err.message === "string") {
        if (err.message.includes("Unsupported file type")) {
            return res.status(400).json({ message: err.message })
        }
        if (err.message.includes("Only audio files are allowed")) {
            return res.status(400).json({ message: err.message })
        }
    }
    next(err)
})

app.use((err, req, res, next) => {
    console.error(err)
    res.status(500).json({ message: "Server error" })
})

const PORT = process.env.PORT || 7000
const MONGO_URL = mongoUrlFromEnv()

if (!MONGO_URL) {
    const exists = fs.existsSync(envPath)
    const bytes = exists ? fs.statSync(envPath).size : 0
    const parsedKeys = envLoaded.parsed
        ? Object.keys(envLoaded.parsed).length
        : 0
    console.error(
        "MONGO_URL is not set. This app reads MONGO_URL (or MONGO_URI) from .env."
    )
    console.error(
        `  File: ${envPath} — ${exists ? `exists (${bytes} bytes)` : "missing"}; dotenv parsed ${parsedKeys} key(s).`
    )
    if (exists && bytes > 0 && parsedKeys === 0) {
        console.error(
            '  Fix: use exactly one line per variable, e.g. MONGO_URL=mongodb+srv://user:pass@host/db — no leading "export ", no JSON, no bare URI without the variable name.'
        )
    }
    if (envLoaded.error && !exists) {
        console.error(`  ${envLoaded.error.message}`)
    }
    process.exit(1)
}

const mongoSchemeOk = /^mongodb(\+srv)?:\/\//i.test(MONGO_URL)
if (!mongoSchemeOk) {
    const head = MONGO_URL.slice(0, 48).replace(/\s/g, " ")
    console.error(
        "MONGO_URL must start with mongodb:// or mongodb+srv:// (MongoDB Node driver requirement)."
    )
    console.error(
        `  Check .env: one line only, e.g. MONGO_URL=mongodb+srv://user:pass@host/db — do not put the key name inside the value (not MONGO_URL=\"MONGO_URL=...\").`
    )
    console.error(
        `  After normalizing stray prefixes, value begins with: ${head ? JSON.stringify(head) : "(empty)"}`
    )
    process.exit(1)
}

mongoose
    .connect(MONGO_URL)
    .then(() => {
        console.log("Connected to MongoDB")
        startBookingReminderCron()
        if (isObjectStorageS3()) {
            console.log(
                `[storage] S3: bucket=${process.env.S3_BUCKET} region=${process.env.AWS_REGION}`
            )
        } else {
            console.log(
                "[storage] Local disk (./uploads). For S3 set STORAGE_DRIVER=s3, S3_BUCKET, AWS_REGION."
            )
        }
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`)
        })
    })
    .catch((error) => {
        console.error(error)
        if (error?.code === "ENOTFOUND" && error?.syscall === "querySrv") {
            console.error(
                "MongoDB SRV lookup failed: the host after @ in MONGO_URL must be a real DNS name " +
                    "(e.g. cluster0.xxxxx.mongodb.net from Atlas). Short names or typos cause ENOTFOUND. " +
                    "For local MongoDB use mongodb://127.0.0.1:27017/yourdb instead of mongodb+srv://."
            )
        }
        if (error?.name === "MongoParseError") {
            console.error(
                "MongoParseError: fix MONGO_URL in .env — use mongodb://host:port/db or mongodb+srv://user:pass@cluster.../db from Atlas."
            )
        }
        process.exit(1)
    })
