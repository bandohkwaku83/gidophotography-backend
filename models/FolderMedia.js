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
    },
    { timestamps: true }
)

folderMediaSchema.index({ folder: 1, kind: 1, createdAt: 1 })

const FolderMedia = mongoose.model("FolderMedia", folderMediaSchema)

export default FolderMedia
export { EDIT_STATUSES }
