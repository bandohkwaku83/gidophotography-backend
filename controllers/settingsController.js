import path from "path"
import Settings from "../models/Settings.js"
import { buildPublicAssetUrl } from "../utils/assetUrl.js"
import {
    deleteStoredAsset,
    uploadLocalFileThenRemove,
    isObjectStorageS3,
} from "../services/objectStorage.js"

const serializeSettings = (req, settings) => ({
    _id: settings._id,
    defaultCoverImage: settings.defaultCoverImage,
    defaultCoverImageUrl: buildPublicAssetUrl(req, settings.defaultCoverImage),
    watermarkPreviewImages: settings.watermarkPreviewImages,
    updatedAt: settings.updatedAt,
})

const parseBoolean = (value) => {
    if (typeof value === "boolean") return value
    if (typeof value === "string") {
        const v = value.toLowerCase().trim()
        if (["true", "1", "on", "yes"].includes(v)) return true
        if (["false", "0", "off", "no"].includes(v)) return false
    }
    return undefined
}

export const getSettings = async (req, res) => {
    try {
        const settings = await Settings.getSingleton()
        return res.status(200).json({ settings: serializeSettings(req, settings) })
    } catch (error) {
        console.error("Get settings error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const updateSettings = async (req, res) => {
    try {
        const settings = await Settings.getSingleton()

        if (req.file) {
            if (settings.defaultCoverImage) {
                await deleteStoredAsset(settings.defaultCoverImage)
            }
            const newPath = path.posix.join(
                "uploads",
                "settings",
                path.basename(req.file.path)
            )
            if (isObjectStorageS3()) {
                await uploadLocalFileThenRemove(
                    req.file.path,
                    newPath,
                    req.file.mimetype
                )
            }
            settings.defaultCoverImage = newPath
        }

        if (req.body && req.body.watermarkPreviewImages !== undefined) {
            const parsed = parseBoolean(req.body.watermarkPreviewImages)
            if (parsed !== undefined) settings.watermarkPreviewImages = parsed
        }

        await settings.save()

        return res.status(200).json({
            message: "Settings updated successfully",
            settings: serializeSettings(req, settings),
        })
    } catch (error) {
        console.error("Update settings error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const resetSettings = async (req, res) => {
    try {
        const settings = await Settings.getSingleton()

        if (settings.defaultCoverImage) {
            await deleteStoredAsset(settings.defaultCoverImage)
        }
        settings.defaultCoverImage = ""
        settings.watermarkPreviewImages = false

        await settings.save()

        return res.status(200).json({
            message: "Settings reset to defaults",
            settings: serializeSettings(req, settings),
        })
    } catch (error) {
        console.error("Reset settings error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
