import dotenv from "dotenv"

dotenv.config()

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

function envTruthy(key) {
    const v = process.env[key]
    if (v === undefined || v === null || String(v).trim() === "") return false
    const s = String(v).toLowerCase().trim()
    return ["true", "1", "yes", "on"].includes(s)
}

/**
 * Whether to queue client SMS after this upload batch.
 *
 * Default (SMS_UPLOAD_NOTIFY_REQUIRE_EXPLICIT_COMPLETE unset/false):
 * - Omitted / empty → **true** (notify after this batch), same as before.
 * - Set **uploadComplete=false** on intermediate HTTP batches when splitting
 *   many files across several requests; set **uploadComplete=true** (or omit
 *   on the last batch only) so the client gets **one** SMS after the final batch.
 *
 * When env SMS_UPLOAD_NOTIFY_REQUIRE_EXPLICIT_COMPLETE=true:
 * - Omitted / empty → **false** (no SMS). You must send uploadComplete=true on
 *   the last batch only — guarantees a single SMS for chunked uploads if the
 *   UI always sends false until the final POST.
 */
export function readUploadCompleteNotify(req) {
    const requireExplicit = envTruthy("SMS_UPLOAD_NOTIFY_REQUIRE_EXPLICIT_COMPLETE")
    const v = req.body?.uploadComplete

    if (requireExplicit) {
        if (v === undefined || v === null || String(v).trim() === "") return false
        if (typeof v === "boolean") return v
        const s = String(v).toLowerCase().trim()
        return ["true", "1", "yes", "on"].includes(s)
    }

    if (v === undefined || v === null || String(v).trim() === "") return true
    if (typeof v === "boolean") return v
    const s = String(v).toLowerCase().trim()
    if (["false", "0", "no", "off"].includes(s)) return false
    return true
}

/**
 * How to handle uploads whose basename matches an existing file in the same gallery (same kind).
 * Multipart text field: duplicateAction or onDuplicate.
 * @returns {"replace"|"ignore"|null} null = invalid explicit value; default "ignore" when omitted.
 */
export function readDuplicateAction(req) {
    const v = req.body?.duplicateAction ?? req.body?.onDuplicate
    if (v === undefined || v === null || String(v).trim() === "") return "ignore"
    const s = String(v).toLowerCase().trim()
    if (s === "replace" || s === "ignore") return s
    return null
}
