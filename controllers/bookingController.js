import mongoose from "mongoose"
import Booking from "../models/Booking.js"
import Client from "../models/Client.js"
import {
    BOOKING_SHOOT_TYPES,
    BOOKING_SHOOT_TYPE_COLORS,
} from "../constants/bookingShootTypes.js"

const CLIENT_POPULATE = {
    path: "client",
    select: "name email contact location",
}

function colorForType(shootType) {
    return BOOKING_SHOOT_TYPE_COLORS[shootType] || "sky"
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
    return {
        _id: o._id,
        title: o.title,
        client: clientOut,
        shootType: o.shootType,
        color: colorForType(o.shootType),
        startsAt: o.startsAt,
        endsAt: o.endsAt || null,
        location: o.location || "",
        description: o.description || "",
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
    }
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
 * @returns {Date | null}
 */
function resolveStartsAt(body) {
    if (body.startsAt) {
        const d = new Date(body.startsAt)
        return Number.isNaN(d.getTime()) ? null : d
    }
    const datePart = parseDateInput(body.date ?? body.eventDate)
    const startRaw = body.start ?? body.startTime
    const mins = parseTimeToMinutes(startRaw)
    if (!datePart || mins == null) return null
    return toLocalDateTime(datePart, mins)
}

function resolveEndsAt(body, startsAt) {
    if (body.endsAt) {
        const d = new Date(body.endsAt)
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
        const shootTypes = BOOKING_SHOOT_TYPES.map((id) => ({
            id,
            label: id,
            color: colorForType(id),
        }))
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

        if (type && BOOKING_SHOOT_TYPES.includes(String(type))) {
            filter.shootType = type
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
        const shootType = body.shootType
        const location = body.location != null ? String(body.location).trim() : ""
        const description =
            body.description != null ? String(body.description).trim() : ""

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

        if (!shootType || !BOOKING_SHOOT_TYPES.includes(shootType)) {
            return res.status(400).json({
                message: `shootType must be one of: ${BOOKING_SHOOT_TYPES.join(", ")}`,
            })
        }

        const startsAt = resolveStartsAt(body)
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

        const doc = await Booking.create({
            title,
            client: clientId,
            shootType,
            startsAt,
            endsAt: endsAt || null,
            location,
            description,
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
        const flat = {
            ...merged.toObject(),
            ...body,
        }

        const updates = {}

        if (body.title !== undefined) updates.title = String(body.title).trim()
        if (body.location !== undefined)
            updates.location = String(body.location ?? "").trim()
        if (body.description !== undefined)
            updates.description = String(body.description ?? "").trim()

        if (body.shootType !== undefined) {
            if (!BOOKING_SHOOT_TYPES.includes(body.shootType)) {
                return res.status(400).json({
                    message: `shootType must be one of: ${BOOKING_SHOOT_TYPES.join(", ")}`,
                })
            }
            updates.shootType = body.shootType
        }

        const wantsStartChange =
            body.startsAt !== undefined ||
            body.date !== undefined ||
            body.eventDate !== undefined ||
            body.start !== undefined ||
            body.startTime !== undefined

        if (wantsStartChange) {
            const nextStarts = resolveStartsAt(flat)
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
                updates.endsAt = resolveEndsAt(flat, startRef)
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
        const doc = await Booking.findOneAndDelete({
            _id: id,
            createdBy: req.user._id,
        })
        if (!doc) {
            return res.status(404).json({ message: "Booking not found" })
        }
        return res.status(200).json({ message: "Booking deleted" })
    } catch (error) {
        console.error("Delete booking error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
