import mongoose from "mongoose"
import { NOTIFICATION_TYPES } from "../constants/notificationTypes.js"

const notificationSchema = new mongoose.Schema(
    {
        recipient: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
            required: true,
            index: true,
        },
        type: {
            type: String,
            enum: NOTIFICATION_TYPES,
            required: true,
            index: true,
        },
        title: {
            type: String,
            required: true,
            trim: true,
            maxlength: 200,
        },
        body: {
            type: String,
            trim: true,
            default: "",
            maxlength: 2000,
        },
        readAt: {
            type: Date,
            default: null,
            index: true,
        },
        folder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Folder",
            default: null,
            index: true,
        },
        booking: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Booking",
            default: null,
            index: true,
        },
        /** Share slug or code so admin UI can deep-link to the client gallery. */
        shareIdentifier: {
            type: String,
            trim: true,
            default: "",
        },
    },
    { timestamps: true }
)

notificationSchema.index({ recipient: 1, createdAt: -1 })
notificationSchema.index({ recipient: 1, readAt: 1, createdAt: -1 })

const Notification = mongoose.model("Notification", notificationSchema)

export default Notification
