import mongoose from "mongoose"

const folderSetSchema = new mongoose.Schema(
    {
        folder: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "Folder",
            required: true,
            index: true,
        },
        name: {
            type: String,
            required: true,
            trim: true,
            maxlength: 120,
        },
        sortOrder: {
            type: Number,
            default: 0,
        },
        deletedAt: { type: Date, default: null, index: true },
    },
    { timestamps: true }
)

folderSetSchema.index({ folder: 1, deletedAt: 1, sortOrder: 1, createdAt: 1 })

const FolderSet = mongoose.model("FolderSet", folderSetSchema)

export default FolderSet
