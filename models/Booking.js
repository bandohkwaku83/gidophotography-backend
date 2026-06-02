import mongoose from "mongoose"

const bookingSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
            index: true,
        },
        /** Shoot category slug (see GET /api/bookings/meta). */
        category: {
            type: String,
            required: true,
            trim: true,
            index: true,
        },
        /** Display label denormalized from category. */
        shootType: {
            type: String,
            required: true,
            trim: true,
        },
        startsAt: {
            type: Date,
            required: true,
            index: true,
        },
        endsAt: {
            type: Date,
            default: null,
        },
        location: {
            type: String,
            trim: true,
            default: "",
        },
        notes: {
            type: String,
            trim: true,
            default: "",
        },
        /** @deprecated Prefer `notes`; kept for older clients. */
        description: {
            type: String,
            trim: true,
            default: "",
        },
        amountCharged: {
            type: Number,
            min: 0,
            default: 0,
        },
        currency: {
            type: String,
            trim: true,
            default: "GHS",
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
        reminderClientSentAt: {
            type: Date,
            default: null,
        },
        reminderAdminSentAt: {
            type: Date,
            default: null,
        },
        reminderAdminInAppSentAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
)

bookingSchema.index({ startsAt: 1, category: 1 })
bookingSchema.index({ createdBy: 1, startsAt: -1 })
bookingSchema.index({ client: 1 })

const Booking = mongoose.model("Booking", bookingSchema)

export default Booking
