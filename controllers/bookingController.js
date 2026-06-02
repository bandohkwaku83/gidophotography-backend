import mongoose from "mongoose"
import Booking from "../models/Booking.js"
import Client from "../models/Client.js"
import {
    BOOKING_SHOOT_TYPES,
    normalizeShootCategory,
    shootTypeColor,
    shootTypeLabel,
} from "../constants/bookingShootTypes.js"

const CLIENT_POPULATE = {
    path: "client",
    select: "name email contact location",
}

function resolveStoredCategory(o) {
    if (o.category) {
        const norm = normalizeShootCategory(o.category)
        if (!norm.error) return norm
    }
    if (o.shootType) {
        const norm = normalizeShootCategory(o.shootType)
        if (!norm.error) return norm
    }
    return {
        category: "other",
        meta: { id: "other", label: "Other", color: "sky" },
    }
}

export function serializeBooking(doc) {
    const o = doc.toObject ? doc.toObject() : doc
    let clientOut = null
    if (o.client) {
        if (typeof o.client === "object" && o.client.name != null) {
            clientOut = {
                _id: o.client._id,
                name: o.client.name,
                contact: o.client.contact || "",
                email: o.client.email || "",
                location: o.client.location || "",
            }
        } else {
            clientOut = { _id: o.client }
        }
    }

    const resolved = resolveStoredCategory(o)
    const category = resolved.category
    const label = resolved.meta?.label ?? o.shootType ?? "Other"
    const notes = (o.notes ?? o.description ?? "").trim()

    return {
        _id: o._id,
        title: o.title,
        client: clientOut,
        shootType: label,
        category,
        color: shootTypeColor(category),
        startsAt: o.startsAt,
        endsAt: o.endsAt || null,
        location: o.location || "",
        notes,
        description: notes,
        amountCharged:
            o.amountCharged != null && Number.isFinite(Number(o.amountCharged))
                ? Number(o.amountCharged)
                : 0,
        currency: (o.currency || "GHS").trim() || "GHS",
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    }
}

function readNotes(body) {
    if (body.notes !== undefined) return String(body.notes ?? "").trim()
    if (body.description !== undefined) return String(body.description ?? "").trim()
    return undefined
}

function readCurrency(body) {
    if (body.currency === undefined) return undefined
    const c = String(body.currency ?? "").trim().toUpperCase()
    return c || "GHS"
}

/**
 * @param {object} body
 * @returns {{ provided: boolean, value?: number | null, invalid?: boolean }}
 */
function parseAmountCharged(body) {
    if (!Object.prototype.hasOwnProperty.call(body, "amountCharged") &&
        !Object.prototype.hasOwnProperty.call(body, "amount_charged")) {
        return { provided: false }
    }
    const raw = body.amountCharged ?? body.amount_charged
    if (raw === null || raw === "") return { provided: true, value: null }
    const n =
        typeof raw === "number" ? raw : Number(String(raw).trim().replace(/,/g, ""))
    if (!Number.isFinite(n) || n < 0) return { provided: true, invalid: true }
    return { provided: true, value: n }
}

/** @returns {{ y: number, m: number, d: number } | null} */
function parseDateInput(raw) {
    const s = String(raw ?? "").trim()
    if (!s) return null
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        const [y, m, d] = s.split("-").map(Number)
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y, m, d }
    }
    if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
        const parts = s.split("/").map((p) => parseInt(p, 10))
        const [d, m, y] = parts
        if (m >= 1 && m <= 12 && d >= 1 && d <= 31) return { y, m, d }
    }
    const t = Date.parse(s)
    if (!Number.isNaN(t)) {
        const x = new Date(t)
        return { y: x.getFullYear(), m: x.getMonth() + 1, d: x.getDate() }
    }
    return null
}

/** @returns {number | null} minutes from midnight */
function parseTimeToMinutes(raw) {
    const t = String(raw ?? "").trim()
    if (!t) return null
    const m12 = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i)
    if (m12) {
        let h = parseInt(m12[1], 10)
        const mi = parseInt(m12[2], 10)
        const ap = m12[3].toUpperCase()
        if (ap === "PM" && h !== 12) h += 12
        if (ap === "AM" && h === 12) h = 0
        if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
        return h * 60 + mi
    }
    const m24 = t.match(/^(\d{1,2}):(\d{2})$/)
    if (m24) {
        const h = parseInt(m24[1], 10)
        const mi = parseInt(m24[2], 10)
        if (h < 0 || h > 23 || mi < 0 || mi > 59) return null
        return h * 60 + mi
    }
    return null
}

function toLocalDateTime(ymd, minutesFromMidnight) {
    const h = Math.floor(minutesFromMidnight / 60)
    const mi = minutesFromMidnight % 60
    return new Date(ymd.y, ymd.m - 1, ymd.d, h, mi, 0, 0)
}

/**
 * Resolve startsAt from body: explicit ISO `startsAt`, or `date` + `start` / `startTime`.
 * When updating, pass `previousStartsAt` so a changed time or date alone can be merged
 * (do not merge the full document into body — old `startsAt` would shadow new fields).
 * @param {object} body Request JSON only (not merged with existing doc).
 * @param {Date | null} [previousStartsAt]
 * @returns {Date | null}
 */
function resolveStartsAt(body, previousStartsAt = null) {
    const hasExplicit = Object.prototype.hasOwnProperty.call(body, "startsAt")
    if (hasExplicit) {
        const raw = body.startsAt
        if (raw == null || raw === "") return null
        const d = new Date(raw)
        return Number.isNaN(d.getTime()) ? null : d
    }

    const datePart = parseDateInput(body.date ?? body.eventDate)
    const startRaw = body.start ?? body.startTime
    const mins = parseTimeToMinutes(startRaw)

    if (datePart != null && mins != null) {
        return toLocalDateTime(datePart, mins)
    }
    if (previousStartsAt != null && mins != null) {
        const s =
            previousStartsAt instanceof Date
                ? previousStartsAt
                : new Date(previousStartsAt)
        if (Number.isNaN(s.getTime())) return null
        const ymd = {
            y: s.getFullYear(),
            m: s.getMonth() + 1,
            d: s.getDate(),
        }
        return toLocalDateTime(ymd, mins)
    }
    if (datePart != null && previousStartsAt != null) {
        const s =
            previousStartsAt instanceof Date
                ? previousStartsAt
                : new Date(previousStartsAt)
        if (Number.isNaN(s.getTime())) return null
        const carryMins = s.getHours() * 60 + s.getMinutes()
        return toLocalDateTime(datePart, carryMins)
    }
    return null
}

function resolveEndsAt(body, startsAt) {
    const hasExplicit = Object.prototype.hasOwnProperty.call(body, "endsAt")
    if (hasExplicit) {
        const raw = body.endsAt
        if (raw == null || raw === "") return null
        const d = new Date(raw)
        return Number.isNaN(d.getTime()) ? null : d
    }
    const datePart =
        parseDateInput(body.date ?? body.eventDate) ||
        (startsAt
            ? {
                  y: startsAt.getFullYear(),
                  m: startsAt.getMonth() + 1,
                  d: startsAt.getDate(),
              }
            : null)
    const endRaw = body.end ?? body.endTime
    if (endRaw === undefined || endRaw === null || String(endRaw).trim() === "")
        return null
    const mins = parseTimeToMinutes(endRaw)
    if (mins == null || !datePart) return null
    return toLocalDateTime(datePart, mins)
}

/** CRM client id from dropdown: clientId, client_id, or client as id string / { _id }. */
function resolveBookingClientId(body) {
    const rawId = body.clientId ?? body.client_id ?? body.linkedClientId
    if (rawId && mongoose.Types.ObjectId.isValid(String(rawId))) {
        return String(rawId)
    }
    const c = body.client
    if (c && typeof c === "object" && (c._id || c.id)) {
        const id = c._id ?? c.id
        if (id && mongoose.Types.ObjectId.isValid(String(id))) return String(id)
    }
    if (typeof c === "string" && mongoose.Types.ObjectId.isValid(c.trim())) {
        return c.trim()
    }
    return null
}

export const getBookingMeta = async (req, res) => {
    try {
        const shootTypes = BOOKING_SHOOT_TYPES.map((t) => ({
            id: t.id,
            label: t.label,
            color: t.color,
        }))
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({
            shootTypes,
            legend: shootTypes,
            clientsListPath: "/api/clients",
        })
    } catch (error) {
        console.error("Booking meta error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

/** Sunday–Saturday week in the server local timezone, containing `now`. */
function getLocalWeekRange(now = new Date()) {
    const start = new Date(now)
    start.setHours(0, 0, 0, 0)
    const dow = start.getDay()
    start.setDate(start.getDate() - dow)
    const end = new Date(start)
    end.setDate(start.getDate() + 6)
    end.setHours(23, 59, 59, 999)
    return { start, end }
}

export const getBookingsWeekSummary = async (req, res) => {
    try {
        const { start, end } = getLocalWeekRange()
        const count = await Booking.countDocuments({
            createdBy: req.user._id,
            startsAt: { $gte: start, $lte: end },
        })
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({
            bookedCount: count,
            weekStartsAt: start,
            weekEndsAt: end,
        })
    } catch (error) {
        console.error("Booking week summary error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

function monthLocalRange(year, month) {
    const y = parseInt(String(year), 10)
    const m = parseInt(String(month), 10)
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
        return null
    }
    const start = new Date(y, m - 1, 1, 0, 0, 0, 0)
    const end = new Date(y, m, 0, 23, 59, 59, 999)
    return { start, end }
}

export const listBookings = async (req, res) => {
    try {
        const { year, month, type, from, to } = req.query
        const filter = {}

        if (type) {
            const norm = normalizeShootCategory(String(type))
            if (!norm.error) {
                filter.$or = [
                    { category: norm.category },
                    { shootType: norm.meta.label },
                ]
            }
        }

        if (from || to) {
            const range = {}
            if (from) {
                const d = new Date(String(from))
                if (!Number.isNaN(d.getTime())) range.$gte = d
            }
            if (to) {
                const d = new Date(String(to))
                if (!Number.isNaN(d.getTime())) range.$lte = d
            }
            if (!Object.keys(range).length) {
                return res.status(400).json({
                    message: "Invalid from or to date (use ISO strings)",
                })
            }
            filter.startsAt = range
        } else if (year != null && month != null) {
            const mr = monthLocalRange(year, month)
            if (!mr) {
                return res.status(400).json({
                    message: "Invalid year or month (use month 1–12)",
                })
            }
            filter.startsAt = { $gte: mr.start, $lte: mr.end }
        } else {
            return res.status(400).json({
                message:
                    "Provide year+month (e.g. ?year=2026&month=5) or from+to ISO date range",
            })
        }

        filter.createdBy = req.user._id

        const bookings = await Booking.find(filter)
            .populate(CLIENT_POPULATE)
            .sort({ startsAt: 1 })
            .lean()

        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({
            count: bookings.length,
            bookings: bookings.map((b) => serializeBooking(b)),
        })
    } catch (error) {
        console.error("List bookings error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const createBooking = async (req, res) => {
    try {
        const body = req.body || {}
        const title = String(body.title ?? "").trim()
        const location = body.location != null ? String(body.location).trim() : ""
        const notes =
            readNotes(body) ??
            (body.description != null ? String(body.description).trim() : "")

        if (!title) {
            return res.status(400).json({ message: "Shoot title is required" })
        }

        const clientId = resolveBookingClientId(body)
        if (!clientId) {
            return res.status(400).json({
                message:
                    "clientId is required (Mongo id of a client from GET /api/clients)",
            })
        }
        const clientDoc = await Client.findById(clientId).select(
            "_id name contact email location"
        )
        if (!clientDoc) {
            return res.status(404).json({ message: "Client not found" })
        }

        const typeNorm = normalizeShootCategory(body.shootType)
        if (typeNorm.error) {
            return res.status(400).json({ message: typeNorm.error })
        }

        const startsAt = resolveStartsAt(body, null)
        if (!startsAt) {
            return res.status(400).json({
                message:
                    "Provide startsAt (ISO) or date (YYYY-MM-DD or DD/MM/YYYY) plus start / startTime (e.g. 09:00 or 9:00 AM)",
            })
        }

        let endsAt = resolveEndsAt(body, startsAt)
        if (endsAt && endsAt <= startsAt) {
            return res.status(400).json({
                message: "End time must be after start time",
            })
        }

        const amountParsed = parseAmountCharged(body)
        if (amountParsed.invalid) {
            return res.status(400).json({
                message: "amountCharged must be a non-negative number (GHS)",
            })
        }

        const currency = readCurrency(body) ?? "GHS"

        const doc = await Booking.create({
            title,
            client: clientId,
            category: typeNorm.category,
            shootType: typeNorm.meta.label,
            startsAt,
            endsAt: endsAt || null,
            location,
            notes,
            description: notes,
            amountCharged: amountParsed.provided ? (amountParsed.value ?? 0) : 0,
            currency,
            createdBy: req.user?._id,
        })
        await doc.populate(CLIENT_POPULATE)

        return res.status(201).json({
            message: "Booking saved",
            booking: serializeBooking(doc),
        })
    } catch (error) {
        console.error("Create booking error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getBooking = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid booking id" })
        }
        const doc = await Booking.findById(id).populate(CLIENT_POPULATE)
        if (!doc || String(doc.createdBy) !== String(req.user._id)) {
            return res.status(404).json({ message: "Booking not found" })
        }
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({ booking: serializeBooking(doc) })
    } catch (error) {
        console.error("Get booking error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const updateBooking = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid booking id" })
        }

        const merged = await Booking.findById(id)
        if (!merged || String(merged.createdBy) !== String(req.user._id)) {
            return res.status(404).json({ message: "Booking not found" })
        }

        const body = req.body || {}

        const updates = {}

        if (body.title !== undefined) {
            const t = String(body.title).trim()
            if (!t) {
                return res.status(400).json({ message: "title cannot be empty" })
            }
            updates.title = t
        }
        if (body.location !== undefined)
            updates.location = String(body.location ?? "").trim()
        const notesUpdate = readNotes(body)
        if (notesUpdate !== undefined) {
            updates.notes = notesUpdate
            updates.description = notesUpdate
        }

        const currencyUpdate = readCurrency(body)
        if (currencyUpdate !== undefined) updates.currency = currencyUpdate

        const amountParsed = parseAmountCharged(body)
        if (amountParsed.provided) {
            if (amountParsed.invalid) {
                return res.status(400).json({
                    message: "amountCharged must be a non-negative number (GHS)",
                })
            }
            updates.amountCharged = amountParsed.value
        }

        if (body.shootType !== undefined) {
            const typeNorm = normalizeShootCategory(body.shootType)
            if (typeNorm.error) {
                return res.status(400).json({ message: typeNorm.error })
            }
            updates.category = typeNorm.category
            updates.shootType = typeNorm.meta.label
        }

        const wantsStartChange =
            body.startsAt !== undefined ||
            body.date !== undefined ||
            body.eventDate !== undefined ||
            body.start !== undefined ||
            body.startTime !== undefined

        if (wantsStartChange) {
            const nextStarts = resolveStartsAt(body, merged.startsAt)
            if (!nextStarts) {
                return res.status(400).json({
                    message:
                        "Invalid date/time: provide startsAt (ISO) or date + start/startTime",
                })
            }
            updates.startsAt = nextStarts
            const prevT = merged.startsAt?.getTime?.()
            if (prevT !== nextStarts.getTime()) {
                updates.reminderClientSentAt = null
                updates.reminderAdminSentAt = null
                updates.reminderAdminInAppSentAt = null
            }
        }

        const startRef = updates.startsAt || merged.startsAt

        const wantsEndChange =
            body.endsAt !== undefined ||
            body.end !== undefined ||
            body.endTime !== undefined

        if (wantsEndChange) {
            const endRaw = body.end ?? body.endTime
            const hasEndsAtKey = Object.prototype.hasOwnProperty.call(body, "endsAt")
            const endsAtStr =
                hasEndsAtKey && body.endsAt != null
                    ? String(body.endsAt).trim()
                    : ""
            if (endsAtStr) {
                const d = new Date(body.endsAt)
                updates.endsAt = Number.isNaN(d.getTime()) ? null : d
            } else if (
                endRaw !== undefined &&
                endRaw !== null &&
                String(endRaw).trim() !== ""
            ) {
                updates.endsAt = resolveEndsAt(body, startRef)
            } else {
                updates.endsAt = null
            }
        }

        const finalStart = updates.startsAt ?? merged.startsAt
        let finalEnd = merged.endsAt
        if (Object.prototype.hasOwnProperty.call(updates, "endsAt")) {
            finalEnd = updates.endsAt
        }
        if (finalEnd && finalEnd <= finalStart) {
            return res.status(400).json({
                message: "End time must be after start time",
            })
        }

        const wantsClientChange =
            body.clientId !== undefined ||
            body.client_id !== undefined ||
            body.linkedClientId !== undefined ||
            (body.client !== undefined &&
                (typeof body.client === "object" ||
                    (typeof body.client === "string" &&
                        mongoose.Types.ObjectId.isValid(
                            String(body.client).trim()
                        ))))

        if (wantsClientChange) {
            const linkId = resolveBookingClientId(body)
            if (!linkId) {
                return res.status(400).json({
                    message:
                        "clientId must be a valid Mongo id (existing client from GET /api/clients)",
                })
            }
            const exists = await Client.findById(linkId).select("_id")
            if (!exists) {
                return res.status(404).json({ message: "Client not found" })
            }
            updates.client = linkId
        }

        if (Object.keys(updates).length === 0) {
            return res.status(400).json({ message: "No valid fields to update" })
        }

        const doc = await Booking.findOneAndUpdate(
            { _id: id, createdBy: req.user._id },
            updates,
            { new: true, runValidators: true }
        )

        if (!doc) {
            return res.status(404).json({ message: "Booking not found" })
        }

        await doc.populate(CLIENT_POPULATE)

        return res.status(200).json({
            message: "Booking updated",
            booking: serializeBooking(doc),
        })
    } catch (error) {
        console.error("Update booking error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteBooking = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid booking id" })
        }
        const doc = await Booking.findOne({
            _id: id,
            createdBy: req.user._id,
        }).populate(CLIENT_POPULATE)
        if (!doc) {
            return res.status(404).json({ message: "Booking not found" })
        }
        const snapshot = serializeBooking(doc)
        await doc.deleteOne()
        return res.status(200).json({
            message: "Booking deleted",
            deletedId: String(doc._id),
            booking: snapshot,
        })
    } catch (error) {
        console.error("Delete booking error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
