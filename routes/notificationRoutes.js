import express from "express"
import { protect } from "../middleware/auth.js"
import { requireAdmin } from "../middleware/requireAdmin.js"
import {
    listNotifications,
    getUnreadNotificationCount,
    markNotificationRead,
    markAllNotificationsRead,
} from "../controllers/notificationController.js"

const router = express.Router()

router.use(protect)
router.use(requireAdmin)

router.get("/", listNotifications)
router.get("/unread-count", getUnreadNotificationCount)
router.patch("/:id/read", markNotificationRead)
router.post("/mark-all-read", markAllNotificationsRead)

export default router
