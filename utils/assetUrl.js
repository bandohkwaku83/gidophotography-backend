import { publicUrlForStoredPath } from "../services/objectStorage.js"

/** Public URL for a DB-stored path (`uploads/...`). Uses S3 when STORAGE_DRIVER=s3. */
export function buildPublicAssetUrl(req, filePath) {
    return publicUrlForStoredPath(req, filePath)
}
