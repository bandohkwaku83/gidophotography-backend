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
 *
 * Uses `origin: string[] | true` (not a callback that returns false). A `false` callback makes
 * the cors package call `next()` without handling OPTIONS, which produces “no Allow-Origin” on preflight.
 */
export function buildCorsMiddleware() {
    const fromEnv = splitOrigins(process.env.CORS_ORIGINS)
    const allowList =
        fromEnv.length > 0
            ? fromEnv
            : process.env.NODE_ENV === "production"
              ? DEFAULT_PRODUCTION_ORIGINS
              : null

    const originOption = allowList === null ? true : allowList

    if (process.env.NODE_ENV === "production") {
        console.log(
            `[cors] allowed origins (${fromEnv.length ? "CORS_ORIGINS" : "built-in defaults"}): ${allowList.join(", ")}`
        )
    } else {
        console.log("[cors] development: all origins allowed (set NODE_ENV=production on the live API)")
    }

    return cors({
        origin: originOption,
        credentials: true,
        methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD"],
        // Omit to mirror Access-Control-Request-Headers from the browser (safest for custom headers).
        allowedHeaders: undefined,
        maxAge: 86_400,
    })
}
