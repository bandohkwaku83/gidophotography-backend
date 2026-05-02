import express from "express"
import {
    getUsageSummary,
    getUsageGalleries,
} from "../controllers/usageController.js"
import { protect } from "../middleware/auth.js"

const router = express.Router()

router.use(protect)
router.get("/summary", getUsageSummary)
router.get("/galleries", getUsageGalleries)

export default router
