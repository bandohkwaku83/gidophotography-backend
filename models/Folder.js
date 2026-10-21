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
            /** Max client picks; null = unlimited. */
            maxClientSelections: { type: Number, default: null, min: 1, max: 9999 },
        },
        /** Final delivery payment / lock (admin multipart on final upload + manual unlock). */
        finalDelivery: {
            outstandingAmountGHS: { type: Number, default: null },
            imagesLocked: { type: Boolean, default: false },
        },
        /**
         * Per-folder logo stamped onto final stills for the client gallery and downloads.
         * The admin grid keeps the clean original and may still draw its own preview.
         */
        galleryMark: {
            enabled: { type: Boolean, default: false },
            position: {
                type: String,
                enum: [
                    "top-left",
                    "top-center",
                    "top-right",
                    "middle-left",
                    "center",
                    "middle-right",
                    "bottom-left",
                    "bottom-center",
                    "bottom-right",
                ],
                default: "bottom-right",
            },
            /** Logo width as a percent of the photo’s shorter side. */
            size: { type: Number, default: 18, min: 8, max: 36 },
            /** 15–100. Drawn at this percent. */
            opacity: { type: Number, default: 90, min: 15, max: 100 },
            /** Margin from the chosen edge, percent of the shorter side. Ignored for center. */
            inset: { type: Number, default: 5, min: 2, max: 16 },
            plate: { type: Boolean, default: true },
            /** Stored logo file (`uploads/gallery-marks/...`). Never a data URL. */
            logoPath: { type: String, default: "", trim: true },
            logoName: { type: String, default: "", trim: true },
        },
        /** Custom label for the virtual “show everything” tab (dashboard / client). */
        allMediaLabel: {
            type: String,
            trim: true,
            default: "",
        },
        /** Custom label for uncategorized media (setId: null). */
        generalSetLabel: {
            type: String,
            trim: true,
            default: "",
        },
        /** Tab sort position of General among collection buckets (named sets use FolderSet.sortOrder). */
        generalSetSortOrder: {
            type: Number,
            default: -1,
        },
        /** Set when gallery is deleted; restore within SOFT_DELETE_RETENTION_DAYS before purge cron removes permanently. */
        deletedAt: { type: Date, default: null, index: true },
    },
    { timestamps: true }
)

const Folder = mongoose.model("Folder", folderSchema)

export default Folder
