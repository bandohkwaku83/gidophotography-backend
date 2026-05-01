import express from "express"
import {
    createFolder,
    getFolders,
    getFolder,
    updateFolder,
    deleteFolder,
    shareFolder,
    unshareFolder,
    regenerateShareLink,
    patchFolderShare,
    listShareLinkExpiryPresets,
} from "../controllers/folderController.js"
import {
    uploadRawMedia,
    uploadFinalMedia,
    deleteFolderMedia,
    deleteFolderRawMedia,
    deleteFolderFinalMedia,
    deleteAllFolderRawMedia,
    deleteAllFolderFinalMedia,
    patchSelectionEditStatus,
    patchFolderStatus,
} from "../controllers/folderMediaController.js"
import { protect } from "../middleware/auth.js"
import {
    uploadCover,
    uploadFolderRaw,
    uploadFolderFinal,
} from "../middleware/upload.js"

const router = express.Router()

router.use(protect)

router.post("/", uploadCover.single("coverImage"), createFolder)
router.get("/", getFolders)
router.get("/share-link-expiry-presets", listShareLinkExpiryPresets)

router.post("/:id/media/raw", uploadFolderRaw, uploadRawMedia)
router.post("/:id/media/final", uploadFolderFinal, uploadFinalMedia)
router.delete("/:id/media/raw", deleteAllFolderRawMedia)
router.delete("/:id/media/final", deleteAllFolderFinalMedia)
router.delete("/:id/media/raw/:mediaId", deleteFolderRawMedia)
router.delete("/:id/media/final/:mediaId", deleteFolderFinalMedia)
router.delete("/:id/media/:mediaId", deleteFolderMedia)
router.patch("/:id/selection/:mediaId", patchSelectionEditStatus)
router.patch("/:id/status", patchFolderStatus)

router.post("/:id/share/regenerate", regenerateShareLink)
router.patch("/:id/share", patchFolderShare)
router.post("/:id/share", shareFolder)
router.delete("/:id/share", unshareFolder)

router.get("/:id", getFolder)
router.put("/:id", uploadCover.single("coverImage"), updateFolder)
router.delete("/:id", deleteFolder)

export default router
