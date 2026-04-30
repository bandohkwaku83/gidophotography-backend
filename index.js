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

// Load .env from cwd; override so empty shell exports don't hide values from .env
dotenv.config({ override: true })

const app = express()

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
const MONGO_URL = process.env.MONGO_URL

mongoose
    .connect(MONGO_URL)
    .then(() => {
        console.log("Connected to MongoDB")
        app.listen(PORT, () => {
            console.log(`Server is running on port ${PORT}`)
        })
    })
    .catch((error) => {
        console.log(error)
    })
