import fs from "fs"
import express from "express"
import mongoose from "mongoose"
import dotenv from "dotenv"
import path from "path"
import multer from "multer"
import authRoutes from "./routes/authRoutes.js"
import clientRoutes from "./routes/clientRoutes.js"
import folderRoutes from "./routes/folderRoutes.js"
import settingsRoutes from "./routes/settingsRoutes.js"
import shareRoutes from "./routes/shareRoutes.js"
import dashboardRoutes from "./routes/dashboardRoutes.js"
import smsRoutes from "./routes/smsRoutes.js"
import { mongoUrlFromEnv } from "./utils/mongoUrlFromEnv.js"
import { buildCorsMiddleware } from "./utils/corsMiddleware.js"
import { isObjectStorageS3 } from "./services/objectStorage.js"

// Explicit path so .env is loaded even if cwd differs; override beats empty shell exports
const envPath = path.join(process.cwd(), ".env")
const envLoaded = dotenv.config({ path: envPath, override: true })

const app = express()

app.use(buildCorsMiddleware())
app.use(express.json())

app.use("/uploads", express.static(path.join(process.cwd(), "uploads")))

app.get("/", (req, res) => {
    res.json({ message: "GidoStorage API is running" })
})

app.use("/api/auth", authRoutes)
app.use("/api/clients", clientRoutes)
app.use("/api/folders", folderRoutes)
app.use("/api/settings", settingsRoutes)
app.use("/api/share", shareRoutes)
app.use("/api/dashboard", dashboardRoutes)
app.use("/api/sms", smsRoutes)

app.use((err, req, res, next) => {
    if (err instanceof multer.MulterError) {
        const hints = {
            LIMIT_FILE_SIZE:
                "File exceeds FOLDER_MAX_UPLOAD_MB (default 500MB per file for gallery uploads). Raise it in .env or split the upload.",
            LIMIT_FILE_COUNT:
                "Too many files in one request. Max is 1000 per upload; send another batch if needed.",
            LIMIT_FIELD_COUNT:
                "Too many form fields in one multipart request. Try fewer files per batch.",
            LIMIT_PART_COUNT:
                "Too many multipart parts in one request. Upload in smaller batches (e.g. 150 images at a time).",
            LIMIT_UNEXPECTED_FILE:
                'Use a supported file field name: "files" or "files[]" (recommended for many), or file, file[], photo, photos[], image, images[]. Text fields like selectionMediaId are allowed next to files.',
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
