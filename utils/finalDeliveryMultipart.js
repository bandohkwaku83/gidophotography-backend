/**
 * Multipart fields for final delivery uploads (admin UI flow).
 * Omit all → legacy behaviour (no payment state change).
 */

function truthyString(v) {
    if (v === undefined || v === null) return false
    const s = String(v).trim().toLowerCase()
    return ["true", "1", "yes", "y"].includes(s)
}

export function parseAmount(raw) {
    if (raw === undefined || raw === null) return null
    if (typeof raw === "number" && Number.isFinite(raw)) {
        if (raw <= 0) return null
        return Math.round(raw * 100) / 100
    }
    let s = String(raw).trim()
    if (!s) return null
    // Strip common labels / currency (GH₵, GHS, spaces)
    s = s.replace(/gh₵|ghs|cedis?/gi, "").replace(/\s+/g, "")
    // "500,50" (decimal comma) vs "1,500" (thousands) — if one comma and no dot, treat as decimal
    if (/^\d+,\d{1,2}$/.test(s)) s = s.replace(",", ".")
    else s = s.replace(/,/g, "")
    const n = Number.parseFloat(s, 10)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.round(n * 100) / 100
}

/** First non-empty body value for any of the keys (multipart / JSON). */
function firstBodyValue(body, keys) {
    for (const k of keys) {
        if (!Object.prototype.hasOwnProperty.call(body, k)) continue
        const v = body[k]
        if (v === undefined || v === null) continue
        if (typeof v === "string" && v.trim() === "") continue
        return v
    }
    return undefined
}

/**
 * Merge query + body and flatten `finalDelivery` JSON string (some UIs send one field).
 * @returns {Record<string, unknown>}
 */
function buildPaymentFieldSource(req) {
    const q = req.query && typeof req.query === "object" ? req.query : {}
    const b = req.body && typeof req.body === "object" ? req.body : {}
    let merged = { ...q, ...b }
    const fd = merged.finalDelivery
    if (typeof fd === "string" && fd.trim()) {
        try {
            const parsed = JSON.parse(fd)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                merged = { ...merged, ...parsed }
            }
        } catch (_) {
            /* ignore */
        }
    }
    return merged
}

/**
 * @returns {{ legacy: true } | { legacy: false, clientPaid: boolean, amountRemaining: number|null, lockImages: boolean }}
 */
export function readFinalDeliveryPaymentFromReq(req) {
    const body = buildPaymentFieldSource(req)
    const paidKeys = [
        "clientHasPaidForFinals",
        "client_has_paid_for_finals",
        "finalDeliveryClientPaid",
        "hasClientPaid",
        "clientPaid",
    ]
    let rawPaid
    for (const k of paidKeys) {
        if (Object.prototype.hasOwnProperty.call(body, k)) {
            rawPaid = body[k]
            break
        }
    }
    if (rawPaid === undefined || rawPaid === null || String(rawPaid).trim() === "") {
        return { legacy: true }
    }

    const clientPaid = truthyString(rawPaid)
    const amountRaw = firstBodyValue(body, [
        "amountRemainingGHS",
        "amount_remaining_ghs",
        "finalDeliveryAmountRemaining",
        "amountRemaining",
        "amount_remaining",
        "outstandingAmountGHS",
        "outstanding_amount_ghs",
        "outstandingAmount",
        "outstanding_balance",
        "balanceGHS",
        "balance",
        "amount",
    ])
    const lockRaw = firstBodyValue(body, [
        "lockImagesBeforeUpload",
        "lock_images_before_upload",
        "finalDeliveryLockImages",
        "lockImages",
        "lock_finals",
    ])
    const lockImages = truthyString(lockRaw)

    return {
        legacy: false,
        clientPaid,
        amountRemaining: clientPaid ? null : parseAmount(amountRaw),
        lockImages: clientPaid ? false : lockImages,
    }
}
