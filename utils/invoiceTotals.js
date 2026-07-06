export function roundGhs(n) {
    return Math.round(n * 100) / 100
}

/**
 * @param {{ quantity: number, unitPriceGHS: number }[]} items
 * @param {number} taxRate
 */
export function computeInvoiceTotals(items, taxRate = 0) {
    const subtotalGHS = roundGhs(
        items.reduce(
            (sum, item) => sum + Number(item.quantity) * Number(item.unitPriceGHS),
            0
        )
    )
    const rate = Number.isFinite(Number(taxRate)) ? Math.max(0, Number(taxRate)) : 0
    const taxGHS = roundGhs(subtotalGHS * rate)
    const totalGHS = roundGhs(subtotalGHS + taxGHS)
    return { subtotalGHS, taxGHS, totalGHS }
}

/**
 * @param {number | undefined | null} amountPayingGHS
 * @param {number} totalGHS
 */
export function paymentStatusFromAmounts(amountPayingGHS, totalGHS) {
    const raw = Number(amountPayingGHS ?? 0)
    const paid = roundGhs(
        Math.min(Math.max(0, Number.isFinite(raw) ? raw : 0), totalGHS)
    )
    if (paid <= 0) {
        return { amountPayingGHS: 0, paymentStatus: "pending", paymentPercent: 0 }
    }
    if (paid >= totalGHS) {
        return { amountPayingGHS: paid, paymentStatus: "paid", paymentPercent: 100 }
    }
    const paymentPercent =
        totalGHS > 0 ? Math.round((paid / totalGHS) * 100) : 0
    return { amountPayingGHS: paid, paymentStatus: "partial", paymentPercent }
}
