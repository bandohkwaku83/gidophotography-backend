import fs from "fs"
import path from "path"
import mongoose from "mongoose"
import Folder from "../models/Folder.js"
import FolderMedia, { EDIT_STATUSES } from "../models/FolderMedia.js"
import { FOLDER_STATUS_VALUES } from "../constants/folderStatus.js"
import { collectFolderUploadFiles } from "../middleware/upload.js"
import {
    scheduleRawUploadSms,
    scheduleFinalUploadSms,
} from "../services/uploadSmsNotifications.js"
import {
    readUploadCompleteNotify,
    readDuplicateAction,
} from "../utils/multipartFlags.js"
import { findDuplicateFolderMedia } from "../utils/duplicateUpload.js"
import Settings from "../models/Settings.js"
import {
    generateRawDisplayAsset,
    buildWatermarkedDisplayPaths,
} from "../utils/rawDisplayWatermark.js"
import { buildPublicAssetUrl } from "../utils/assetUrl.js"
import {
    isObjectStorageS3,
    uploadLocalFileThenRemove,
    deleteStoredAsset,
    unlinkLocalTempFile,
    getObjectStreamForStoredPath,
    readStoredAssetBufferLimited,
    resolveLocalAbsolutePath,
} from "../services/objectStorage.js"
import { readFinalDeliveryPaymentFromReq } from "../utils/finalDeliveryMultipart.js"
import {
    pipeLockedFinalJpegToResponse,
    isRasterImageMime,
} from "../utils/finalLockedPreview.js"

export const buildPublicUrl = buildPublicAssetUrl

export const serializeRawUpload = (req, doc, opts = {}) => {
    const { maskOriginalWithDisplay = false } = opts
    const originalUrl = buildPublicUrl(req, doc.filePath)
    const displayUrl = doc.displayFilePath
        ? buildPublicUrl(req, doc.displayFilePath)
        : ""
    const useDisplay = maskOriginalWithDisplay && displayUrl
    const out = {
        _id: doc._id,
        url: useDisplay ? displayUrl : originalUrl,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        size: doc.size,
        createdAt: doc.createdAt,
    }
    if (!maskOriginalWithDisplay && displayUrl) out.displayUrl = displayUrl
    return out
}

export const serializeSelection = (req, doc, opts = {}) => {
    const { maskNestedRaw = false } = opts
    const raw = doc.rawMediaId
    const rawObj =
        raw && typeof raw === "object" && raw.filePath
            ? serializeRawUpload(req, raw, {
                  maskOriginalWithDisplay: maskNestedRaw,
              })
            : null
    return {
        _id: doc._id,
        editStatus: doc.editStatus,
        raw: rawObj,
        rawMediaId: doc.rawMediaId?._id || doc.rawMediaId,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    }
}

export const serializeFinal = (req, doc) => ({
    _id: doc._id,
    url: buildPublicUrl(req, doc.filePath),
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    size: doc.size,
    selectionMediaId: doc.selectionMediaId || null,
    createdAt: doc.createdAt,
})

/** @param {{ imagesLocked?: boolean }} opts */
export const serializePublicFinal = (req, identifier, f, opts = {}) => {
    const ident = encodeURIComponent(String(identifier))
    const host = `${req.protocol}://${req.get("host")}`
    if (opts.imagesLocked) {
        return {
            ...f,
            url: `${host}/api/share/${ident}/finals/${f._id}/locked-preview`,
            locked: true,
            rightsNote:
                "Payment lock: downloads are disabled and only watermarked previews are available. True screenshot prevention is not possible over HTTP; the gallery app should add UX mitigations (e.g. overlays, blur, user education).",
        }
    }
    return {
        ...f,
        downloadUrl: `${host}/api/share/${ident}/finals/${f._id}/download`,
    }
}

export const folderFinalImagesLocked = (folder) =>
    Boolean(folder?.finalDelivery?.imagesLocked)

const loadActiveSharedFolder = async (identifier) => {
    const folder = await Folder.findOne({
        "share.enabled": true,
        $or: [{ "share.slug": identifier }, { "share.code": identifier }],
    })
    if (!folder) {
        return {
            error: { status: 404, message: "Shared folder not found or no longer available" },
        }
    }
    if (folder.share.expiresAt && folder.share.expiresAt < new Date()) {
        return { error: { status: 410, message: "This share link has expired" } }
    }
    return { folder }
}

export const getFolderMediaCollections = async (
    req,
    folderId,
    { clientGallery = false } = {}
) => {
    const [rawDocs, selectionDocs, finalDocs] = await Promise.all([
        FolderMedia.find({ folder: folderId, kind: "raw" }).sort({
            createdAt: 1,
        }),
        FolderMedia.find({ folder: folderId, kind: "selection" })
            .sort({ createdAt: 1 })
            .populate("rawMediaId"),
        FolderMedia.find({ folder: folderId, kind: "final" }).sort({
            createdAt: 1,
        }),
    ])

    const rawOpts = { maskOriginalWithDisplay: clientGallery }
    const selOpts = { maskNestedRaw: clientGallery }

    return {
        uploads: rawDocs.map((d) => serializeRawUpload(req, d, rawOpts)),
        selection: selectionDocs.map((d) =>
            serializeSelection(req, d, selOpts)
        ),
        finals: finalDocs.map((d) => serializeFinal(req, d)),
    }
}

const rollbackCreatedMedia = async (created) => {
    for (const { doc, diskPath, displayDiskPath } of created) {
        if (isObjectStorageS3()) {
            await deleteStoredAsset(doc.filePath)
            if (doc.displayFilePath) await deleteStoredAsset(doc.displayFilePath)
        } else {
            unlinkLocalTempFile(diskPath)
            unlinkLocalTempFile(displayDiskPath)
        }
        await FolderMedia.deleteOne({ _id: doc._id }).catch(() => {})
    }
}

/** Replace-in-place so selections linked by raw _id stay valid. */
async function replaceExistingRawMedia(req, existingDoc, f, folderId, watermarkOn) {
    const oldMain = existingDoc.filePath
    const oldDisp = existingDoc.displayFilePath || ""

    const newMainPath = path.posix.join(
        "uploads",
        "folders",
        folderId,
        "raw",
        path.basename(f.path)
    )

    existingDoc.displayFilePath = ""
    let displayDiskPath
    if (watermarkOn) {
        const { absolutePath, relativePath } = buildWatermarkedDisplayPaths(
            f.path,
            folderId
        )
        const gen = await generateRawDisplayAsset({
            sourcePath: f.path,
            outputAbsolutePath: absolutePath,
            relativePath,
            mimeType: f.mimetype,
        })
        if (gen.ok) {
            existingDoc.displayFilePath = relativePath
            displayDiskPath = absolutePath
        } else {
            console.warn(
                "Watermark display not generated (replace):",
                f.originalname,
                gen.error
            )
        }
    }

    existingDoc.filePath = newMainPath
    existingDoc.originalFilename = f.originalname
    existingDoc.mimeType = f.mimetype
    existingDoc.size = f.size

    if (isObjectStorageS3()) {
        await uploadLocalFileThenRemove(f.path, newMainPath, existingDoc.mimeType)
        if (existingDoc.displayFilePath && displayDiskPath) {
            await uploadLocalFileThenRemove(
                displayDiskPath,
                existingDoc.displayFilePath,
                "image/jpeg"
            )
        }
    }

    await existingDoc.save()

    await deleteStoredAsset(oldMain)
    if (oldDisp) await deleteStoredAsset(oldDisp)

    return existingDoc
}

/** Replace-in-place; optional selectionMediaIdUpdate only when caller passes a value. */
async function replaceExistingFinalMedia(
    existingDoc,
    f,
    folderId,
    selectionMediaIdUpdate
) {
    const oldPath = existingDoc.filePath
    const newPath = path.posix.join(
        "uploads",
        "folders",
        folderId,
        "finals",
        path.basename(f.path)
    )

    existingDoc.filePath = newPath
    existingDoc.originalFilename = f.originalname
    existingDoc.mimeType = f.mimetype
    existingDoc.size = f.size
    if (selectionMediaIdUpdate !== undefined) {
        existingDoc.selectionMediaId = selectionMediaIdUpdate
    }

    if (isObjectStorageS3()) {
        await uploadLocalFileThenRemove(f.path, newPath, f.mimetype)
    }

    await existingDoc.save()
    await deleteStoredAsset(oldPath)
    return existingDoc
}

/**
 * JSON: { kind: "raw" | "final", filenames: string[] } — client passes file.name for each selected file.
 * Use before multipart upload to show a “replace / skip” popup when hasConflicts is true.
 */
export const previewUploadDuplicates = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const kind = req.body?.kind
        const filenames = req.body?.filenames

        if (kind !== "raw" && kind !== "final") {
            return res.status(400).json({ message: 'kind must be "raw" or "final"' })
        }
        if (!Array.isArray(filenames)) {
            return res.status(400).json({
                message: "filenames must be an array of strings (e.g. file.name from the file picker)",
            })
        }

        const conflicts = []
        const seenBasenames = new Set()
        for (const rawName of filenames) {
            if (rawName == null) continue
            const name = String(rawName).trim()
            if (!name) continue
            const bn = path.basename(name)
            const dedupeKey = bn.toLowerCase()
            if (seenBasenames.has(dedupeKey)) continue
            seenBasenames.add(dedupeKey)

            const existing = await findDuplicateFolderMedia(
                FolderMedia,
                id,
                kind,
                name
            )
            if (existing) {
                conflicts.push({
                    originalFilename: name,
                    basename: bn,
                    existingMediaId: existing._id,
                })
            }
        }

        return res.status(200).json({
            folderId: id,
            kind,
            hasConflicts: conflicts.length > 0,
            conflictCount: conflicts.length,
            conflicts,
        })
    } catch (error) {
        console.error("Preview upload duplicates error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const uploadRawMedia = async (req, res) => {
    const fileParts = collectFolderUploadFiles(req)
    const created = []
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({ message: "Invalid folder id" })
        }
        if (fileParts.length === 0) {
            return res.status(400).json({
                message: "No files uploaded",
                hint: 'Use multipart/form-data with field "files" (best for many images). Max size per file is set by FOLDER_MAX_UPLOAD_MB in .env (default 500MB).',
            })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(404).json({ message: "Folder not found" })
        }

        const dupAction = readDuplicateAction(req)
        if (dupAction === null) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({
                message:
                    'duplicateAction must be "replace" or "ignore" (or omit for ignore)',
            })
        }

        const settings = await Settings.getSingleton()
        const watermarkOn = Boolean(settings.watermarkPreviewImages)

        const ignoredDuplicates = []
        const replacedDocs = []
        const mediaOut = []

        for (const f of fileParts) {
            const existing = await findDuplicateFolderMedia(
                FolderMedia,
                id,
                "raw",
                f.originalname
            )
            if (existing) {
                if (dupAction === "ignore") {
                    unlinkLocalTempFile(f.path)
                    ignoredDuplicates.push({ originalFilename: f.originalname })
                    continue
                }
                const doc = await replaceExistingRawMedia(
                    req,
                    existing,
                    f,
                    id,
                    watermarkOn
                )
                replacedDocs.push(doc)
                mediaOut.push(
                    serializeRawUpload(req, doc, {
                        maskOriginalWithDisplay: false,
                    })
                )
                continue
            }

            const filePath = path.posix.join(
                "uploads",
                "folders",
                id,
                "raw",
                path.basename(f.path)
            )
            const doc = await FolderMedia.create({
                folder: id,
                kind: "raw",
                filePath,
                displayFilePath: "",
                originalFilename: f.originalname,
                mimeType: f.mimetype,
                size: f.size,
            })
            const row = { doc, diskPath: f.path }
            created.push(row)

            if (watermarkOn) {
                const { absolutePath, relativePath } =
                    buildWatermarkedDisplayPaths(f.path, id)
                const gen = await generateRawDisplayAsset({
                    sourcePath: f.path,
                    outputAbsolutePath: absolutePath,
                    relativePath,
                    mimeType: f.mimetype,
                })
                if (gen.ok) {
                    doc.displayFilePath = relativePath
                    await doc.save()
                    row.displayDiskPath = absolutePath
                } else {
                    console.warn(
                        "Watermark display not generated:",
                        f.originalname,
                        gen.error
                    )
                }
            }

            if (isObjectStorageS3()) {
                await uploadLocalFileThenRemove(f.path, doc.filePath, doc.mimeType)
                if (doc.displayFilePath && row.displayDiskPath) {
                    await uploadLocalFileThenRemove(
                        row.displayDiskPath,
                        doc.displayFilePath,
                        "image/jpeg"
                    )
                }
            }

            mediaOut.push(
                serializeRawUpload(req, doc, {
                    maskOriginalWithDisplay: false,
                })
            )
        }

        const notifySms = readUploadCompleteNotify(req)
        if (notifySms) {
            scheduleRawUploadSms(folder._id, req.user?._id)
        }

        const totalDone = created.length + replacedDocs.length
        const msgParts = []
        if (totalDone > 0) {
            msgParts.push(`Uploaded ${totalDone} photo(s)`)
        }
        if (ignoredDuplicates.length > 0) {
            msgParts.push(`${ignoredDuplicates.length} duplicate(s) skipped`)
        }
        const message =
            msgParts.length > 0 ? msgParts.join("; ") : "No new uploads"

        return res.status(201).json({
            message,
            count: totalDone,
            createdCount: created.length,
            replacedCount: replacedDocs.length,
            ignoredDuplicatesCount: ignoredDuplicates.length,
            duplicateAction: dupAction,
            media: mediaOut,
            ignoredDuplicates,
            replacedMediaIds: replacedDocs.map((d) => d._id),
            smsNotifyScheduled: notifySms,
        })
    } catch (error) {
        await rollbackCreatedMedia(created)
        for (const f of fileParts) unlinkLocalTempFile(f.path)
        console.error("Upload raw media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const uploadFinalMedia = async (req, res) => {
    const fileParts = collectFolderUploadFiles(req)
    const created = []
    try {
        const { id } = req.params
        const rawSel = req.body?.selectionMediaId
        const trimmedSel =
            rawSel != null && String(rawSel).trim() !== ""
                ? String(rawSel).trim()
                : ""
        const selectionMediaId = mongoose.Types.ObjectId.isValid(trimmedSel)
            ? trimmedSel
            : null

        if (!mongoose.Types.ObjectId.isValid(id)) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({ message: "Invalid folder id" })
        }
        if (fileParts.length === 0) {
            return res.status(400).json({
                message: "No files uploaded",
                hint: 'Same as raw uploads: use field "files" or "file", etc. Max file size: FOLDER_MAX_UPLOAD_MB in .env (default 500MB).',
            })
        }

        let folder = await Folder.findById(id)
        if (!folder) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(404).json({ message: "Folder not found" })
        }

        const pay = readFinalDeliveryPaymentFromReq(req)
        if (!pay.legacy) {
            if (!pay.clientPaid) {
                if (pay.amountRemaining == null) {
                    for (const f of fileParts) unlinkLocalTempFile(f.path)
                    return res.status(400).json({
                        message:
                            "When the client has not paid, send a positive amount using one of these multipart fields: amountRemainingGHS, amountRemaining, outstandingAmountGHS, balance, or amount. You can also send a JSON object in the finalDelivery field. Strip currency symbols or use a plain number (e.g. 500 or 500.50).",
                    })
                }
                await Folder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            "finalDelivery.outstandingAmountGHS": pay.amountRemaining,
                            "finalDelivery.imagesLocked": pay.lockImages,
                        },
                    }
                )
            } else {
                await Folder.updateOne(
                    { _id: folder._id },
                    {
                        $set: {
                            "finalDelivery.outstandingAmountGHS": null,
                            "finalDelivery.imagesLocked": false,
                        },
                    }
                )
            }
            folder = await Folder.findById(id)
        }

        const dupAction = readDuplicateAction(req)
        if (dupAction === null) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({
                message:
                    'duplicateAction must be "replace" or "ignore" (or omit for ignore)',
            })
        }

        let selectionRef = null
        if (selectionMediaId) {
            if (fileParts.length > 1) {
                for (const f of fileParts) unlinkLocalTempFile(f.path)
                return res.status(400).json({
                    message:
                        "selectionMediaId can only be used when uploading one final at a time. Omit it for batch uploads, then link manually if needed.",
                })
            }
            const sel = await FolderMedia.findOne({
                _id: selectionMediaId,
                folder: id,
                kind: "selection",
            })
            if (!sel) {
                for (const f of fileParts) unlinkLocalTempFile(f.path)
                return res.status(404).json({ message: "Selection not found" })
            }
            selectionRef = sel._id
        }

        const ignoredDuplicates = []
        const replacedDocs = []
        const mediaOut = []

        /** When one file + selectionMediaId in body, apply to new rows and duplicate replacements. */
        const selUpdate =
            fileParts.length === 1 && selectionRef ? selectionRef : undefined

        for (const f of fileParts) {
            const existing = await findDuplicateFolderMedia(
                FolderMedia,
                id,
                "final",
                f.originalname
            )
            if (existing) {
                if (dupAction === "ignore") {
                    unlinkLocalTempFile(f.path)
                    ignoredDuplicates.push({ originalFilename: f.originalname })
                    continue
                }
                const doc = await replaceExistingFinalMedia(
                    existing,
                    f,
                    id,
                    selUpdate
                )
                replacedDocs.push(doc)
                mediaOut.push(serializeFinal(req, doc))
                continue
            }

            const filePath = path.posix.join(
                "uploads",
                "folders",
                id,
                "finals",
                path.basename(f.path)
            )
            const doc = await FolderMedia.create({
                folder: id,
                kind: "final",
                filePath,
                originalFilename: f.originalname,
                mimeType: f.mimetype,
                size: f.size,
                selectionMediaId: selectionRef,
            })
            created.push({ doc, diskPath: f.path })
            if (isObjectStorageS3()) {
                await uploadLocalFileThenRemove(f.path, filePath, doc.mimeType)
            }

            mediaOut.push(serializeFinal(req, doc))
        }

        const notifySms = readUploadCompleteNotify(req)
        if (notifySms) {
            scheduleFinalUploadSms(folder._id, req.user?._id)
        }

        const totalDone = created.length + replacedDocs.length
        const msgParts = []
        if (totalDone > 0) {
            msgParts.push(`Uploaded ${totalDone} final image(s)`)
        }
        if (ignoredDuplicates.length > 0) {
            msgParts.push(`${ignoredDuplicates.length} duplicate(s) skipped`)
        }
        const message =
            msgParts.length > 0 ? msgParts.join("; ") : "No new uploads"

        return res.status(201).json({
            message,
            count: totalDone,
            createdCount: created.length,
            replacedCount: replacedDocs.length,
            ignoredDuplicatesCount: ignoredDuplicates.length,
            duplicateAction: dupAction,
            media: mediaOut,
            ignoredDuplicates,
            replacedMediaIds: replacedDocs.map((d) => d._id),
            smsNotifyScheduled: notifySms,
            finalDelivery: folder.finalDelivery || {
                outstandingAmountGHS: null,
                imagesLocked: false,
            },
        })
    } catch (error) {
        await rollbackCreatedMedia(created)
        for (const f of fileParts) unlinkLocalTempFile(f.path)
        console.error("Upload final media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

const deleteFolderMediaCore = async (req, res, allowedKinds) => {
    try {
        const { id, mediaId } = req.params
        if (
            !mongoose.Types.ObjectId.isValid(id) ||
            !mongoose.Types.ObjectId.isValid(mediaId)
        ) {
            return res.status(400).json({ message: "Invalid id" })
        }

        const doc = await FolderMedia.findOne({
            _id: mediaId,
            folder: id,
        })
        if (!doc) {
            return res.status(404).json({ message: "Media not found" })
        }

        if (!allowedKinds.includes(doc.kind)) {
            return res.status(400).json({
                message: `This endpoint only deletes ${allowedKinds.join(" or ")} items. Use the correct URL for ${doc.kind} entries.`,
            })
        }

        if (doc.kind === "raw") {
            const picks = await FolderMedia.countDocuments({
                folder: id,
                kind: "selection",
                rawMediaId: doc._id,
            })
            if (picks > 0) {
                return res.status(400).json({
                    message:
                        "Cannot delete this photo because the client has selected it. Remove selections first.",
                })
            }
            await deleteStoredAsset(doc.filePath)
            await deleteStoredAsset(doc.displayFilePath)
        } else if (doc.kind === "final") {
            await deleteStoredAsset(doc.filePath)
        } else if (doc.kind === "selection") {
            // no file on disk
        }

        await FolderMedia.deleteOne({ _id: doc._id })

        return res.status(200).json({
            message: "Media deleted",
            deleted: { _id: doc._id, kind: doc.kind },
        })
    } catch (error) {
        console.error("Delete folder media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

/** Any kind: raw, final, or selection (admin). */
export const deleteFolderMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["raw", "final", "selection"])

/** Raw upload only. */
export const deleteFolderRawMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["raw"])

/** Final delivery only. */
export const deleteFolderFinalMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["final"])

/** Delete every raw upload in the folder (original + preview files). Blocked if any client selections exist. */
export const deleteAllFolderRawMedia = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const selectionCount = await FolderMedia.countDocuments({
            folder: id,
            kind: "selection",
        })
        if (selectionCount > 0) {
            return res.status(400).json({
                message:
                    "Cannot delete all raw uploads while the gallery has client selections. Remove selections first, then retry.",
                selectionCount,
            })
        }

        const raws = await FolderMedia.find({ folder: id, kind: "raw" })
        for (const doc of raws) {
            await deleteStoredAsset(doc.filePath)
            await deleteStoredAsset(doc.displayFilePath)
        }
        const result = await FolderMedia.deleteMany({ folder: id, kind: "raw" })

        return res.status(200).json({
            message: "All raw uploads deleted",
            deletedCount: result.deletedCount,
        })
    } catch (error) {
        console.error("Delete all raw media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

/** Delete every final delivery file in the folder. */
export const deleteAllFolderFinalMedia = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findById(id)
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const finals = await FolderMedia.find({ folder: id, kind: "final" })
        for (const doc of finals) {
            await deleteStoredAsset(doc.filePath)
        }
        const result = await FolderMedia.deleteMany({ folder: id, kind: "final" })

        return res.status(200).json({
            message: "All final uploads deleted",
            deletedCount: result.deletedCount,
        })
    } catch (error) {
        console.error("Delete all final media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const patchSelectionEditStatus = async (req, res) => {
    try {
        const { id, mediaId } = req.params
        const { editStatus } = req.body

        if (
            !mongoose.Types.ObjectId.isValid(id) ||
            !mongoose.Types.ObjectId.isValid(mediaId)
        ) {
            return res.status(400).json({ message: "Invalid id" })
        }
        if (!editStatus || !EDIT_STATUSES.includes(editStatus)) {
            return res.status(400).json({
                message: `editStatus must be one of: ${EDIT_STATUSES.join(", ")}`,
            })
        }

        const doc = await FolderMedia.findOne({
            _id: mediaId,
            folder: id,
            kind: "selection",
        }).populate("rawMediaId")

        if (!doc) {
            return res.status(404).json({ message: "Selection not found" })
        }

        doc.editStatus = editStatus
        await doc.save()
        await doc.populate("rawMediaId")

        return res.status(200).json({
            message: "Selection updated",
            selection: serializeSelection(req, doc, {
                maskNestedRaw: false,
            }),
        })
    } catch (error) {
        console.error("Patch selection status error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const patchFolderStatus = async (req, res) => {
    try {
        const { id } = req.params
        const { status } = req.body

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }
        if (!FOLDER_STATUS_VALUES.includes(status)) {
            return res.status(400).json({
                message: `status must be one of: ${FOLDER_STATUS_VALUES.join(", ")}`,
            })
        }

        const folder = await Folder.findByIdAndUpdate(
            id,
            { status },
            { new: true }
        ).populate("client", "name email contact location")

        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        return res.status(200).json({
            message: "Folder status updated",
            folder: {
                _id: folder._id,
                status: folder.status,
            },
        })
    } catch (error) {
        console.error("Patch folder status error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const addClientSelection = async (req, res) => {
    try {
        const { identifier } = req.params
        const { rawMediaId } = req.body

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (folder.share.selectionLocked) {
            return res.status(403).json({
                message:
                    "This gallery is locked by your photographer. Contact them if you need changes.",
            })
        }

        const settings = await Settings.getSingleton()
        const shareSelOpts = {
            maskNestedRaw: Boolean(settings.watermarkPreviewImages),
        }

        if (!rawMediaId || !mongoose.Types.ObjectId.isValid(rawMediaId)) {
            return res.status(400).json({ message: "rawMediaId is required" })
        }

        const raw = await FolderMedia.findOne({
            _id: rawMediaId,
            folder: folder._id,
            kind: "raw",
        })
        if (!raw) {
            return res.status(404).json({ message: "Photo not found in gallery" })
        }

        const existing = await FolderMedia.findOne({
            folder: folder._id,
            kind: "selection",
            rawMediaId: raw._id,
        })
        if (existing) {
            const populated = await FolderMedia.findById(existing._id).populate(
                "rawMediaId"
            )
            return res.status(200).json({
                message: "Already selected",
                selection: serializeSelection(req, populated, shareSelOpts),
            })
        }

        const doc = await FolderMedia.create({
            folder: folder._id,
            kind: "selection",
            filePath: "",
            rawMediaId: raw._id,
            editStatus: "pending",
        })
        await doc.populate("rawMediaId")

        return res.status(201).json({
            message: "Photo added to your selection",
            selection: serializeSelection(req, doc, shareSelOpts),
        })
    } catch (error) {
        console.error("Add client selection error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const removeClientSelection = async (req, res) => {
    try {
        const { identifier, selectionId } = req.params

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (folder.share.selectionLocked) {
            return res.status(403).json({
                message:
                    "This gallery is locked by your photographer. Contact them if you need changes.",
            })
        }

        if (!mongoose.Types.ObjectId.isValid(selectionId)) {
            return res.status(400).json({ message: "Invalid selection id" })
        }

        const doc = await FolderMedia.findOne({
            _id: selectionId,
            folder: folder._id,
            kind: "selection",
        })
        if (!doc) {
            return res.status(404).json({ message: "Selection not found" })
        }

        await FolderMedia.deleteOne({ _id: doc._id })

        return res.status(200).json({ message: "Photo removed from your selection" })
    } catch (error) {
        console.error("Remove client selection error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const syncClientSelections = async (req, res) => {
    try {
        const { identifier } = req.params
        const { rawMediaIds } = req.body || {}

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (folder.share.selectionLocked) {
            return res.status(403).json({
                message:
                    "This gallery is locked by your photographer. Contact them if you need changes.",
            })
        }

        if (!Array.isArray(rawMediaIds)) {
            return res.status(400).json({ message: "rawMediaIds must be an array" })
        }
        if (rawMediaIds.length > 500) {
            return res.status(400).json({ message: "Too many ids (max 500)" })
        }

        const normalized = rawMediaIds.map(String)
        for (const id of normalized) {
            if (!mongoose.Types.ObjectId.isValid(id)) {
                return res.status(400).json({ message: `Invalid rawMediaId: ${id}` })
            }
        }
        const uniqueIds = [...new Set(normalized)]

        const raws = await FolderMedia.find({
            _id: { $in: uniqueIds },
            folder: folder._id,
            kind: "raw",
        })
        if (raws.length !== uniqueIds.length) {
            return res.status(400).json({
                message: "One or more photos are not in this gallery",
            })
        }

        const want = new Set(uniqueIds.map(String))
        const existingSelections = await FolderMedia.find({
            folder: folder._id,
            kind: "selection",
        })

        for (const sel of existingSelections) {
            if (!want.has(String(sel.rawMediaId))) {
                await FolderMedia.deleteOne({ _id: sel._id })
            }
        }

        const have = new Set(
            existingSelections.map((s) => String(s.rawMediaId))
        )
        for (const rid of uniqueIds) {
            if (!have.has(String(rid))) {
                await FolderMedia.create({
                    folder: folder._id,
                    kind: "selection",
                    filePath: "",
                    rawMediaId: rid,
                    editStatus: "pending",
                })
            }
        }

        const settings = await Settings.getSingleton()
        const media = await getFolderMediaCollections(req, folder._id, {
            clientGallery: Boolean(settings.watermarkPreviewImages),
        })

        return res.status(200).json({
            message: "Selections updated",
            count: media.selection.length,
            selection: media.selection,
        })
    } catch (error) {
        console.error("Sync client selections error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const submitClientSelections = async (req, res) => {
    try {
        const { identifier } = req.params

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (folder.share.selectionLocked) {
            return res.status(403).json({
                message:
                    "This gallery is locked by your photographer. Contact them to unlock or submit.",
                selectionSubmittedAt: folder.share.selectionSubmittedAt,
                selectionLocked: true,
                canEditSelections: false,
            })
        }

        folder.share.selectionSubmittedAt = new Date()
        await folder.save()

        return res.status(200).json({
            message:
                "Selection submitted. Your photographer has been notified (when notifications are wired). You can change your picks and submit again anytime.",
            selectionSubmittedAt: folder.share.selectionSubmittedAt,
            selectionLocked: Boolean(folder.share.selectionLocked),
            canEditSelections: true,
            selectionSubmitted: true,
        })
    } catch (error) {
        console.error("Submit client selections error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const streamSharedFinalLockedPreview = async (req, res) => {
    try {
        const { identifier, mediaId } = req.params

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (!folderFinalImagesLocked(folder)) {
            return res.status(404).json({ message: "Preview not available" })
        }

        if (!mongoose.Types.ObjectId.isValid(mediaId)) {
            return res.status(400).json({ message: "Invalid file id" })
        }

        const finalDoc = await FolderMedia.findOne({
            _id: mediaId,
            folder: folder._id,
            kind: "final",
        })
        if (!finalDoc?.filePath) {
            return res.status(404).json({ message: "File not found" })
        }

        if (!isRasterImageMime(finalDoc.mimeType)) {
            return res.status(415).json({
                message:
                    "Locked preview is only available for standard image formats.",
            })
        }

        const got = await readStoredAssetBufferLimited(finalDoc.filePath)
        if (!got.ok) {
            if (got.error === "too_large") {
                return res.status(413).json({
                    message: "File is too large to generate a locked preview.",
                })
            }
            return res.status(404).json({ message: "File not found" })
        }

        const ok = await pipeLockedFinalJpegToResponse(res, got.buffer)
        if (!ok && !res.headersSent) {
            return res.status(422).json({ message: "Could not generate preview" })
        }
    } catch (error) {
        console.error("Locked final preview error:", error)
        if (!res.headersSent) {
            return res.status(500).json({ message: "Server error" })
        }
    }
}

export const downloadSharedFinal = async (req, res) => {
    try {
        const { identifier, mediaId } = req.params

        const loaded = await loadActiveSharedFolder(identifier)
        if (loaded.error) {
            return res
                .status(loaded.error.status)
                .json({ message: loaded.error.message })
        }
        const { folder } = loaded

        if (folderFinalImagesLocked(folder)) {
            return res.status(403).json({
                message:
                    "Downloads are disabled until payment is complete. Contact your photographer or complete payment to receive full files.",
            })
        }

        if (!mongoose.Types.ObjectId.isValid(mediaId)) {
            return res.status(400).json({ message: "Invalid file id" })
        }

        const finalDoc = await FolderMedia.findOne({
            _id: mediaId,
            folder: folder._id,
            kind: "final",
        })
        if (!finalDoc?.filePath) {
            return res.status(404).json({ message: "File not found" })
        }

        const downloadName =
            finalDoc.originalFilename ||
            path.basename(finalDoc.filePath) ||
            "download"

        if (isObjectStorageS3()) {
            try {
                const out = await getObjectStreamForStoredPath(finalDoc.filePath)
                if (!out?.Body) {
                    return res.status(404).json({ message: "File missing in storage" })
                }
                res.setHeader(
                    "Content-Type",
                    finalDoc.mimeType || "application/octet-stream"
                )
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`
                )
                if (out.ContentLength != null) {
                    res.setHeader("Content-Length", String(out.ContentLength))
                }
                out.Body.pipe(res)
                return
            } catch (e) {
                console.error("S3 download error:", e)
                return res.status(404).json({ message: "File not found in storage" })
            }
        }

        const absPath = resolveLocalAbsolutePath(finalDoc.filePath)
        if (!fs.existsSync(absPath)) {
            return res.status(404).json({ message: "File missing on server" })
        }

        return res.download(absPath, downloadName, (err) => {
            if (err && !res.headersSent) {
                console.error("Download shared final error:", err)
                res.status(500).json({ message: "Download failed" })
            }
        })
    } catch (error) {
        console.error("Download shared final error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteAllMediaForFolder = async (folderId) => {
    const docs = await FolderMedia.find({ folder: folderId })
    for (const doc of docs) {
        if (doc.kind === "raw" || doc.kind === "final") {
            await deleteStoredAsset(doc.filePath)
            if (doc.kind === "raw") await deleteStoredAsset(doc.displayFilePath)
        }
    }
    await FolderMedia.deleteMany({ folder: folderId })
}
