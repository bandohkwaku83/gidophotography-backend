/**
 * Fix pasted .env lines where the value is literally `MONGO_URL=mongodb://...`.
 */
export function normalizeMongoConnectionString(raw) {
    let s = String(raw ?? "").trim()
    s = s.replace(/^export\s+/i, "").trim()
    let prev
    do {
        prev = s
        s = s.replace(/^MONGO_URL=/i, "").replace(/^MONGO_URI=/i, "").trim()
    } while (s !== prev)
    return s
}

export function mongoUrlFromEnv() {
    return normalizeMongoConnectionString(
        process.env.MONGO_URL || process.env.MONGO_URI || ""
    )
}
