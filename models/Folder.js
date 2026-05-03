import mongoose from "mongoose"
import { FOLDER_STATUS_VALUES } from "../constants/folderStatus.js"

const folderSchema = new mongoose.Schema(
    {
        client: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Client",
            required: true,
        },
        eventName: {
            type: String,
            required: true,
            trim: true,
        },
        eventDate: {
            type: Date,
            required: true,
        },
        description: {
            type: String,
            trim: true,
            default: "",
        },
        coverImage: {
            type: String,
            default: "",
        },
        usingDefaultCover: {
            type: Boolean,
            default: false,
        },
        /** Stored path under uploads/... (same pattern as coverImage); optional gallery BGM */
        backgroundMusic: {
            type: String,
            default: "",
            trim: true,
        },
        backgroundMusicEnabled: {
            type: Boolean,
            default: true,
        },
        /** 0–100; maps to object-position % for custom covers */
        coverFocalX: {
            type: Number,
            default: 50,
            min: 0,
            max: 100,
        },
        coverFocalY: {
            type: Number,
            default: 50,
            min: 0,
            max: 100,
        },
        createdBy: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "User",
        },
        status: {
            type: String,
            enum: FOLDER_STATUS_VALUES,
            default: "draft",
        },
        share: {
            enabled: { type: Boolean, default: false },
            code: { type: String, index: true, sparse: true, unique: true },
            slug: {
                type: String,
                index: true,
                sparse: true,
                unique: true,
                lowercase: true,
                trim: true,
            },
            expiresAt: { type: Date, default: null },
            linkExpiryPreset: {
                type: String,
                default: null,
                trim: true,
            },
            viewCount: { type: Number, default: 0 },
            sharedAt: { type: Date, default: null },
            selectionSubmittedAt: { type: Date, default: null },
            selectionLocked: { type: Boolean, default: false },
        },
        /** Final delivery payment / lock (admin multipart on final upload + manual unlock). */
        finalDelivery: {
            outstandingAmountGHS: { type: Number, default: null },
            imagesLocked: { type: Boolean, default: false },
        },
    },
    { timestamps: true }
)

const Folder = mongoose.model("Folder", folderSchema)

export default Folder
