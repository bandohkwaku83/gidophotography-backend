/**
 * Optional branding on every outgoing SMS (manual + upload triggers).
 *
 * - SMS_BRAND_PREFIX: optional line(s) before the message body.
 * - SMS_BRAND_SUFFIX: brand line(s), shown under "signed" below the body.
 * - SMS_BRAND_SIGNATURE_LABEL: word above the suffix (default: signed). Set to "none" for no label line.
 *
 * Layout when suffix is set:
 *   <main message>
 *
 *   signed
 *   GidoPhotography/weddings and vows
 *
 * Use quotes in .env when values contain spaces.
 */
export function applySmsBranding(message) {
    const prefix = stripOuterQuotes(process.env.SMS_BRAND_PREFIX)?.trim()
    const suffix = stripOuterQuotes(process.env.SMS_BRAND_SUFFIX)?.trim()

    let signLabel = "signed"
    const labelRaw = process.env.SMS_BRAND_SIGNATURE_LABEL
    if (labelRaw !== undefined && labelRaw !== null && String(labelRaw).trim() !== "") {
        const t = stripOuterQuotes(labelRaw)?.trim()
        signLabel = t.toLowerCase() === "none" ? "" : t
    }

    let out = String(message ?? "").trimEnd()
    if (!out && !prefix && !suffix) return ""

    if (prefix) out = out ? `${prefix}\n${out}` : prefix

    if (suffix) {
        const signatureBlock = signLabel
            ? `${signLabel}\n${suffix}`
            : suffix
        out = out ? `${out}\n\n${signatureBlock}` : signatureBlock
    }

    return out
}

/** dotenv may leave quotes in value depending on file format */
function stripOuterQuotes(raw) {
    if (raw === undefined || raw === null) return raw
    const s = String(raw)
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
        return s.slice(1, -1)
    }
    if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) {
        return s.slice(1, -1)
    }
    return s
}
