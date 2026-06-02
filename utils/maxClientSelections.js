/** @returns {null | number} null = unlimited */
export function getEffectiveMaxClientSelections(share) {
    const raw = share?.maxClientSelections
    if (raw === undefined || raw === null || raw === "") return null
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return null
    return Math.min(9999, Math.floor(n))
}

/**
 * Parse admin PATCH body value.
 * @returns {{ unchanged: true } | { value: null } | { value: number } | { error: string }}
 */
export function parseMaxClientSelectionsInput(raw) {
    if (raw === undefined) return { unchanged: true }
    if (raw === null || raw === "") return { value: null }
    const n =
        typeof raw === "number" && Number.isFinite(raw)
            ? raw
            : Number.parseInt(String(raw).trim(), 10)
    if (!Number.isFinite(n) || n === 0) return { value: null }
    if (n < 1 || n > 9999) {
        return {
            error: "maxClientSelections must be between 1 and 9999, or null/0 for unlimited.",
        }
    }
    return { value: Math.floor(n) }
}

export function selectionLimitExceededMessage(max) {
    const n = Math.floor(Number(max))
    return `You can select at most ${n} photo${n === 1 ? "" : "s"}.`
}
