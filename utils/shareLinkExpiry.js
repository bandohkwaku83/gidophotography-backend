/** Presets for the client gallery link expiry dropdown (ids match API `linkExpiry`). */
export const SHARE_LINK_EXPIRY_PRESETS = [
    { id: "never", label: "Never", days: null },
    { id: "7d", label: "7 days", days: 7 },
    { id: "14d", label: "14 days", days: 14 },
    { id: "30d", label: "30 days", days: 30 },
    { id: "60d", label: "60 days", days: 60 },
    { id: "90d", label: "90 days", days: 90 },
    { id: "180d", label: "180 days", days: 180 },
    { id: "365d", label: "1 year", days: 365 },
]

const PRESET_DAY_MAP = Object.fromEntries(
    SHARE_LINK_EXPIRY_PRESETS.filter((p) => p.days != null).map((p) => [
        p.id,
        p.days,
    ])
)

/**
 * @param {Record<string, unknown>} body
 * @returns {{ unchanged?: true, error?: string, expiresAt?: Date|null, preset?: string|null }}
 */
export function resolveShareExpiryInput(body) {
    if (!body || typeof body !== "object") return { unchanged: true }

    if (Object.prototype.hasOwnProperty.call(body, "expiresAt")) {
        const raw = body.expiresAt
        if (raw === null || raw === undefined || raw === "") {
            return { expiresAt: null, preset: "never" }
        }
        const s =
            typeof raw === "string"
                ? raw.trim()
                : String(raw).trim()
        if (
            !s ||
            s === "null" ||
            s === "undefined" ||
            s.toLowerCase() === "invalid date"
        ) {
            return { expiresAt: null, preset: "never" }
        }
        let d = new Date(s)
        if (Number.isNaN(d.getTime()) && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
            d = new Date(`${s}T23:59:59.999Z`)
        }
        if (Number.isNaN(d.getTime())) {
            return { error: "Invalid expiresAt — use an ISO date string" }
        }
        return { expiresAt: d, preset: "custom" }
    }

    const key = body.linkExpiry ?? body.expiresPreset
    if (key !== undefined && key !== null && key !== "") {
        const k = String(key).trim()
        if (k === "never") return { expiresAt: null, preset: "never" }
        const days = PRESET_DAY_MAP[k]
        if (days != null) {
            return { expiresAt: new Date(Date.now() + days * 864e5), preset: k }
        }
        return {
            error: `Unknown linkExpiry "${k}". See GET /api/folders/share-link-expiry-presets for valid ids.`,
        }
    }

    if (body.expiresInDays !== undefined && body.expiresInDays !== null) {
        const n = Number(body.expiresInDays)
        if (!Number.isFinite(n) || n <= 0) {
            return { error: "expiresInDays must be a positive number" }
        }
        return {
            expiresAt: new Date(Date.now() + n * 864e5),
            preset: "custom_days",
        }
    }

    return { unchanged: true }
}

export function hasShareExpiryInput(body) {
    if (!body || typeof body !== "object") return false
    if (Object.prototype.hasOwnProperty.call(body, "expiresAt")) return true
    if (body.linkExpiry !== undefined && body.linkExpiry !== null) return true
    if (body.expiresPreset !== undefined && body.expiresPreset !== null)
        return true
    if (body.expiresInDays !== undefined && body.expiresInDays !== null)
        return true
    return false
}
