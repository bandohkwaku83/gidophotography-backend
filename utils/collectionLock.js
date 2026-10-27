import crypto from "crypto"
import jwt from "jsonwebtoken"
import FolderSet from "../models/FolderSet.js"

/** Crockford-like alphabet: no 0/O or 1/I, so a photographer can read the code aloud. */
export const ACCESS_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const ACCESS_CODE_LENGTH = 6

export const SET_ACCESS_COOKIE = "gido_set_access"
const SET_ACCESS_TYP = "set-access"
/** Chrome drops cookies whose Max-Age is longer than 400 days. */
const MAX_UNLOCK_TTL_SEC = 400 * 24 * 60 * 60
const UNLOCK_FAIL_LIMIT = 8
const UNLOCK_FAIL_WINDOW_MS = 15 * 60 * 1000

const unlockFailures = new Map()

export function generateAccessCode() {
    let code = ""
    for (let i = 0; i < ACCESS_CODE_LENGTH; i++) {
        code += ACCESS_CODE_ALPHABET[crypto.randomInt(ACCESS_CODE_ALPHABET.length)]
    }
    return code
}

export function accessCodesMatch(provided, stored) {
    const a = Buffer.from(String(provided ?? "").trim().toUpperCase())
    const b = Buffer.from(String(stored ?? "").trim().toUpperCase())
    if (a.length === 0 || a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
}

export function normalizeAccessCodeVersion(value) {
    const n = Number(value)
    if (Number.isFinite(n) && n >= 1) return Math.floor(n)
    return 1
}

export function shareSetCookiePath(identifier) {
    return `/api/share/${encodeURIComponent(String(identifier))}`
}

export function setAccessTtlSeconds(folder) {
    const exp = folder?.share?.expiresAt
    if (exp) {
        const sec = Math.floor((new Date(exp).getTime() - Date.now()) / 1000)
        if (Number.isFinite(sec) && sec > 0) return Math.min(sec, MAX_UNLOCK_TTL_SEC)
    }
    return MAX_UNLOCK_TTL_SEC
}

export function setAccessCookieOptions(identifier, ttlSec) {
    return {
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: shareSetCookiePath(identifier),
        maxAge: ttlSec * 1000,
    }
}

function jwtSecret() {
    const secret = process.env.JWT_SECRET
    if (!secret || !String(secret).trim()) return ""
    return secret
}

export function signSetAccessToken(identifier, sets, ttlSec) {
    const secret = jwtSecret()
    if (!secret) {
        const err = new Error("JWT_SECRET is not configured")
        err.status = 500
        throw err
    }
    return jwt.sign(
        {
            typ: SET_ACCESS_TYP,
            shareToken: String(identifier),
            sets,
        },
        secret,
        { algorithm: "HS256", expiresIn: ttlSec }
    )
}

export function decodeSetAccessToken(token, identifier) {
    const secret = jwtSecret()
    if (!secret || !token) return null
    try {
        const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] })
        if (decoded?.typ !== SET_ACCESS_TYP) return null
        if (decoded.shareToken !== String(identifier)) return null
        if (!Array.isArray(decoded.sets)) return null
        return decoded
    } catch {
        return null
    }
}

export function readRequestCookie(req, name) {
    const header = req?.headers?.cookie
    if (!header || typeof header !== "string") return ""
    for (const part of header.split(";")) {
        const idx = part.indexOf("=")
        if (idx === -1) continue
        const key = part.slice(0, idx).trim()
        if (key !== name) continue
        const raw = part.slice(idx + 1).trim()
        try {
            return decodeURIComponent(raw)
        } catch {
            return raw
        }
    }
    return ""
}

/**
 * Sets whose stored code version still matches this browser's unlock cookie.
 * @param {Array<{ _id: unknown, locked?: boolean, accessCodeVersion?: number }>} sets
 */
export function unlockedSetIdsFromToken(decoded, sets) {
    const unlocked = new Set()
    if (!decoded) return unlocked
    const byId = new Map((sets || []).map((set) => [String(set._id), set]))
    for (const entry of decoded.sets) {
        if (!entry?.setId) continue
        const row = byId.get(String(entry.setId))
        if (!row?.locked) continue
        if (Number(entry.accessCodeVersion) !== normalizeAccessCodeVersion(row.accessCodeVersion)) {
            continue
        }
        unlocked.add(String(entry.setId))
    }
    return unlocked
}

export function mergeUnlockedSets(previousEntries, sets, unlockedSet) {
    const byId = new Map((sets || []).map((set) => [String(set._id), set]))
    const unlockedId = String(unlockedSet._id)
    const next = []
    for (const entry of previousEntries || []) {
        const id = String(entry?.setId || "")
        if (!id || id === unlockedId) continue
        const row = byId.get(id)
        if (!row?.locked) continue
        const version = normalizeAccessCodeVersion(row.accessCodeVersion)
        if (Number(entry.accessCodeVersion) !== version) continue
        next.push({ setId: id, accessCodeVersion: version })
    }
    next.push({
        setId: unlockedId,
        accessCodeVersion: normalizeAccessCodeVersion(unlockedSet.accessCodeVersion),
    })
    return next
}

export async function loadShareSetAccess(req, folder, identifier) {
    const sets = await FolderSet.find({
        folder: folder._id,
        deletedAt: null,
    })
        .select("_id locked accessCodeVersion")
        .lean()

    const token = readRequestCookie(req, SET_ACCESS_COOKIE)
    const decoded = decodeSetAccessToken(token, identifier)
    const unlockedSetIds = unlockedSetIdsFromToken(decoded, sets)
    const hiddenSetIds = new Set()
    for (const set of sets) {
        const id = String(set._id)
        if (set.locked && !unlockedSetIds.has(id)) hiddenSetIds.add(id)
    }
    return { sets, unlockedSetIds, hiddenSetIds }
}

function pruneUnlockFailures(now) {
    if (unlockFailures.size < 5000) return
    for (const [key, entry] of unlockFailures) {
        if (entry.resetAt <= now) unlockFailures.delete(key)
    }
}

export function unlockFailureKey(req, identifier, setId) {
    const ip = req?.ip || req?.socket?.remoteAddress || "unknown"
    return `${ip}|${identifier}|${setId}`
}

export function unlockAttemptLimited(key) {
    const now = Date.now()
    const entry = unlockFailures.get(key)
    if (!entry || entry.resetAt <= now) return { limited: false, retryAfterSec: 0 }
    if (entry.count < UNLOCK_FAIL_LIMIT) return { limited: false, retryAfterSec: 0 }
    return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
}

export function recordUnlockFailure(key) {
    const now = Date.now()
    pruneUnlockFailures(now)
    const entry = unlockFailures.get(key)
    if (!entry || entry.resetAt <= now) {
        unlockFailures.set(key, { count: 1, resetAt: now + UNLOCK_FAIL_WINDOW_MS })
        return { limited: false, retryAfterSec: 0 }
    }
    entry.count += 1
    if (entry.count < UNLOCK_FAIL_LIMIT) return { limited: false, retryAfterSec: 0 }
    return {
        limited: true,
        retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - now) / 1000)),
    }
}

export function clearUnlockFailures(key) {
    unlockFailures.delete(key)
}
