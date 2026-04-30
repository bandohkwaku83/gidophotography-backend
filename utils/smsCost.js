/** GH₵ shown per message when Arkesel does not return local currency. */
export function parseSmsCostPerMessage() {
    const raw = process.env.SMS_COST_PER_MESSAGE_GHS
    if (raw === undefined || raw === "") return 0.05
    const n = parseFloat(raw)
    return Number.isFinite(n) ? n : 0.05
}
