import cors from "cors"

/** Used when `CORS_ORIGINS` is unset in production (override with env for extra domains). */
const DEFAULT_PRODUCTION_ORIGINS = ["https://admin.gidophotography.com"]

function splitOrigins(raw) {
    return String(raw || "")
        .split(",")
        .map((o) => o.trim().replace(/\/$/, ""))
        .filter(Boolean)
}

/**
 * Browser calls from `admin.*` to `api.*` are cross-origin; Express must answer OPTIONS and
 * send `Access-Control-Allow-*`. Set `CORS_ORIGINS` to a comma-separated list to override defaults.
 */
export function buildCorsMiddleware() {
    const fromEnv = splitOrigins(process.env.CORS_ORIGINS)
    const allowList =
        fromEnv.length > 0
            ? fromEnv
            : process.env.NODE_ENV === "production"
              ? DEFAULT_PRODUCTION_ORIGINS
              : null

    return cors({
        origin(origin, callback) {
            if (!origin) {
                return callback(null, true)
            }
            if (allowList === null) {
                return callback(null, true)
            }
            const normalized = origin.replace(/\/$/, "")
            if (allowList.includes(normalized)) {
                return callback(null, true)
            }
            callback(null, false)
        },
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allowedHeaders: ["Content-Type", "Authorization"],
        maxAge: 86_400,
    })
}
