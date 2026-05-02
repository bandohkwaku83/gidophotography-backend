import path from "path"
import crypto from "crypto"
import mongoose from "mongoose"
import Folder from "../models/Folder.js"
import Client from "../models/Client.js"
import Settings from "../models/Settings.js"
import {
    getFolderMediaCollections,
    deleteAllMediaForFolder,
    serializePublicFinal,
} from "./folderMediaController.js"
import {
    resolveShareExpiryInput,
    hasShareExpiryInput,
    SHARE_LINK_EXPIRY_PRESETS,
} from "../utils/shareLinkExpiry.js"
import { FOLDER_STATUS_VALUES } from "../constants/folderStatus.js"
import { buildGalleryShareUrl } from "../utils/shareUrl.js"
import { buildPublicAssetUrl } from "../utils/assetUrl.js"
import {
    isObjectStorageS3,
    uploadLocalFileThenRemove,
    deleteStoredAsset,
    unlinkLocalTempFile,
} from "../services/objectStorage.js"

const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/

function pickCoverFocalRaw(body, axis) {
    const keys =
        axis === "x"
            ? ["coverFocalX", "cover_focal_x"]
            : ["coverFocalY", "cover_focal_y"]
    for (const k of keys) {
        if (Object.prototype.hasOwnProperty.call(body, k)) return body[k]
    }
    return undefined
}

/** Omitted field → `undefined`; invalid → `null`; valid → clamped 0–100 */
function parseCoverFocalPercent(raw) {
    if (raw === undefined || raw === null || raw === "") return undefined
    const n =
        typeof raw === "number" && Number.isFinite(raw)
            ? raw
            : Number.parseFloat(String(raw).trim(), 10)
    if (!Number.isFinite(n)) return null
    return Math.min(100, Math.max(0, n))
}

function normalizeStoredFocal(n, fallback = 50) {
    if (n != null && Number.isFinite(n)) return n
    return fallback
}

const generateShareCode = async () => {
    for (let i = 0; i < 5; i++) {
        const code = crypto.randomBytes(4).toString("hex")
        const exists = await Folder.findOne({ "share.code": code })
        if (!exists) return code
    }
    throw new Error("Could not generate unique share code")
}

const serializeFolder = (req, folder) => {
    const obj = folder.toObject ? folder.toObject() : folder
    const exp = obj.share?.expiresAt ? new Date(obj.share.expiresAt) : null
    const shareExpired = !!(exp && exp < new Date())
    const focalX = normalizeStoredFocal(obj.coverFocalX)
    const focalY = normalizeStoredFocal(obj.coverFocalY)
    return {
        ...obj,
        status: obj.status || "draft",
        coverImageUrl: buildPublicAssetUrl(req, obj.coverImage),
        shareUrl: buildGalleryShareUrl(folder),
        shareExpired,
        coverFocalX: focalX,
        coverFocalY: focalY,
        cover_focal_x: focalX,
        cover_focal_y: focalY,
    }
}

export const createFolder = async (req, res) => {
    let coverImage = ""
    let uploadedCoverToS3 = false
    try {
        const {
            client,
            eventName,
            eventDate,
            description,
            useDefaultCover,
            linkExpiry,
            expiresAt,
        } = req.body

        if (!client || !eventName || !eventDate) {
            if (req.file) unlinkLocalTempFile(req.file.path)
            return res.status(400).json({
                message: "Client, event name and event date are required",
            })
        }

        if (!mongoose.Types.ObjectId.isValid(client)) {
            if (req.file) unlinkLocalTempFile(req.file.path)
            return res.status(400).json({ message: "Invalid client id" })
        }

        const clientDoc = await Client.findById(client)
        if (!clientDoc) {
            if (req.file) unlinkLocalTempFile(req.file.path)
            return res.status(404).json({ message: "Client not found" })
        }

        let usingDefaultCover = false

        if (req.file) {
            coverImage = path.posix.join(
                "uploads",
                "covers",
                path.basename(req.file.path)
            )
        } else if (
            useDefaultCover === true ||
            useDefaultCover === "true" ||
            useDefaultCover === "1"
        ) {
            const settings = await Settings.getSingleton()
            if (!settings.defaultCoverImage) {
                return res.status(400).json({
                    message:
                        "No default cover image is set in settings. Upload one first.",
                })
            }
            coverImage = settings.defaultCoverImage
            usingDefaultCover = true
        }

        const share = {
            enabled: true,
            code: await generateShareCode(),
            sharedAt: new Date(),
        }
        if (hasShareExpiryInput({ linkExpiry, expiresAt })) {
            const r = resolveShareExpiryInput({ linkExpiry, expiresAt })
            if (r.error) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({ message: r.error })
            }
            if (!r.unchanged) {
                share.expiresAt = r.expiresAt
                share.linkExpiryPreset = r.preset
            }
        }

        const rawFx = pickCoverFocalRaw(req.body, "x")
        const rawFy = pickCoverFocalRaw(req.body, "y")
        let coverFocalX = 50
        let coverFocalY = 50
        if (rawFx !== undefined) {
            const p = parseCoverFocalPercent(rawFx)
            if (p === null) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({
                    message: "coverFocalX must be a number from 0 to 100",
                })
            }
            coverFocalX = p
        }
        if (rawFy !== undefined) {
            const p = parseCoverFocalPercent(rawFy)
            if (p === null) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({
                    message: "coverFocalY must be a number from 0 to 100",
                })
            }
            coverFocalY = p
        }

        if (req.file && isObjectStorageS3()) {
            await uploadLocalFileThenRemove(
                req.file.path,
                coverImage,
                req.file.mimetype
            )
            uploadedCoverToS3 = true
        }

        const folder = await Folder.create({
            client,
            eventName: eventName.trim(),
            eventDate,
            description: description ? description.trim() : "",
            coverImage,
            usingDefaultCover,
            coverFocalX,
            coverFocalY,
            createdBy: req.user?._id,
            share,
        })

        const populated = await folder.populate("client", "name email contact location")

        return res.status(201).json({
            message: "Folder created successfully",
            folder: serializeFolder(req, populated),
        })
    } catch (error) {
        if (uploadedCoverToS3 && coverImage) {
            await deleteStoredAsset(coverImage).catch(() => {})
        } else if (req.file) {
            unlinkLocalTempFile(req.file.path)
        }
        console.error("Create folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getFolders = async (req, res) => {
    try {
        const { clientId, search } = req.query

        const filter = {}
        if (clientId && mongoose.Types.ObjectId.isValid(clientId)) {
            filter.client = clientId
        }
        if (search) {
            filter.$or = [
                { eventName: { $regex: search, $options: "i" } },
                { description: { $regex: search, $options: "i" } },
            ]
        }

        const folders = await Folder.find(filter)
            .populate("client", "name email contact location")
            .sort({ eventDate: -1, createdAt: -1 })

        return res.status(200).json({
            count: folders.length,
            folders: folders.map((f) => serializeFolder(req, f)),
        })
    } catch (error) {
        console.error("Get folders error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getFolder = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id).populate(
            "client",
            "name email contact location"
        )
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const media = await getFolderMediaCollections(req, folder._id)

        return res.status(200).json({
            folder: {
                ...serializeFolder(req, folder),
                ...media,
            },
        })
    } catch (error) {
        console.error("Get folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const updateFolder = async (req, res) => {
    try {
        const { id } = req.params
        const {
            client,
            eventName,
            eventDate,
            description,
            useDefaultCover,
            status,
        } = req.body

        if (!mongoose.Types.ObjectId.isValid(id)) {
            if (req.file) unlinkLocalTempFile(req.file.path)
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            if (req.file) unlinkLocalTempFile(req.file.path)
            return res.status(404).json({ message: "Folder not found" })
        }

        if (client !== undefined) {
            if (!mongoose.Types.ObjectId.isValid(client)) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({ message: "Invalid client id" })
            }
            const clientDoc = await Client.findById(client)
            if (!clientDoc) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(404).json({ message: "Client not found" })
            }
            folder.client = client
        }

        if (eventName !== undefined) {
            if (!eventName || !eventName.trim()) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res
                    .status(400)
                    .json({ message: "Event name cannot be empty" })
            }
            folder.eventName = eventName.trim()
        }
        if (eventDate !== undefined) folder.eventDate = eventDate
        if (description !== undefined)
            folder.description = description ? description.trim() : ""

        if (status !== undefined) {
            if (!FOLDER_STATUS_VALUES.includes(status)) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({
                    message: `status must be one of: ${FOLDER_STATUS_VALUES.join(", ")}`,
                })
            }
            folder.status = status
        }

        if (req.file) {
            const newCoverPath = path.posix.join(
                "uploads",
                "covers",
                path.basename(req.file.path)
            )
            if (isObjectStorageS3()) {
                await uploadLocalFileThenRemove(
                    req.file.path,
                    newCoverPath,
                    req.file.mimetype
                )
            }
            if (!folder.usingDefaultCover) {
                await deleteStoredAsset(folder.coverImage)
            }
            folder.coverImage = newCoverPath
            folder.usingDefaultCover = false
        } else if (
            useDefaultCover === true ||
            useDefaultCover === "true" ||
            useDefaultCover === "1"
        ) {
            const settings = await Settings.getSingleton()
            if (!settings.defaultCoverImage) {
                return res.status(400).json({
                    message:
                        "No default cover image is set in settings. Upload one first.",
                })
            }
            if (!folder.usingDefaultCover)
                await deleteStoredAsset(folder.coverImage)
            folder.coverImage = settings.defaultCoverImage
            folder.usingDefaultCover = true
        }

        const rawFx = pickCoverFocalRaw(req.body, "x")
        const rawFy = pickCoverFocalRaw(req.body, "y")
        if (rawFx !== undefined) {
            const p = parseCoverFocalPercent(rawFx)
            if (p === null) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({
                    message: "coverFocalX must be a number from 0 to 100",
                })
            }
            folder.coverFocalX = p
        }
        if (rawFy !== undefined) {
            const p = parseCoverFocalPercent(rawFy)
            if (p === null) {
                if (req.file) unlinkLocalTempFile(req.file.path)
                return res.status(400).json({
                    message: "coverFocalY must be a number from 0 to 100",
                })
            }
            folder.coverFocalY = p
        }

        await folder.save()
        const populated = await folder.populate(
            "client",
            "name email contact location"
        )

        return res.status(200).json({
            message: "Folder updated successfully",
            folder: serializeFolder(req, populated),
        })
    } catch (error) {
        if (req.file) unlinkLocalTempFile(req.file.path)
        console.error("Update folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const shareFolder = async (req, res) => {
    try {
        const { id } = req.params
        const { slug, regenerate } = req.body

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id).lean()
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const $set = {}
        const $unset = {}

        if (slug !== undefined && slug !== "" && slug !== null) {
            const cleanSlug = String(slug).toLowerCase().trim()
            if (!SLUG_REGEX.test(cleanSlug)) {
                return res.status(400).json({
                    message:
                        "Slug must be 1-60 chars, lowercase letters, digits and hyphens only",
                })
            }
            const taken = await Folder.findOne({
                "share.slug": cleanSlug,
                _id: { $ne: folder._id },
            })
            if (taken) {
                return res
                    .status(409)
                    .json({ message: "That slug is already taken" })
            }
            $set["share.slug"] = cleanSlug
        } else if (slug === "" || slug === null) {
            $unset["share.slug"] = ""
        }

        const needNewCode =
            !folder.share?.code ||
            regenerate === true ||
            regenerate === "true"
        $set["share.code"] = needNewCode
            ? await generateShareCode()
            : folder.share.code

        if (hasShareExpiryInput(req.body)) {
            const r = resolveShareExpiryInput(req.body)
            if (r.error) {
                return res.status(400).json({ message: r.error })
            }
            if (!r.unchanged) {
                $set["share.expiresAt"] = r.expiresAt
                $set["share.linkExpiryPreset"] = r.preset
            }
        }

        $set["share.enabled"] = true
        $set["share.sharedAt"] = folder.share?.sharedAt
            ? new Date(folder.share.sharedAt)
            : new Date()

        const mongoUpdate = { $set: $set }
        if (Object.keys($unset).length) mongoUpdate.$unset = $unset

        const populated = await Folder.findByIdAndUpdate(id, mongoUpdate, {
            new: true,
        }).populate("client", "name email contact location")

        return res.status(200).json({
            message: "Folder shared successfully",
            folder: serializeFolder(req, populated),
        })
    } catch (error) {
        console.error("Share folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const regenerateShareLink = async (req, res) => {
    try {
        const { id } = req.params
        const { clearSlug } = req.body || {}

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id).lean()
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const $set = {
            "share.code": await generateShareCode(),
            "share.enabled": true,
            "share.sharedAt": folder.share?.sharedAt
                ? new Date(folder.share.sharedAt)
                : new Date(),
        }

        if (hasShareExpiryInput(req.body)) {
            const r = resolveShareExpiryInput(req.body)
            if (r.error) {
                return res.status(400).json({ message: r.error })
            }
            if (!r.unchanged) {
                $set["share.expiresAt"] = r.expiresAt
                $set["share.linkExpiryPreset"] = r.preset
            }
        }

        const mongoUpdate = { $set: $set }
        if (clearSlug === true || clearSlug === "true") {
            mongoUpdate.$unset = { "share.slug": "" }
        }

        const populated = await Folder.findByIdAndUpdate(id, mongoUpdate, {
            new: true,
        }).populate("client", "name email contact location")

        return res.status(200).json({
            message:
                "Share link regenerated. Old URLs with the previous code no longer work.",
            folder: serializeFolder(req, populated),
        })
    } catch (error) {
        console.error("Regenerate share link error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const listShareLinkExpiryPresets = (req, res) => {
    return res.status(200).json({ presets: SHARE_LINK_EXPIRY_PRESETS })
}

export const patchFolderShare = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id).lean()
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const body = req.body || {}
        const hasSlugInput = Object.prototype.hasOwnProperty.call(body, "slug")
        const hasClientSelectionAdminInput =
            Object.prototype.hasOwnProperty.call(body, "selectionLocked") ||
            body.clearSelectionSubmit === true ||
            body.clearSelectionSubmit === "true"

        if (
            !hasShareExpiryInput(body) &&
            !hasSlugInput &&
            !hasClientSelectionAdminInput
        ) {
            return res.status(400).json({
                message:
                    "Nothing to update. Send slug, linkExpiry / expiresAt, selectionLocked, or clearSelectionSubmit.",
            })
        }

        const { slug, selectionLocked, clearSelectionSubmit } = body

        const $set = {}
        const $unset = {}

        if (selectionLocked !== undefined) {
            $set["share.selectionLocked"] = Boolean(selectionLocked)
        }
        if (clearSelectionSubmit === true || clearSelectionSubmit === "true") {
            $set["share.selectionSubmittedAt"] = null
        }

        if (slug !== undefined && slug !== "" && slug !== null) {
            const cleanSlug = String(slug).toLowerCase().trim()
            if (!SLUG_REGEX.test(cleanSlug)) {
                return res.status(400).json({
                    message:
                        "Slug must be 1-60 chars, lowercase letters, digits and hyphens only",
                })
            }
            const taken = await Folder.findOne({
                "share.slug": cleanSlug,
                _id: { $ne: folder._id },
            })
            if (taken) {
                return res
                    .status(409)
                    .json({ message: "That slug is already taken" })
            }
            $set["share.slug"] = cleanSlug
        } else if (slug === "" || slug === null) {
            $unset["share.slug"] = ""
        }

        if (hasShareExpiryInput(req.body)) {
            const r = resolveShareExpiryInput(req.body)
            if (r.error) {
                return res.status(400).json({ message: r.error })
            }
            if (!r.unchanged) {
                $set["share.expiresAt"] = r.expiresAt
                $set["share.linkExpiryPreset"] = r.preset
            }
        }

        const mongoUpdate = {}
        if (Object.keys($set).length) mongoUpdate.$set = $set
        if (Object.keys($unset).length) mongoUpdate.$unset = $unset
        if (!mongoUpdate.$set && !mongoUpdate.$unset) {
            return res.status(400).json({
                message: "No changes to apply for the fields you sent.",
            })
        }

        const populated = await Folder.findByIdAndUpdate(id, mongoUpdate, {
            new: true,
        }).populate("client", "name email contact location")

        return res.status(200).json({
            message: "Share settings updated",
            folder: serializeFolder(req, populated),
        })
    } catch (error) {
        console.error("Patch folder share error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const unshareFolder = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findByIdAndUpdate(
            id,
            { $set: { "share.enabled": false } },
            { new: true }
        ).populate("client", "name email contact location")

        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        return res.status(200).json({
            message: "Folder is no longer shared",
            folder: serializeFolder(req, folder),
        })
    } catch (error) {
        console.error("Unshare folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getSharedFolder = async (req, res) => {
    try {
        const { identifier } = req.params

        const folder = await Folder.findOne({
            "share.enabled": true,
            $or: [{ "share.slug": identifier }, { "share.code": identifier }],
        }).populate("client", "name")

        if (!folder) {
            return res
                .status(404)
                .json({ message: "Shared folder not found or no longer available" })
        }

        if (folder.share.expiresAt && folder.share.expiresAt < new Date()) {
            return res
                .status(410)
                .json({ message: "This share link has expired" })
        }

        folder.share.viewCount = (folder.share.viewCount || 0) + 1
        await folder.save()

        const settings = await Settings.getSingleton()
        const media = await getFolderMediaCollections(req, folder._id, {
            clientGallery: Boolean(settings.watermarkPreviewImages),
        })
        const obj = folder.toObject()
        const finals = media.finals.map((f) =>
            serializePublicFinal(req, identifier, f)
        )
        const focalX = normalizeStoredFocal(obj.coverFocalX)
        const focalY = normalizeStoredFocal(obj.coverFocalY)

        return res.status(200).json({
            folder: {
                _id: obj._id,
                eventName: obj.eventName,
                client: obj.client ? { name: obj.client.name } : null,
                eventDate: obj.eventDate,
                description: obj.description,
                coverImage: obj.coverImage,
                coverImageUrl: buildPublicAssetUrl(req, obj.coverImage),
                coverFocalX: focalX,
                coverFocalY: focalY,
                cover_focal_x: focalX,
                cover_focal_y: focalY,
                selectionSubmitted: Boolean(obj.share?.selectionSubmittedAt),
                share: {
                    slug: obj.share.slug,
                    code: obj.share.code,
                    expiresAt: obj.share.expiresAt,
                    linkExpiryPreset: obj.share.linkExpiryPreset,
                    viewCount: obj.share.viewCount,
                    sharedAt: obj.share.sharedAt,
                    selectionSubmittedAt: obj.share.selectionSubmittedAt,
                    selectionLocked: Boolean(obj.share.selectionLocked),
                },
                canEditSelections: !obj.share.selectionLocked,
                counts: {
                    uploads: media.uploads.length,
                    selected: media.selection.length,
                    finals: finals.length,
                },
                uploads: media.uploads,
                selection: media.selection,
                finals,
            },
        })
    } catch (error) {
        console.error("Get shared folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteFolder = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        await deleteAllMediaForFolder(folder._id)

        if (!folder.usingDefaultCover) {
            await deleteStoredAsset(folder.coverImage)
        }

        await Folder.deleteOne({ _id: folder._id })

        return res
            .status(200)
            .json({ message: "Folder deleted successfully", folder })
    } catch (error) {
        console.error("Delete folder error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
