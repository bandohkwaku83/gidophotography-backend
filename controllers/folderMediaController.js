import fs from "fs"
import path from "path"
import mongoose from "mongoose"
import Folder from "../models/Folder.js"
import FolderMedia, { EDIT_STATUSES } from "../models/FolderMedia.js"
import FolderSet from "../models/FolderSet.js"
import { FOLDER_STATUS_VALUES } from "../constants/folderStatus.js"
import { collectFolderUploadFiles, folderUploadMaxFilesPerRequest, folderUploadMaxFileSizeMb } from "../middleware/upload.js"
import {
    scheduleRawUploadSms,
    scheduleFinalUploadSms,
} from "../services/uploadSmsNotifications.js"
import { resolveGalleryPublicBaseUrl } from "../utils/shareUrl.js"
import {
    readUploadCompleteNotify,
    readDuplicateAction,
} from "../utils/multipartFlags.js"
import {
    findDuplicateFolderMediaBatch,
    DUPLICATE_PREVIEW_MAX_FILENAMES,
    loadFolderMediaByBasenameMap,
    basenameDuplicateKey,
} from "../utils/duplicateUpload.js"
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
import { finalizeRasterThumbnail } from "../utils/mediaThumbnail.js"
import {
    notifyAdminsOfFolderSelection,
    notifyAdminsOfFinalDownload,
} from "../services/notificationService.js"
import { parseSetIdInput } from "../utils/folderSetQuery.js"
import {
    getEffectiveMaxClientSelections,
    selectionLimitExceededMessage,
} from "../utils/maxClientSelections.js"
import {
    ACTIVE_MEDIA_MATCH,
    getTrashRetentionDays,
    isWithinRestoreWindow,
    restoreDeadlineISO,
} from "../utils/softDelete.js"
import { reorderFolderMediaBucket } from "../utils/mediaSortOrder.js"
import {
    buildOrderedSetBuckets,
    galleryCollectionFieldsFromFolder,
} from "../utils/galleryCollections.js"

const FOLDER_COLL = Folder.collection.name

/** Populate linked raw for selections — includes soft-deleted raws (hidden from uploads only). */
const selectionRawPopulate = (rawSelect) => ({
    path: "rawMediaId",
    select: `${rawSelect} deletedAt`,
})

export const buildPublicUrl = buildPublicAssetUrl

export const serializeRawUpload = (req, doc, opts = {}) => {
    const { maskOriginalWithDisplay = false } = opts
    const originalUrl = buildPublicUrl(req, doc.filePath)
    const displayUrl = doc.displayFilePath
        ? buildPublicUrl(req, doc.displayFilePath)
        : ""
    const thumbUrl = doc.thumbPath
        ? buildPublicUrl(req, doc.thumbPath)
        : ""
    const useDisplay = maskOriginalWithDisplay && displayUrl
    const out = {
        _id: doc._id,
        url: useDisplay ? displayUrl : originalUrl,
        thumbUrl,
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        size: doc.size,
        createdAt: doc.createdAt,
        setId: doc.set ? String(doc.set) : null,
        sortOrder: doc.sortOrder ?? 0,
    }
    if (!maskOriginalWithDisplay && displayUrl) out.displayUrl = displayUrl
    return out
}

export const serializeSelection = (req, doc, opts = {}) => {
    const { maskNestedRaw = false } = opts
    const raw = doc.rawMediaId
    const rawHiddenFromUploads = Boolean(
        raw && typeof raw === "object" && raw.deletedAt
    )
    const rawObj =
        raw && typeof raw === "object" && raw.filePath
            ? serializeRawUpload(req, raw, {
                  maskOriginalWithDisplay: maskNestedRaw,
              })
            : null
    const out = {
        _id: doc._id,
        editStatus: doc.editStatus,
        setId:
            doc.set != null
                ? String(doc.set)
                : rawObj?.setId ?? (doc.rawMediaId?.set ? String(doc.rawMediaId.set) : null),
        raw: rawObj,
        rawMediaId: doc.rawMediaId?._id || doc.rawMediaId,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    }
    if (rawHiddenFromUploads) {
        out.rawHiddenFromUploads = true
    }
    return out
}

export const serializeFinal = (req, doc) => {
    const selSetId =
        doc.selectionMediaId &&
        typeof doc.selectionMediaId === "object" &&
        doc.selectionMediaId.set
            ? String(doc.selectionMediaId.set)
            : null
    return {
        _id: doc._id,
        url: buildPublicUrl(req, doc.filePath),
        thumbUrl: doc.thumbPath ? buildPublicUrl(req, doc.thumbPath) : "",
        originalFilename: doc.originalFilename,
        mimeType: doc.mimeType,
        size: doc.size,
        selectionMediaId: doc.selectionMediaId?._id || doc.selectionMediaId || null,
        setId: doc.set ? String(doc.set) : selSetId,
        sortOrder: doc.sortOrder ?? 0,
        createdAt: doc.createdAt,
    }
}

/** @param {{ imagesLocked?: boolean }} opts */
export const serializePublicFinal = (req, identifier, f, opts = {}) => {
    const ident = encodeURIComponent(String(identifier))
    const host = `${req.protocol}://${req.get("host")}`
    if (opts.imagesLocked) {
        return {
            ...f,
            url: `${host}/api/share/${ident}/finals/${f._id}/locked-preview`,
            thumbUrl: "",
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
        deletedAt: null,
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
    { clientGallery = false, galleryConfig } = {}
) => {
    const rawSelect =
        "_id set filePath displayFilePath thumbPath originalFilename mimeType size sortOrder createdAt"
    const selectionSelect = "_id set editStatus rawMediaId createdAt updatedAt"
    const finalSelect =
        "_id set filePath thumbPath originalFilename mimeType size selectionMediaId sortOrder createdAt"

    const setSelect = "_id name sortOrder createdAt updatedAt"

    const [rawDocs, selectionDocs, finalDocs, setDocs] = await Promise.all([
        FolderMedia.find({ folder: folderId, kind: "raw", ...ACTIVE_MEDIA_MATCH })
            .select(rawSelect)
            .sort({ sortOrder: 1, createdAt: 1 })
            .lean(),
        FolderMedia.find({ folder: folderId, kind: "selection", ...ACTIVE_MEDIA_MATCH })
            .select(selectionSelect)
            .sort({ createdAt: 1 })
            .populate(selectionRawPopulate(rawSelect))
            .lean(),
        FolderMedia.find({ folder: folderId, kind: "final", ...ACTIVE_MEDIA_MATCH })
            .select(finalSelect)
            .sort({ sortOrder: 1, createdAt: 1 })
            .populate({
                path: "selectionMediaId",
                select: "_id set",
                match: { ...ACTIVE_MEDIA_MATCH },
            })
            .lean(),
        FolderSet.find({ folder: folderId, deletedAt: null })
            .select(setSelect)
            .sort({ sortOrder: 1, createdAt: 1 })
            .lean(),
    ])

    const rawOpts = { maskOriginalWithDisplay: clientGallery }
    const selOpts = { maskNestedRaw: clientGallery }

    const collectionConfig = galleryConfig ?? {}

    const uploads = rawDocs.map((d) => serializeRawUpload(req, d, rawOpts))
    const selection = selectionDocs.map((d) => serializeSelection(req, d, selOpts))
    const finals = finalDocs.map((d) => serializeFinal(req, d))

    const buildBucket = (items, { sortItems = false } = {}) =>
        buildOrderedSetBuckets(items, setDocs, collectionConfig)

    const uploadsBySet = buildBucket(uploads)
    const finalsBySet = buildBucket(finals)
    const selectionBySet = buildBucket(selection)

    return {
        uploads: uploadsBySet.flatMap((b) => b.items),
        selection,
        finals: finalsBySet.flatMap((b) => b.items),
        uploadsBySet,
        selectionBySet,
        finalsBySet,
    }
}

const rollbackCreatedMedia = async (created) => {
    for (const { doc, diskPath, displayDiskPath } of created) {
        if (isObjectStorageS3()) {
            await deleteStoredAsset(doc.filePath)
            if (doc.displayFilePath) await deleteStoredAsset(doc.displayFilePath)
            if (doc.thumbPath) await deleteStoredAsset(doc.thumbPath)
        } else {
            unlinkLocalTempFile(diskPath)
            unlinkLocalTempFile(displayDiskPath)
            if (doc.thumbPath) {
                const t = resolveLocalAbsolutePath(doc.thumbPath)
                unlinkLocalTempFile(t)
            }
        }
        await FolderMedia.deleteOne({ _id: doc._id }).catch(() => {})
    }
}

/** Replace-in-place so selections linked by raw _id stay valid. */
async function replaceExistingRawMedia(req, existingDoc, f, folderId, watermarkOn) {
    const oldMain = existingDoc.filePath
    const oldDisp = existingDoc.displayFilePath || ""

    if (existingDoc.thumbPath) {
        await deleteStoredAsset(existingDoc.thumbPath)
        existingDoc.thumbPath = ""
    }

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

    await finalizeRasterThumbnail(
        existingDoc,
        f,
        watermarkOn,
        displayDiskPath
    )

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

/** Replace-in-place; optional selectionMediaId/set updates only when caller passes values. */
async function replaceExistingFinalMedia(
    existingDoc,
    f,
    folderId,
    selectionMediaIdUpdate,
    setIdUpdate
) {
    const oldPath = existingDoc.filePath
    const newPath = path.posix.join(
        "uploads",
        "folders",
        folderId,
        "finals",
        path.basename(f.path)
    )

    if (existingDoc.thumbPath) {
        await deleteStoredAsset(existingDoc.thumbPath)
        existingDoc.thumbPath = ""
    }

    existingDoc.filePath = newPath
    existingDoc.originalFilename = f.originalname
    existingDoc.mimeType = f.mimetype
    existingDoc.size = f.size
    if (selectionMediaIdUpdate !== undefined) {
        existingDoc.selectionMediaId = selectionMediaIdUpdate
    }
    if (setIdUpdate !== undefined) {
        existingDoc.set = setIdUpdate
    }

    await finalizeRasterThumbnail(existingDoc, f, false, undefined)

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

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
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

        let setId = undefined
        const parsed = parseSetIdInput(req.body?.setId ?? req.body?.set_id)
        if (parsed === "__invalid__") {
            return res.status(400).json({ message: "Invalid set id" })
        }
        if (kind === "raw" || kind === "final") {
            setId = parsed
            if (setId) {
                const setDoc = await FolderSet.findOne({
                    _id: setId,
                    folder: id,
                    deletedAt: null,
                })
                if (!setDoc) {
                    return res.status(404).json({ message: "Set not found" })
                }
            }
        }

        const { conflicts, truncated } = await findDuplicateFolderMediaBatch(
            FolderMedia,
            id,
            kind,
            filenames,
            setId
        )

        return res.status(200).json({
            folderId: id,
            kind,
            setId: setId ?? null,
            hasConflicts: conflicts.length > 0,
            conflictCount: conflicts.length,
            conflicts,
            truncated,
            maxFilenames: DUPLICATE_PREVIEW_MAX_FILENAMES,
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
                hint: `Use multipart/form-data with field "files" or "video" (one large video per request is fine). Up to ${folderUploadMaxFilesPerRequest} files per request (FOLDER_MAX_FILES_PER_UPLOAD). Max size per file: ${folderUploadMaxFileSizeMb}MB (FOLDER_MAX_UPLOAD_MB in .env, default 500MB for videos and images).`,
            })
        }

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
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

        const parsedSetId = parseSetIdInput(req.body?.setId ?? req.body?.set_id)
        if (parsedSetId === "__invalid__") {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({ message: "Invalid set id" })
        }
        const uploadSetId = parsedSetId === undefined ? null : parsedSetId
        if (uploadSetId) {
            const setDoc = await FolderSet.findOne({
                _id: uploadSetId,
                folder: id,
                deletedAt: null,
            })
            if (!setDoc) {
                for (const f of fileParts) unlinkLocalTempFile(f.path)
                return res.status(404).json({ message: "Set not found" })
            }
        }

        const dupByBasename = await loadFolderMediaByBasenameMap(
            FolderMedia,
            id,
            "raw",
            uploadSetId
        )

        const ignoredDuplicates = []
        const replacedDocs = []
        const mediaOut = []

        for (const f of fileParts) {
            const dupKey = basenameDuplicateKey(f.originalname)
            const existing = dupByBasename.get(dupKey)
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
                set: uploadSetId,
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

            await finalizeRasterThumbnail(
                doc,
                f,
                watermarkOn,
                row.displayDiskPath
            )
            await doc.save()

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

            dupByBasename.set(dupKey, doc)

            mediaOut.push(
                serializeRawUpload(req, doc, {
                    maskOriginalWithDisplay: false,
                })
            )
        }

        const notifySms = readUploadCompleteNotify(req)
        if (notifySms) {
            scheduleRawUploadSms(folder._id, req.user?._id, {
                galleryPublicBaseUrl: resolveGalleryPublicBaseUrl(req),
            })
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
        const parsedSetId = parseSetIdInput(req.body?.setId ?? req.body?.set_id)
        if (parsedSetId === "__invalid__") {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({ message: "Invalid set id" })
        }

        if (!mongoose.Types.ObjectId.isValid(id)) {
            for (const f of fileParts) unlinkLocalTempFile(f.path)
            return res.status(400).json({ message: "Invalid folder id" })
        }
        if (fileParts.length === 0) {
            return res.status(400).json({
                message: "No files uploaded",
                hint: `Same as raw uploads: use field "files" or "video", etc. Up to ${folderUploadMaxFilesPerRequest} files per request (FOLDER_MAX_FILES_PER_UPLOAD). Max file size: ${folderUploadMaxFileSizeMb}MB (FOLDER_MAX_UPLOAD_MB in .env, default 500MB).`,
            })
        }

        let folder = await Folder.findOne({ _id: id, deletedAt: null })
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
            folder = await Folder.findOne({ _id: id, deletedAt: null })
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
        let selectionSetId = undefined
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
                ...ACTIVE_MEDIA_MATCH,
            }).select("_id set rawMediaId")
            if (!sel) {
                for (const f of fileParts) unlinkLocalTempFile(f.path)
                return res.status(404).json({ message: "Selection not found" })
            }
            selectionRef = sel._id
            selectionSetId = sel.set ?? null
        }

        const uploadSetId =
            parsedSetId === undefined ? (selectionSetId ?? null) : parsedSetId
        if (uploadSetId) {
            const setDoc = await FolderSet.findOne({
                _id: uploadSetId,
                folder: id,
                deletedAt: null,
            })
            if (!setDoc) {
                for (const f of fileParts) unlinkLocalTempFile(f.path)
                return res.status(404).json({ message: "Set not found" })
            }
        }

        const ignoredDuplicates = []
        const replacedDocs = []
        const mediaOut = []

        /** When one file + selectionMediaId in body, apply to new rows and duplicate replacements. */
        const selUpdate =
            fileParts.length === 1 && selectionRef ? selectionRef : undefined

        const dupByBasename = await loadFolderMediaByBasenameMap(
            FolderMedia,
            id,
            "final",
            uploadSetId
        )

        for (const f of fileParts) {
            const dupKey = basenameDuplicateKey(f.originalname)
            const existing = dupByBasename.get(dupKey)
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
                    selUpdate,
                    uploadSetId
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
                set: uploadSetId,
                filePath,
                originalFilename: f.originalname,
                mimeType: f.mimetype,
                size: f.size,
                selectionMediaId: selectionRef,
            })
            created.push({ doc, diskPath: f.path })
            await finalizeRasterThumbnail(doc, f, false, undefined)
            await doc.save()
            if (isObjectStorageS3()) {
                await uploadLocalFileThenRemove(f.path, filePath, doc.mimeType)
            }

            dupByBasename.set(dupKey, doc)

            mediaOut.push(serializeFinal(req, doc))
        }

        const notifySms = readUploadCompleteNotify(req)
        if (notifySms) {
            scheduleFinalUploadSms(folder._id, req.user?._id, {
                galleryPublicBaseUrl: resolveGalleryPublicBaseUrl(req),
            })
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
            ...ACTIVE_MEDIA_MATCH,
        })
        if (!doc) {
            return res.status(404).json({ message: "Media not found" })
        }

        if (!allowedKinds.includes(doc.kind)) {
            if (doc.kind === "selection") {
                return res.status(400).json({
                    message:
                        "Client selections cannot be deleted by admin. Delete the raw upload instead if you need to remove the file from the gallery.",
                })
            }
            return res.status(400).json({
                message: `This endpoint only deletes ${allowedKinds.join(" or ")} items. Use the correct URL for ${doc.kind} entries.`,
            })
        }

        doc.deletedAt = new Date()
        doc.deletedBy = "media"
        await doc.save()

        const payload = {
            message: "Media deleted (restorable from trash up to 30 days by default)",
            deleted: { _id: doc._id, kind: doc.kind },
            restoreBefore: restoreDeadlineISO(doc.deletedAt),
        }
        if (doc.kind === "raw") {
            payload.message =
                "Removed from raw uploads. Client selections are unchanged and still show this photo."
        }
        return res.status(200).json(payload)
    } catch (error) {
        console.error("Delete folder media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

/** Raw or final only — client selections are not admin-deletable (delete the raw upload instead). */
export const deleteFolderMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["raw", "final"])

/** Raw upload only (allowed even when the client has selected this photo). */
export const deleteFolderRawMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["raw"])

/** Final delivery only. */
export const deleteFolderFinalMedia = (req, res) =>
    deleteFolderMediaCore(req, res, ["final"])

/** Delete every raw upload in the folder (original + preview files). Client selections are kept. */
export const deleteAllFolderRawMedia = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const now = new Date()
        const result = await FolderMedia.updateMany(
            { folder: id, kind: "raw", ...ACTIVE_MEDIA_MATCH },
            {
                $set: { deletedAt: now, deletedBy: "media" },
            }
        )

        return res.status(200).json({
            message:
                "All raw uploads deleted (restorable individually or via gallery trash within the retention window)",
            deletedCount: result.modifiedCount ?? 0,
            restoreBefore: restoreDeadlineISO(now),
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

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const now = new Date()
        const result = await FolderMedia.updateMany(
            { folder: id, kind: "final", ...ACTIVE_MEDIA_MATCH },
            {
                $set: { deletedAt: now, deletedBy: "media" },
            }
        )

        return res.status(200).json({
            message:
                "All final uploads deleted (restorable individually or via gallery trash within the retention window)",
            deletedCount: result.modifiedCount ?? 0,
            restoreBefore: restoreDeadlineISO(now),
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
            ...ACTIVE_MEDIA_MATCH,
        }).populate(selectionRawPopulate(
            "_id set filePath displayFilePath thumbPath originalFilename mimeType size createdAt"
        ))

        if (!doc) {
            return res.status(404).json({ message: "Selection not found" })
        }

        doc.editStatus = editStatus
        await doc.save()
        await doc.populate(
            selectionRawPopulate(
                "_id set filePath displayFilePath thumbPath originalFilename mimeType size createdAt"
            )
        )

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

export const reorderFolderMedia = async (req, res) => {
    try {
        const { id } = req.params
        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid folder id" })
        }

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
        if (!folder) {
            return res.status(404).json({ message: "Folder not found" })
        }

        const kind = req.body?.kind
        const orderedIds = req.body?.orderedIds
        const parsedSetId = parseSetIdInput(req.body?.setId ?? req.body?.set_id)
        if (parsedSetId === "__invalid__") {
            return res.status(400).json({ message: "Invalid set id" })
        }
        const setId = parsedSetId === undefined ? null : parsedSetId

        if (setId) {
            const setDoc = await FolderSet.findOne({
                _id: setId,
                folder: id,
                deletedAt: null,
            })
            if (!setDoc) {
                return res.status(404).json({ message: "Set not found" })
            }
        }

        let result
        try {
            result = await reorderFolderMediaBucket(id, kind, setId, orderedIds)
        } catch (e) {
            if (e.status) {
                return res.status(e.status).json({ message: e.message })
            }
            throw e
        }

        const media = await getFolderMediaCollections(req, id, {
            galleryConfig: galleryCollectionFieldsFromFolder(folder),
        })
        return res.status(200).json({
            message: "Media order updated",
            updatedCount: result.updatedCount,
            kind,
            setId,
            uploads: media.uploads,
            finals: media.finals,
            uploadsBySet: media.uploadsBySet,
            finalsBySet: media.finalsBySet,
        })
    } catch (error) {
        console.error("Reorder folder media error:", error)
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

        const folder = await Folder.findOneAndUpdate(
            { _id: id, deletedAt: null },
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
            ...ACTIVE_MEDIA_MATCH,
        })
        if (!raw) {
            return res.status(404).json({ message: "Photo not found in gallery" })
        }

        const existing = await FolderMedia.findOne({
            folder: folder._id,
            kind: "selection",
            rawMediaId: raw._id,
            ...ACTIVE_MEDIA_MATCH,
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

        const maxSelections = getEffectiveMaxClientSelections(folder.share)
        if (maxSelections != null) {
            const currentCount = await FolderMedia.countDocuments({
                folder: folder._id,
                kind: "selection",
                ...ACTIVE_MEDIA_MATCH,
            })
            if (currentCount >= maxSelections) {
                return res.status(400).json({
                    message: selectionLimitExceededMessage(maxSelections),
                    maxClientSelections: maxSelections,
                })
            }
        }

        const doc = await FolderMedia.create({
            folder: folder._id,
            kind: "selection",
            set: raw.set ?? null,
            filePath: "",
            rawMediaId: raw._id,
            editStatus: "pending",
        })
        await doc.populate("rawMediaId")

        void notifyAdminsOfFolderSelection({
            type: "selection_add",
            folderId: folder._id,
            shareIdentifier: identifier,
        })

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
            ...ACTIVE_MEDIA_MATCH,
        })
        if (!doc) {
            return res.status(404).json({ message: "Selection not found" })
        }

        await FolderMedia.deleteOne({ _id: doc._id })

        void notifyAdminsOfFolderSelection({
            type: "selection_remove",
            folderId: folder._id,
            shareIdentifier: identifier,
        })

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

        const maxSelections = getEffectiveMaxClientSelections(folder.share)
        if (maxSelections != null && uniqueIds.length > maxSelections) {
            return res.status(400).json({
                message: selectionLimitExceededMessage(maxSelections),
                maxClientSelections: maxSelections,
            })
        }

        const existingSelections = await FolderMedia.find({
            folder: folder._id,
            kind: "selection",
            ...ACTIVE_MEDIA_MATCH,
        })
        const priorRawIds = new Set(
            existingSelections.map((s) => String(s.rawMediaId))
        )

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

        const rawById = new Map(raws.map((r) => [String(r._id), r]))
        for (const rid of uniqueIds) {
            const raw = rawById.get(String(rid))
            if (raw?.deletedAt && !priorRawIds.has(String(rid))) {
                return res.status(400).json({
                    message:
                        "One or more photos are no longer available in the gallery",
                })
            }
        }

        const want = new Set(uniqueIds.map(String))
        const rawSetById = new Map(raws.map((r) => [String(r._id), r.set ?? null]))

        let removed = 0
        for (const sel of existingSelections) {
            if (!want.has(String(sel.rawMediaId))) {
                await FolderMedia.deleteOne({ _id: sel._id })
                removed += 1
            }
        }

        const have = new Set(
            existingSelections.map((s) => String(s.rawMediaId))
        )
        let added = 0
        for (const rid of uniqueIds) {
            if (!have.has(String(rid))) {
                await FolderMedia.create({
                    folder: folder._id,
                    kind: "selection",
                    set: rawSetById.get(String(rid)) ?? null,
                    filePath: "",
                    rawMediaId: rid,
                    editStatus: "pending",
                })
                added += 1
            }
        }

        if (added > 0 || removed > 0) {
            void notifyAdminsOfFolderSelection({
                type: "selection_sync",
                folderId: folder._id,
                shareIdentifier: identifier,
                detail: { added, removed },
            })
        }

        const settings = await Settings.getSingleton()
        const media = await getFolderMediaCollections(req, folder._id, {
            clientGallery: Boolean(settings.watermarkPreviewImages),
            galleryConfig: galleryCollectionFieldsFromFolder(folder),
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

        void notifyAdminsOfFolderSelection({
            type: "selection_submit",
            folderId: folder._id,
            shareIdentifier: identifier,
        })

        return res.status(200).json({
            message:
                "Selection submitted. Your photographer has been notified. You can change your picks and submit again anytime.",
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
            ...ACTIVE_MEDIA_MATCH,
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
            ...ACTIVE_MEDIA_MATCH,
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
                void notifyAdminsOfFinalDownload({
                    folderId: folder._id,
                    shareIdentifier: identifier,
                    filename: downloadName,
                })
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

        void notifyAdminsOfFinalDownload({
            folderId: folder._id,
            shareIdentifier: identifier,
            filename: downloadName,
        })

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

/** Permanently removes one media row from DB and storage (purge only). */
export async function hardRemoveMediaDocument(doc) {
    if (!doc) return
    if (doc.kind === "raw") {
        await deleteStoredAsset(doc.filePath)
        await deleteStoredAsset(doc.displayFilePath)
        await deleteStoredAsset(doc.thumbPath)
    } else if (doc.kind === "final") {
        await deleteStoredAsset(doc.filePath)
        await deleteStoredAsset(doc.thumbPath)
    }
    await FolderMedia.deleteOne({ _id: doc._id }).catch(() => {})
}

/** Deletes all media rows under a folder plus their files (purge). */
export async function purgeFolderMediaAssetsAndDocuments(folderId) {
    const docs = await FolderMedia.find({ folder: folderId })
    for (const doc of docs) {
        if (doc.kind === "raw" || doc.kind === "final") {
            await deleteStoredAsset(doc.filePath)
            if (doc.kind === "raw") await deleteStoredAsset(doc.displayFilePath)
            await deleteStoredAsset(doc.thumbPath)
        }
    }
    await FolderMedia.deleteMany({ folder: folderId })
}

/** Full hard delete of gallery + files (after soft-delete retention expires). */
export async function purgeFolderWhole(folderRef) {
    const id = folderRef?._id ?? folderRef
    const folder =
        folderRef?.coverImage !== undefined
            ? folderRef
            : await Folder.findById(id).lean()
    if (!folder) return
    await purgeFolderMediaAssetsAndDocuments(id)
    if (!folder.usingDefaultCover && folder.coverImage) {
        await deleteStoredAsset(folder.coverImage)
    }
    if (folder.backgroundMusic) {
        await deleteStoredAsset(folder.backgroundMusic)
    }
    await Folder.deleteOne({ _id: id })
}

/**
 * Paginated trash for items deleted from an **active** gallery (`deletedBy: "media"`).
 * Used by GET /folders/media/trash and merged into GET /folders/trash.
 */
export async function getDeletedGalleryMediaTrashListing(req, opts = {}) {
    let page = Number.parseInt(String(opts.page ?? 1), 10)
    let limit = Number.parseInt(String(opts.limit ?? 50), 10)
    if (!Number.isFinite(page) || page < 1) page = 1
    if (!Number.isFinite(limit)) limit = 50
    limit = Math.min(Math.max(limit, 1), 500)
    const skip = (page - 1) * limit

    const folderId = opts.folderId
    const mediaMatch = {
        deletedAt: { $ne: null },
        deletedBy: "media",
    }
    if (folderId !== undefined && folderId !== null && String(folderId).trim() !== "") {
        if (!mongoose.Types.ObjectId.isValid(folderId)) {
            throw new Error("INVALID_FOLDER_ID")
        }
        mediaMatch.folder = new mongoose.Types.ObjectId(String(folderId).trim())
    }

    const activeParentFolder = {
        $or: [
            { "folderDoc.deletedAt": null },
            { "folderDoc.deletedAt": { $exists: false } },
        ],
    }

    const baseStages = [
        { $match: mediaMatch },
        {
            $lookup: {
                from: FOLDER_COLL,
                localField: "folder",
                foreignField: "_id",
                as: "folderDoc",
            },
        },
        {
            $unwind: {
                path: "$folderDoc",
                preserveNullAndEmptyArrays: false,
            },
        },
        { $match: activeParentFolder },
    ]

    const [countAgg, rows] = await Promise.all([
        FolderMedia.aggregate([
            ...baseStages,
            { $count: "total" },
        ]),
        FolderMedia.aggregate([
            ...baseStages,
            { $sort: { deletedAt: -1 } },
            { $skip: skip },
            { $limit: limit },
        ]),
    ])

    const total = countAgg[0]?.total ?? 0

    const items = rows.map((row) => {
        const d =
            row.deletedAt instanceof Date
                ? row.deletedAt
                : new Date(row.deletedAt)
        let item = null
        if (row.kind === "raw") {
            item = serializeRawUpload(req, row, {
                maskOriginalWithDisplay: false,
            })
        } else if (row.kind === "final") {
            item = serializeFinal(req, row)
        } else if (row.kind === "selection") {
            item = {
                _id: row._id,
                editStatus: row.editStatus,
                rawMediaId: row.rawMediaId ?? null,
            }
        }

        const origName = String(row.originalFilename || "").trim()
        const mimeLower = String(row.mimeType || "").toLowerCase()

        let previewUrl = ""
        if (row.kind === "raw") {
            const pathForPreview =
                row.thumbPath || row.displayFilePath || row.filePath
            previewUrl = pathForPreview
                ? buildPublicAssetUrl(req, pathForPreview)
                : ""
        } else if (row.kind === "final" && row.filePath) {
            previewUrl = row.thumbPath
                ? buildPublicAssetUrl(req, row.thumbPath)
                : buildPublicAssetUrl(req, row.filePath)
        }

        const canShowImageThumbnail =
            mimeLower.startsWith("image/") ||
            /\.(jpe?g|png|gif|webp|heic|heif|tif|bmp|dng|arw|cr2|cr3|nef|orf|rw2)$/i.test(
                origName
            )

        return {
            mediaId: row._id,
            folderId: row.folderDoc._id,
            gallery: {
                _id: row.folderDoc._id,
                eventName: row.folderDoc.eventName,
            },
            kind: row.kind,
            deletedAt: Number.isNaN(d.getTime()) ? null : d.toISOString(),
            restoreBefore: restoreDeadlineISO(d),
            restorable: isWithinRestoreWindow(d),
            previewUrl,
            originalFilename: origName,
            displayName:
                origName ||
                `${String(row._id).slice(-12)}.${String(row.mimeType || "file").split("/").pop()}`,
            mimeType: row.mimeType || "",
            canShowImageThumbnail,
            item,
        }
    })

    return { items, total, page, limit }
}

export const listDeletedFolderMedia = async (req, res) => {
    try {
        const { folderId } = req.query
        let page = Number.parseInt(String(req.query.page ?? "1"), 10)

        let limit = Number.parseInt(String(req.query.limit ?? "50"), 10)
        if (
            folderId !== undefined &&
            folderId !== null &&
            String(folderId).trim() !== "" &&
            !mongoose.Types.ObjectId.isValid(folderId)
        ) {
            return res.status(400).json({
                message: "Invalid folderId query parameter",
            })
        }

        let listing
        try {
            listing = await getDeletedGalleryMediaTrashListing(req, {
                folderId,
                page,
                limit,
            })
        } catch (e) {
            if (e.message === "INVALID_FOLDER_ID") {
                return res.status(400).json({
                    message: "Invalid folderId query parameter",
                })
            }
            throw e
        }

        return res.status(200).json({
            retentionDays: getTrashRetentionDays(),
            deletedMediaTotal: listing.total,
            page: listing.page,
            limit: listing.limit,
            count: listing.items.length,
            deletedMedia: listing.items,
        })
    } catch (error) {
        console.error("List deleted folder media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const restoreFolderMedia = async (req, res) => {
    try {
        const { id, mediaId } = req.params
        if (
            !mongoose.Types.ObjectId.isValid(id) ||
            !mongoose.Types.ObjectId.isValid(mediaId)
        ) {
            return res.status(400).json({ message: "Invalid id" })
        }

        const folder = await Folder.findOne({ _id: id, deletedAt: null })
        if (!folder) {
            return res.status(404).json({
                message:
                    "Folder not found or is in trash. Restore the gallery first if it was deleted.",
            })
        }

        const doc = await FolderMedia.findOne({ _id: mediaId, folder: id })
        if (!doc?.deletedAt) {
            return res
                .status(404)
                .json({ message: "Deleted media not found for this gallery" })
        }
        if (doc.deletedBy !== "media") {
            return res.status(400).json({
                message:
                    "That file was archived with a deleted gallery. Restore the gallery (POST /api/folders/:id/restore) instead of this item.",
            })
        }
        if (!isWithinRestoreWindow(doc.deletedAt)) {
            return res.status(410).json({
                message:
                    "This item can no longer be restored; the retention window has expired.",
            })
        }

        doc.deletedAt = null
        doc.deletedBy = null
        await doc.save()

        return res.status(200).json({
            message: "Media restored",
            kind: doc.kind,
            mediaId: doc._id,
        })
    } catch (error) {
        console.error("Restore folder media error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteAllMediaForFolder = purgeFolderMediaAssetsAndDocuments
