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
        /** WebP grid image. Points at one `variants` file (closest to the thumb edge). */
        thumbPath: {
            type: String,
            default: "",
        },
        /** Oriented pixel size. Use with `height` so the page can reserve space before the file loads. */
        width: { type: Number, default: 0 },
        height: { type: Number, default: 0 },
        /** Short BlurHash string. The gallery draws this blurred, then fades in the real photo. */
        blurHash: { type: String, default: "" },
        /**
         * WebP copies at a few widths for srcset. The original `filePath` is unchanged.
         */
        variants: {
            type: [
                {
                    _id: false,
                    width: { type: Number, required: true },
                    path: { type: String, required: true },
                },
            ],
            default: [],
        },
        /** Logo-stamped copy of a final still. Client view and downloads use this when the folder mark is on. */
        markedFilePath: { type: String, default: "" },
        markedThumbPath: { type: String, default: "" },
        markedVariants: {
            type: [
                {
                    _id: false,
                    width: { type: Number, required: true },
                    path: { type: String, required: true },
                },
            ],
            default: [],
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
        /** Manual gallery order within kind (+ set). Omitted/null = fall back to createdAt. */
        sortOrder: {
            type: Number,
            default: null,
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
folderMediaSchema.index({ folder: 1, deletedAt: 1 })

const FolderMedia = mongoose.model("FolderMedia", folderMediaSchema)

export default FolderMedia
export { EDIT_STATUSES }
