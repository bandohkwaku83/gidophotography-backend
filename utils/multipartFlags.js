/**
 * Multer places non-file fields on req.body.
 * @deprecated Prefer readUploadCompleteNotify for upload SMS gating.
 */
export function readMultipartBoolean(req, key) {
    const v = req.body?.[key]
    if (v === undefined || v === null || String(v).trim() === "") return false
    if (typeof v === "boolean") return v
    const s = String(v).toLowerCase().trim()
    return ["true", "1", "yes", "on"].includes(s)
}

/**
 * Whether to queue client SMS after this upload batch.
 * Defaults to true when omitted so normal uploads notify without an extra field.
 * Set uploadComplete=false on intermediate batches when splitting across requests.
 */
export function readUploadCompleteNotify(req) {
    const v = req.body?.uploadComplete
    if (v === undefined || v === null || String(v).trim() === "") return true
    if (typeof v === "boolean") return v
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}
