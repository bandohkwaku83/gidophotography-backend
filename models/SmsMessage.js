import mongoose from "mongoose"

const smsMessageSchema = new mongoose.Schema(
    {
        recipientName: { type: String, trim: true, default: "" },
        recipientPhone: { type: String, trim: true, required: true },
        recipientKind: {
            type: String,
            enum: ["individual", "contact"],
            default: "individual",
        },
        message: { type: String, required: true },
        messageLength: { type: Number, required: true },
        status: {
            type: String,
            enum: ["pending", "sent", "failed"],
            default: "pending",
        },
        /** Display cost in GH₵; optional env SMS_COST_PER_MESSAGE_GHS when API does not return local currency */
        costGHS: { type: Number, default: 0 },
        errorMessage: { type: String, default: "" },
        arkeselRaw: { type: mongoose.Schema.Types.Mixed, default: null },
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            default: null,
        },
        folder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Folder",
            default: null,
        },
        recipientType: {
            type: String,
            enum: ["all_clients", "client"],
            required: true,
        },
        trigger: {
            type: String,
            enum: ["manual", "raw_upload", "final_upload", "final_delivery_unpaid"],
            default: "manual",
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
    },
    { timestamps: true }
)

smsMessageSchema.index({ createdAt: -1 })
smsMessageSchema.index({ status: 1, createdAt: -1 })

const SmsMessage = mongoose.model("SmsMessage", smsMessageSchema)

export default SmsMessage
