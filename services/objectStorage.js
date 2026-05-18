import fs from "fs"
import path from "path"
import https from "https"
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3"
import { NodeHttpHandler } from "@smithy/node-http-handler"

let s3Client = null

const s3MaxSockets = (() => {
    const n = Number(process.env.S3_MAX_SOCKETS)
    if (Number.isFinite(n) && n >= 1) return Math.min(128, Math.floor(n))
    return 48
})()

const s3HttpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: s3MaxSockets,
})

/** Browser + CDN caching for uploaded gallery assets (immutable keys). Override via S3_OBJECT_CACHE_CONTROL. */
const s3UploadCacheControl =
    process.env.S3_OBJECT_CACHE_CONTROL?.trim() ||
    "public, max-age=31536000, immutable"

export function isObjectStorageS3() {
    const driver = String(process.env.STORAGE_DRIVER || "")
        .toLowerCase()
        .trim()
    if (driver !== "s3") return false
    return Boolean(
        process.env.S3_BUCKET?.trim() && process.env.AWS_REGION?.trim()
    )
}

function getS3() {
    if (!s3Client) {
        s3Client = new S3Client({
            region: process.env.AWS_REGION,
            requestHandler: new NodeHttpHandler({ httpsAgent: s3HttpsAgent }),
        })
    }
    return s3Client
}

export function objectKeyFromStoredPath(storedPath) {
    return String(storedPath || "")
        .replace(/\\/g, "/")
        .replace(/^\//, "")
}

export function publicBaseUrlForS3Assets() {
    const custom = process.env.S3_PUBLIC_BASE_URL?.trim()
    if (custom) return custom.replace(/\/$/, "")
    const bucket = process.env.S3_BUCKET?.trim()
    const region = process.env.AWS_REGION?.trim()
    return `https://${bucket}.s3.${region}.amazonaws.com`
}

function encodeKeySegments(key) {
    return key.split("/").filter(Boolean).map(encodeURIComponent).join("/")
}

/**
 * Absolute base used for local-disk upload URLs (`uploads/...`) in JSON responses.
 * Set when the API sits behind nginx/PM2 but clients must fetch files from another public origin.
 */
export function publicBaseUrlLocalUploads(req) {
    const forced =
        process.env.UPLOAD_PUBLIC_BASE_URL?.trim() ||
        process.env.PUBLIC_API_URL?.trim()
    if (forced) return forced.replace(/\/$/, "")
    try {
        if (req?.get?.("host")) {
            const proto =
                typeof req.protocol === "string" && req.protocol
                    ? req.protocol
                    : "http"
            return `${proto}://${req.get("host")}`
        }
    } catch (_) {}
    return ""
}

export function publicUrlForStoredPath(req, storedPath) {
    const key = objectKeyFromStoredPath(storedPath)
    if (!key) return ""
    if (isObjectStorageS3()) {
        const base = publicBaseUrlForS3Assets()
        return `${base}/${encodeKeySegments(key)}`
    }
    const baseUrl = publicBaseUrlLocalUploads(req)
    if (!baseUrl) return ""
    return `${baseUrl}/${encodeKeySegments(key)}`
}

export function resolveLocalAbsolutePath(storedPath) {
    const key = objectKeyFromStoredPath(storedPath)
    if (!key) return ""
    return path.resolve(process.cwd(), key)
}

/** Multer writes to an absolute path; remove the temp file only (not the DB logical path). */
export function unlinkLocalTempFile(absPath) {
    if (!absPath) return
    try {
        if (fs.existsSync(absPath)) fs.unlinkSync(absPath)
    } catch (_) {}
}

/** Remove a stored asset: S3 object key or local file under cwd. */
export async function deleteStoredAsset(storedPath) {
    const key = objectKeyFromStoredPath(storedPath)
    if (!key) return
    if (isObjectStorageS3()) {
        await getS3()
            .send(
                new DeleteObjectCommand({
                    Bucket: process.env.S3_BUCKET,
                    Key: key,
                })
            )
            .catch(() => {})
        return
    }
    const full = path.resolve(process.cwd(), key)
    try {
        if (fs.existsSync(full)) fs.unlinkSync(full)
    } catch (_) {}
}

/**
 * Upload a file that currently exists on local disk to S3 under `storedPath` key, then delete the local file.
 * No-op when not using S3.
 */
export async function uploadLocalFileThenRemove(
    localAbsolutePath,
    storedPath,
    contentType
) {
    if (!isObjectStorageS3()) return
    const Key = objectKeyFromStoredPath(storedPath)
    if (!Key || !localAbsolutePath) return
    const stat = await fs.promises.stat(localAbsolutePath)
    const stream = fs.createReadStream(localAbsolutePath)
    await getS3().send(
        new PutObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key,
            Body: stream,
            ContentLength: stat.size,
            ContentType: contentType || "application/octet-stream",
            CacheControl: s3UploadCacheControl,
        })
    )
    await fs.promises.unlink(localAbsolutePath).catch(() => {})
}

export async function getObjectStreamForStoredPath(storedPath) {
    const Key = objectKeyFromStoredPath(storedPath)
    if (!Key) return null
    const out = await getS3().send(
        new GetObjectCommand({
            Bucket: process.env.S3_BUCKET,
            Key,
        })
    )
    return out
}

const DEFAULT_MAX_BUFFER_READ_BYTES = 45 * 1024 * 1024

/**
 * Read a stored object fully into memory with a size cap (e.g. locked final preview).
 * @returns {{ ok: true, buffer: Buffer } | { ok: false, error: string }}
 */
export async function readStoredAssetBufferLimited(
    storedPath,
    maxBytes = DEFAULT_MAX_BUFFER_READ_BYTES
) {
    const key = objectKeyFromStoredPath(storedPath)
    if (!key) return { ok: false, error: "missing_path" }

    if (isObjectStorageS3()) {
        const out = await getObjectStreamForStoredPath(storedPath)
        if (!out?.Body) return { ok: false, error: "not_found" }
        const len = out.ContentLength
        if (len != null && len > maxBytes) return { ok: false, error: "too_large" }
        const chunks = []
        let total = 0
        for await (const chunk of out.Body) {
            total += chunk.length
            if (total > maxBytes) return { ok: false, error: "too_large" }
            chunks.push(chunk)
        }
        return { ok: true, buffer: Buffer.concat(chunks) }
    }

    const abs = resolveLocalAbsolutePath(storedPath)
    if (!abs || !fs.existsSync(abs)) return { ok: false, error: "not_found" }
    const stat = await fs.promises.stat(abs)
    if (stat.size > maxBytes) return { ok: false, error: "too_large" }
    const buffer = await fs.promises.readFile(abs)
    return { ok: true, buffer }
}
