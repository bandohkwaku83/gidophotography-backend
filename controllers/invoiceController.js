import mongoose from "mongoose"
import Invoice from "../models/Invoice.js"
import Booking from "../models/Booking.js"
import { previewNextInvoiceNo, generateInvoiceNo } from "../utils/invoiceNumbering.js"
import {
    roundGhs,
    computeInvoiceTotals,
    paymentStatusFromAmounts,
} from "../utils/invoiceTotals.js"

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function todayIsoDate() {
    const d = new Date()
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, "0")
    const day = String(d.getDate()).padStart(2, "0")
    return `${y}-${m}-${day}`
}

function addDaysIso(iso, days) {
    const [y, m, d] = iso.split("-").map(Number)
    const dt = new Date(y, m - 1, d)
    dt.setDate(dt.getDate() + days)
    const ny = dt.getFullYear()
    const nm = String(dt.getMonth() + 1).padStart(2, "0")
    const nd = String(dt.getDate()).padStart(2, "0")
    return `${ny}-${nm}-${nd}`
}

function parseIsoDateField(raw, fieldName) {
    if (raw === undefined || raw === null || raw === "") return { provided: false }
    const s = String(raw).trim()
    if (!ISO_DATE_RE.test(s)) {
        return { provided: true, invalid: true, message: `${fieldName} must be YYYY-MM-DD` }
    }
    return { provided: true, value: s }
}

function trimOptional(raw) {
    if (raw === undefined || raw === null) return undefined
    return String(raw).trim()
}

function parseBillTo(raw) {
    if (!raw || typeof raw !== "object") {
        return { error: "billTo is required with a name" }
    }
    const name = String(raw.name ?? "").trim()
    if (!name) return { error: "billTo.name is required" }
    return {
        value: {
            name,
            email: trimOptional(raw.email) ?? "",
            address: trimOptional(raw.address) ?? "",
        },
    }
}

function parseBilledFrom(raw) {
    if (!raw || typeof raw !== "object") {
        return { error: "billedFrom is required with a name" }
    }
    const name = String(raw.name ?? "").trim()
    if (!name) return { error: "billedFrom.name is required" }
    return {
        value: {
            name,
            email: trimOptional(raw.email) ?? "",
            phone: trimOptional(raw.phone) ?? "",
            website: trimOptional(raw.website) ?? "",
            address: trimOptional(raw.address) ?? "",
        },
    }
}

function parseItems(raw) {
    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: "items must be a non-empty array" }
    }
    const items = []
    for (let i = 0; i < raw.length; i++) {
        const row = raw[i]
        const description = String(row?.description ?? "").trim()
        if (!description) {
            return { error: `items[${i}].description is required` }
        }
        const qtyRaw = row?.quantity
        const qty =
            typeof qtyRaw === "number" ? qtyRaw : Number(String(qtyRaw ?? "").trim())
        if (!Number.isFinite(qty) || qty < 0) {
            return { error: `items[${i}].quantity must be a non-negative number` }
        }
        const priceRaw = row?.unitPriceGHS ?? row?.unit_price_ghs
        const unitPriceGHS =
            typeof priceRaw === "number"
                ? priceRaw
                : Number(String(priceRaw ?? "").trim().replace(/,/g, ""))
        if (!Number.isFinite(unitPriceGHS) || unitPriceGHS < 0) {
            return {
                error: `items[${i}].unitPriceGHS must be a non-negative number`,
            }
        }
        items.push({
            description,
            quantity: qty,
            unitPriceGHS: roundGhs(unitPriceGHS),
        })
    }
    return { value: items }
}

function parseTaxRate(raw) {
    if (raw === undefined || raw === null || raw === "") return 0
    const n = typeof raw === "number" ? raw : Number(String(raw).trim())
    if (!Number.isFinite(n) || n < 0) return { invalid: true }
    return n
}

async function verifyBookingOwnership(bookingId, photographerId) {
    if (!bookingId) return { ok: true, booking: null }
    if (!mongoose.Types.ObjectId.isValid(String(bookingId))) {
        return { error: "bookingId must be a valid Mongo id", status: 400 }
    }
    const booking = await Booking.findById(bookingId).select("_id client createdBy").lean()
    if (!booking || String(booking.createdBy) !== String(photographerId)) {
        return { error: "Booking not found", status: 404 }
    }
    return { ok: true, booking }
}

function buildInvoicePayload(body, { totals, payment, defaults = {}, preserveInvoiceDate = false }) {
    const payload = {
        currency: "GHS",
        invoiceDateISO: defaults.invoiceDateISO ?? todayIsoDate(),
        dueDateISO:
            defaults.dueDateISO ??
            addDaysIso(defaults.invoiceDateISO ?? todayIsoDate(), 7),
        shootDateISO: defaults.shootDateISO ?? "",
        bookingId: defaults.bookingId ?? null,
        clientId: defaults.clientId ?? null,
        title: defaults.title ?? "",
        shootType: defaults.shootType ?? "",
        billTo: defaults.billTo,
        billedFrom: defaults.billedFrom,
        notes: defaults.notes ?? "",
        items: defaults.items,
        taxRate: defaults.taxRate ?? 0,
        subtotalGHS: totals.subtotalGHS,
        taxGHS: totals.taxGHS,
        totalGHS: totals.totalGHS,
        amountPayingGHS: payment.amountPayingGHS,
        paymentStatus: payment.paymentStatus,
        paymentPercent: payment.paymentPercent,
        savedAt: new Date(),
    }

    if (body.title !== undefined) payload.title = String(body.title ?? "").trim()
    if (body.shootType !== undefined)
        payload.shootType = String(body.shootType ?? "").trim()
    if (body.notes !== undefined) payload.notes = String(body.notes ?? "").trim()

    const shootDate = parseIsoDateField(body.shootDateISO, "shootDateISO")
    if (shootDate.provided) {
        if (shootDate.invalid) return { error: shootDate.message }
        payload.shootDateISO = shootDate.value
    }

    const invoiceDate = parseIsoDateField(body.invoiceDateISO, "invoiceDateISO")
    if (!preserveInvoiceDate && invoiceDate.provided) {
        if (invoiceDate.invalid) return { error: invoiceDate.message }
        payload.invoiceDateISO = invoiceDate.value
    }

    const dueDate = parseIsoDateField(body.dueDateISO, "dueDateISO")
    if (dueDate.provided) {
        if (dueDate.invalid) return { error: dueDate.message }
        payload.dueDateISO = dueDate.value
    }

    return { value: payload }
}

export function serializeInvoiceSummary(doc) {
    const o = doc.toObject ? doc.toObject() : doc
    return {
        _id: o._id,
        savedAt: o.savedAt,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        invoiceNo: o.invoiceNo,
        invoiceDateISO: o.invoiceDateISO,
        dueDateISO: o.dueDateISO,
        shootDateISO: o.shootDateISO || undefined,
        bookingId: o.bookingId || undefined,
        clientId: o.clientId || undefined,
        title: o.title || undefined,
        shootType: o.shootType || undefined,
        billTo: o.billTo,
        totalGHS: o.totalGHS,
        amountPayingGHS: o.amountPayingGHS,
        paymentStatus: o.paymentStatus,
        paymentPercent: o.paymentPercent,
        currency: o.currency,
    }
}

export function serializeInvoiceFull(doc) {
    const o = doc.toObject ? doc.toObject() : doc
    return {
        _id: o._id,
        photographerId: o.photographerId,
        savedAt: o.savedAt,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        currency: o.currency,
        invoiceNo: o.invoiceNo,
        invoiceDateISO: o.invoiceDateISO,
        dueDateISO: o.dueDateISO,
        shootDateISO: o.shootDateISO || undefined,
        bookingId: o.bookingId || undefined,
        clientId: o.clientId || undefined,
        title: o.title || undefined,
        shootType: o.shootType || undefined,
        billTo: o.billTo,
        billedFrom: o.billedFrom,
        notes: o.notes || undefined,
        items: o.items,
        taxRate: o.taxRate,
        subtotalGHS: o.subtotalGHS,
        taxGHS: o.taxGHS,
        totalGHS: o.totalGHS,
        amountPayingGHS: o.amountPayingGHS,
        paymentStatus: o.paymentStatus,
        paymentPercent: o.paymentPercent,
    }
}

export const getInvoiceMeta = async (req, res) => {
    try {
        const nextInvoiceNoPreview = await previewNextInvoiceNo(req.user._id)
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({ nextInvoiceNoPreview })
    } catch (error) {
        console.error("Invoice meta error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const listInvoices = async (req, res) => {
    try {
        const filter = { photographerId: req.user._id }
        const { bookingId, clientId, from, to } = req.query

        if (bookingId) {
            if (!mongoose.Types.ObjectId.isValid(String(bookingId))) {
                return res.status(400).json({ message: "Invalid bookingId" })
            }
            filter.bookingId = bookingId
        }

        if (clientId) {
            if (!mongoose.Types.ObjectId.isValid(String(clientId))) {
                return res.status(400).json({ message: "Invalid clientId" })
            }
            filter.clientId = clientId
        }

        if (from || to) {
            const range = {}
            if (from) {
                const d = String(from).trim()
                if (!ISO_DATE_RE.test(d)) {
                    return res.status(400).json({
                        message: "from must be YYYY-MM-DD (filters invoiceDateISO)",
                    })
                }
                range.$gte = d
            }
            if (to) {
                const d = String(to).trim()
                if (!ISO_DATE_RE.test(d)) {
                    return res.status(400).json({
                        message: "to must be YYYY-MM-DD (filters invoiceDateISO)",
                    })
                }
                range.$lte = d
            }
            filter.invoiceDateISO = range
        }

        const invoices = await Invoice.find(filter)
            .sort({ savedAt: -1 })
            .lean()

        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({
            count: invoices.length,
            invoices: invoices.map(serializeInvoiceSummary),
        })
    } catch (error) {
        console.error("List invoices error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getInvoice = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid invoice id" })
        }
        const doc = await Invoice.findOne({
            _id: id,
            photographerId: req.user._id,
        })
        if (!doc) {
            return res.status(404).json({ message: "Invoice not found" })
        }
        res.set("Cache-Control", "private, no-store")
        return res.status(200).json({ invoice: serializeInvoiceFull(doc) })
    } catch (error) {
        console.error("Get invoice error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const createInvoice = async (req, res) => {
    try {
        const body = req.body || {}

        const billToParsed = parseBillTo(body.billTo)
        if (billToParsed.error) {
            return res.status(400).json({ message: billToParsed.error })
        }

        const billedFromParsed = parseBilledFrom(body.billedFrom)
        if (billedFromParsed.error) {
            return res.status(400).json({ message: billedFromParsed.error })
        }

        const itemsParsed = parseItems(body.items)
        if (itemsParsed.error) {
            return res.status(400).json({ message: itemsParsed.error })
        }

        const taxRate = parseTaxRate(body.taxRate)
        if (taxRate?.invalid) {
            return res.status(400).json({ message: "taxRate must be a non-negative number" })
        }

        const invoiceDateParsed = parseIsoDateField(body.invoiceDateISO, "invoiceDateISO")
        if (invoiceDateParsed.invalid) {
            return res.status(400).json({ message: invoiceDateParsed.message })
        }
        const dueDateParsed = parseIsoDateField(body.dueDateISO, "dueDateISO")
        if (dueDateParsed.invalid) {
            return res.status(400).json({ message: dueDateParsed.message })
        }
        const shootDateParsed = parseIsoDateField(body.shootDateISO, "shootDateISO")
        if (shootDateParsed.invalid) {
            return res.status(400).json({ message: shootDateParsed.message })
        }

        let bookingId = null
        let clientId = null
        if (body.bookingId) {
            const bookingCheck = await verifyBookingOwnership(
                body.bookingId,
                req.user._id
            )
            if (bookingCheck.error) {
                return res
                    .status(bookingCheck.status || 400)
                    .json({ message: bookingCheck.error })
            }
            bookingId = bookingCheck.booking._id
            clientId = bookingCheck.booking.client
        }

        const totals = computeInvoiceTotals(itemsParsed.value, taxRate)
        const payment = paymentStatusFromAmounts(body.amountPayingGHS, totals.totalGHS)

        const invoiceDateISO = invoiceDateParsed.value ?? todayIsoDate()
        const dueDateISO = dueDateParsed.value ?? addDaysIso(invoiceDateISO, 7)

        const built = buildInvoicePayload(body, {
            totals,
            payment,
            defaults: {
                invoiceDateISO,
                dueDateISO,
                shootDateISO: shootDateParsed.value ?? "",
                bookingId,
                clientId,
                title: trimOptional(body.title) ?? "",
                shootType: trimOptional(body.shootType) ?? "",
                billTo: billToParsed.value,
                billedFrom: billedFromParsed.value,
                notes: trimOptional(body.notes) ?? "",
                items: itemsParsed.value,
                taxRate,
            },
        })
        if (built.error) {
            return res.status(400).json({ message: built.error })
        }

        const invoiceNo = await generateInvoiceNo(req.user._id)

        const doc = await Invoice.create({
            photographerId: req.user._id,
            invoiceNo,
            ...built.value,
        })

        return res.status(201).json({
            message: "Invoice created",
            invoice: serializeInvoiceFull(doc),
        })
    } catch (error) {
        if (error?.code === 11000) {
            return res.status(409).json({ message: "Invoice number conflict; retry" })
        }
        console.error("Create invoice error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

async function applyInvoiceUpdate(existing, body, res) {
    const billToParsed =
        body.billTo !== undefined ? parseBillTo(body.billTo) : { value: existing.billTo }
    if (billToParsed.error) {
        return res.status(400).json({ message: billToParsed.error })
    }

    const billedFromParsed =
        body.billedFrom !== undefined
            ? parseBilledFrom(body.billedFrom)
            : { value: existing.billedFrom }
    if (billedFromParsed.error) {
        return res.status(400).json({ message: billedFromParsed.error })
    }

    const itemsParsed =
        body.items !== undefined ? parseItems(body.items) : { value: existing.items }
    if (itemsParsed.error) {
        return res.status(400).json({ message: itemsParsed.error })
    }

    let taxRate = existing.taxRate
    if (body.taxRate !== undefined) {
        const parsed = parseTaxRate(body.taxRate)
        if (parsed?.invalid) {
            return res.status(400).json({ message: "taxRate must be a non-negative number" })
        }
        taxRate = parsed
    }

    let bookingId = existing.bookingId
    let clientId = existing.clientId
    if (body.bookingId !== undefined) {
        if (body.bookingId === null || body.bookingId === "") {
            bookingId = null
            clientId = null
        } else {
            const bookingCheck = await verifyBookingOwnership(
                body.bookingId,
                existing.photographerId
            )
            if (bookingCheck.error) {
                return res
                    .status(bookingCheck.status || 400)
                    .json({ message: bookingCheck.error })
            }
            bookingId = bookingCheck.booking._id
            clientId = bookingCheck.booking.client
        }
    }

    const totals = computeInvoiceTotals(itemsParsed.value, taxRate)
    const amountPayingRaw =
        body.amountPayingGHS !== undefined
            ? body.amountPayingGHS
            : existing.amountPayingGHS
    const payment = paymentStatusFromAmounts(amountPayingRaw, totals.totalGHS)

    const built = buildInvoicePayload(body, {
        totals,
        payment,
        preserveInvoiceDate: true,
        defaults: {
            invoiceDateISO: existing.invoiceDateISO,
            dueDateISO: existing.dueDateISO,
            shootDateISO: existing.shootDateISO ?? "",
            bookingId,
            clientId,
            title: existing.title ?? "",
            shootType: existing.shootType ?? "",
            billTo: billToParsed.value,
            billedFrom: billedFromParsed.value,
            notes: existing.notes ?? "",
            items: itemsParsed.value,
            taxRate,
        },
    })
    if (built.error) {
        return res.status(400).json({ message: built.error })
    }

    Object.assign(existing, built.value)
    existing.savedAt = new Date()
    await existing.save()

    return res.status(200).json({
        message: "Invoice updated",
        invoice: serializeInvoiceFull(existing),
    })
}

export const replaceInvoice = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid invoice id" })
        }
        const existing = await Invoice.findOne({
            _id: id,
            photographerId: req.user._id,
        })
        if (!existing) {
            return res.status(404).json({ message: "Invoice not found" })
        }
        return applyInvoiceUpdate(existing, req.body || {}, res)
    } catch (error) {
        console.error("Replace invoice error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const patchInvoice = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid invoice id" })
        }
        const existing = await Invoice.findOne({
            _id: id,
            photographerId: req.user._id,
        })
        if (!existing) {
            return res.status(404).json({ message: "Invoice not found" })
        }
        return applyInvoiceUpdate(existing, req.body || {}, res)
    } catch (error) {
        console.error("Patch invoice error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteInvoice = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid invoice id" })
        }
        const doc = await Invoice.findOne({
            _id: id,
            photographerId: req.user._id,
        })
        if (!doc) {
            return res.status(404).json({ message: "Invoice not found" })
        }
        const snapshot = serializeInvoiceFull(doc)
        await doc.deleteOne()
        return res.status(200).json({
            message: "Invoice deleted",
            deletedId: String(doc._id),
            invoice: snapshot,
        })
    } catch (error) {
        console.error("Delete invoice error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
