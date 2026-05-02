import express from "express"
import { getSharedFolder } from "../controllers/folderController.js"
import {
    addClientSelection,
    removeClientSelection,
    syncClientSelections,
    submitClientSelections,
    streamSharedFinalLockedPreview,
    downloadSharedFinal,
} from "../controllers/folderMediaController.js"

const router = express.Router()

router.get(
    "/:identifier/finals/:mediaId/locked-preview",
    streamSharedFinalLockedPreview
)
router.get(
    "/:identifier/finals/:mediaId/download",
    downloadSharedFinal
)
router.post("/:identifier/selections/submit", submitClientSelections)
router.post("/:identifier/selections/sync", syncClientSelections)
router.delete("/:identifier/selections/:selectionId", removeClientSelection)
router.post("/:identifier/selections", addClientSelection)
router.get("/:identifier", getSharedFolder)

export default router
