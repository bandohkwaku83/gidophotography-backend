import mongoose from "mongoose"

const billToSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, trim: true, default: "" },
        address: { type: String, trim: true, default: "" },
    },
    { _id: false }
)

const billedFromSchema = new mongoose.Schema(
    {
        name: { type: String, required: true, trim: true },
        email: { type: String, trim: true, default: "" },
        phone: { type: String, trim: true, default: "" },
        website: { type: String, trim: true, default: "" },
        address: { type: String, trim: true, default: "" },
    },
    { _id: false }
)

const invoiceItemSchema = new mongoose.Schema(
    {
        description: { type: String, required: true, trim: true },
        quantity: { type: Number, required: true, min: 0 },
        unitPriceGHS: { type: Number, required: true, min: 0 },
    },
    { _id: false }
)

const invoiceSchema = new mongoose.Schema(
    {
        photographerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        savedAt: {
            type: Date,
            default: Date.now,
            index: true,
        },
        currency: {
            type: String,
            trim: true,
            default: "GHS",
            enum: ["GHS"],
        },
        invoiceNo: {
            type: String,
            required: true,
            trim: true,
        },
        invoiceDateISO: {
            type: String,
            required: true,
            trim: true,
        },
        dueDateISO: {
            type: String,
            required: true,
            trim: true,
        },
        shootDateISO: {
            type: String,
            trim: true,
            default: "",
        },
        bookingId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Booking",
            default: null,
            index: true,
        },
        clientId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            default: null,
            index: true,
        },
        title: {
            type: String,
            trim: true,
            default: "",
        },
        shootType: {
            type: String,
            trim: true,
            default: "",
        },
        billTo: {
            type: billToSchema,
            required: true,
        },
        billedFrom: {
            type: billedFromSchema,
            required: true,
        },
        notes: {
            type: String,
            trim: true,
            default: "",
        },
        items: {
            type: [invoiceItemSchema],
            validate: {
                validator(v) {
                    return Array.isArray(v) && v.length > 0
                },
                message: "At least one line item is required",
            },
        },
        taxRate: {
            type: Number,
            min: 0,
            default: 0,
        },
        subtotalGHS: {
            type: Number,
            min: 0,
            required: true,
        },
        taxGHS: {
            type: Number,
            min: 0,
            required: true,
        },
        totalGHS: {
            type: Number,
            min: 0,
            required: true,
        },
        amountPayingGHS: {
            type: Number,
            min: 0,
            default: 0,
        },
        paymentStatus: {
            type: String,
            enum: ["paid", "partial", "pending"],
            default: "pending",
        },
        paymentPercent: {
            type: Number,
            min: 0,
            max: 100,
            default: 0,
        },
    },
    { timestamps: true }
)

invoiceSchema.index({ photographerId: 1, savedAt: -1 })
invoiceSchema.index({ photographerId: 1, invoiceNo: 1 }, { unique: true })
invoiceSchema.index({ photographerId: 1, bookingId: 1 })

const Invoice = mongoose.model("Invoice", invoiceSchema)

export default Invoice
