import express from "express"
import {
    getSettings,
    updateSettings,
    resetSettings,
} from "../controllers/settingsController.js"
import { protect } from "../middleware/auth.js"
import { uploadSettingsImage } from "../middleware/upload.js"

const router = express.Router()

router.use(protect)

router.get("/", getSettings)
router.put("/", uploadSettingsImage.single("defaultCoverImage"), updateSettings)
router.post("/reset", resetSettings)

export default router
