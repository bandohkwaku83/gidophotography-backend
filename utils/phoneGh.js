/**
 * Normalizes a Ghana mobile number to Arkesel format: digits only, 233XXXXXXXXX (no leading +).
 */
export function normalizeGhanaMsisdn(input) {
    if (!input || typeof input !== "string") return null
    let digits = input.replace(/\D/g, "")
    if (digits.startsWith("0")) digits = "233" + digits.slice(1)
    if (!digits.startsWith("233")) return null
    if (digits.length < 12 || digits.length > 13) return null
    return digits
}

export function formatPhoneDisplay(digits) {
    if (!digits) return ""
    if (digits.startsWith("233")) return `+${digits}`
    return `+${digits}`
}
