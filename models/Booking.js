import mongoose from "mongoose"
import { BOOKING_SHOOT_TYPES } from "../constants/bookingShootTypes.js"

const bookingSchema = new mongoose.Schema(
    {
        title: {
            type: String,
            required: true,
            trim: true,
        },
        /** Selected CRM client (dropdown); name/contact come from this record. */
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
            index: true,
        },
        shootType: {
            type: String,
            enum: BOOKING_SHOOT_TYPES,
            required: true,
        },
        /** Combined date + start time (use for calendar ordering and range queries). */
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
        description: {
            type: String,
            trim: true,
            default: "",
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
        /** In-app admin notification for upcoming shoot (once per booking window). */
        reminderAdminInAppSentAt: {
            type: Date,
            default: null,
        },
    },
    { timestamps: true }
)

bookingSchema.index({ startsAt: 1, shootType: 1 })
bookingSchema.index({ createdBy: 1, startsAt: -1 })
bookingSchema.index({ client: 1 })

const Booking = mongoose.model("Booking", bookingSchema)

export default Booking
