import express from "express"
import {
    login,
    me,
    forgotPassword,
    logout,
} from "../controllers/authController.js"
import { protect } from "../middleware/auth.js"

const router = express.Router()

router.post("/login", login)
router.post("/forgot-password", forgotPassword)
router.get("/me", protect, me)
router.post("/logout", protect, logout)

export default router
