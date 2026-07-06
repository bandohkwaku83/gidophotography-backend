import Invoice from "../models/Invoice.js"

const INVOICE_NO_RE = /^INV-(\d{4})-(\d+)$/

export function formatInvoiceNo(year, seq) {
    return `INV-${year}-${seq}`
}

export function parseInvoiceNo(invoiceNo) {
    const m = String(invoiceNo ?? "").trim().match(INVOICE_NO_RE)
    if (!m) return null
    return { year: parseInt(m[1], 10), seq: parseInt(m[2], 10) }
}

/**
 * Next sequential invoice number for a photographer in the given calendar year.
 * @param {import("mongoose").Types.ObjectId} photographerId
 * @param {number} [year]
 */
export async function nextInvoiceSequence(photographerId, year = new Date().getFullYear()) {
    const prefix = `INV-${year}-`
    const rows = await Invoice.find({
        photographerId,
        invoiceNo: new RegExp(`^${prefix}`),
    })
        .select("invoiceNo")
        .lean()

    let maxSeq = 0
    for (const row of rows) {
        const parsed = parseInvoiceNo(row.invoiceNo)
        if (parsed && parsed.year === year && parsed.seq > maxSeq) {
            maxSeq = parsed.seq
        }
    }
    return maxSeq + 1
}

/**
 * @param {import("mongoose").Types.ObjectId} photographerId
 * @param {number} [year]
 */
export async function generateInvoiceNo(photographerId, year = new Date().getFullYear()) {
    const seq = await nextInvoiceSequence(photographerId, year)
    return formatInvoiceNo(year, seq)
}

/**
 * Preview the next invoice number without reserving it.
 * @param {import("mongoose").Types.ObjectId} photographerId
 */
export async function previewNextInvoiceNo(photographerId) {
    const year = new Date().getFullYear()
    const seq = await nextInvoiceSequence(photographerId, year)
    return formatInvoiceNo(year, seq)
}
