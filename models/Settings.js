import mongoose from "mongoose"

const settingsSchema = new mongoose.Schema(
    {
        key: {
            type: String,
            default: "global",
            unique: true,
        },
        defaultCoverImage: {
            type: String,
            default: "",
        },
        watermarkPreviewImages: {
            type: Boolean,
            default: false,
        },
    },
    { timestamps: true }
)

settingsSchema.statics.getSingleton = async function () {
    let doc = await this.findOne({ key: "global" })
    if (!doc) doc = await this.create({ key: "global" })
    return doc
}

const Settings = mongoose.model("Settings", settingsSchema)

export default Settings
