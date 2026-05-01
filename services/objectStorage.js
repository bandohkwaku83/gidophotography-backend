import fs from "fs"
import path from "path"
import {
    S3Client,
    PutObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
} from "@aws-sdk/client-s3"

let s3Client = null

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
        s3Client = new S3Client({ region: process.env.AWS_REGION })
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

export function publicUrlForStoredPath(req, storedPath) {
    const key = objectKeyFromStoredPath(storedPath)
    if (!key) return ""
    if (isObjectStorageS3()) {
        const base = publicBaseUrlForS3Assets()
        return `${base}/${encodeKeySegments(key)}`
    }
    return `${req.protocol}://${req.get("host")}/${key}`
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
