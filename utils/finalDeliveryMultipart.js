/**
 * Multipart fields for final delivery uploads (admin UI flow).
 * Omit all → legacy behaviour (no payment state change).
 */

function truthyString(v) {
    if (v === undefined || v === null) return false
    const s = String(v).trim().toLowerCase()
    return ["true", "1", "yes", "y"].includes(s)
}

function parseAmount(raw) {
    if (raw === undefined || raw === null || String(raw).trim() === "") {
        return null
    }
    const n = Number.parseFloat(String(raw).trim(), 10)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n * 100) / 100
}

/**
 * @returns {{ legacy: true } | { legacy: false, clientPaid: boolean, amountRemaining: number|null, lockImages: boolean }}
 */
export function readFinalDeliveryPaymentFromReq(req) {
    const body = req.body || {}
    const keys = [
        "clientHasPaidForFinals",
        "client_has_paid_for_finals",
        "finalDeliveryClientPaid",
    ]
    let rawPaid
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
            rawPaid = body[k]
            break
        }
    }
    if (rawPaid === undefined || rawPaid === null || String(rawPaid).trim() === "") {
        return { legacy: true }
    }

    const clientPaid = truthyString(rawPaid)
    const amountRaw =
        body.amountRemainingGHS ??
        body.amount_remaining_ghs ??
        body.finalDeliveryAmountRemaining
    const lockImages = truthyString(
        body.lockImagesBeforeUpload ??
            body.lock_images_before_upload ??
            body.finalDeliveryLockImages
    )

    return {
        legacy: false,
        clientPaid,
        amountRemaining: clientPaid ? null : parseAmount(amountRaw),
        lockImages: clientPaid ? false : lockImages,
    }
}
