import mongoose from "mongoose"

const EDIT_STATUSES = ["pending", "in_progress", "done"]

const folderMediaSchema = new mongoose.Schema(
    {
        folder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Folder",
            required: true,
            index: true,
        },
        /** Optional sub-gallery (set) within the folder. */
        set: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FolderSet",
            default: null,
            index: true,
        },
        kind: {
            type: String,
            enum: ["raw", "selection", "final"],
            required: true,
            index: true,
        },
        filePath: {
            type: String,
            default: "",
        },
        /** Watermarked JPEG for client gallery when settings.watermarkPreviewImages is on. */
        displayFilePath: {
            type: String,
            default: "",
        },
        /** WebP thumbnail (e.g. max 800px edge); grid/list URLs should prefer this over `filePath`. */
        thumbPath: {
            type: String,
            default: "",
        },
        originalFilename: {
            type: String,
            default: "",
        },
        mimeType: {
            type: String,
            default: "",
        },
        size: {
            type: Number,
            default: 0,
        },
        rawMediaId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FolderMedia",
            default: null,
        },
        selectionMediaId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "FolderMedia",
            default: null,
        },
        editStatus: {
            type: String,
            enum: EDIT_STATUSES,
            default: "pending",
        },
        /** Display order within folder + set + kind (lower = shown first). */
        sortOrder: {
            type: Number,
            default: null,
        },
        /** Trash (soft-delete). Omitted/`null` = active in galleries. */
        deletedAt: { type: Date, default: null, index: true },
        /**
         * How the row was tombstoned: `media` = admin deleted asset; `folder` = gallery delete cascade (restored only with gallery restore).
         */
        deletedBy: {
            type: String,
            enum: ["folder", "media"],
            default: null,
        },
    },
    { timestamps: true }
)

folderMediaSchema.index({ folder: 1, kind: 1, createdAt: 1 })
folderMediaSchema.index({ folder: 1, set: 1, kind: 1, sortOrder: 1, createdAt: 1 })
folderMediaSchema.index({ folder: 1, deletedAt: 1 })

const FolderMedia = mongoose.model("FolderMedia", folderMediaSchema)

export default FolderMedia
export { EDIT_STATUSES }
