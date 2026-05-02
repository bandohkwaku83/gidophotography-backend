import express from "express"
import { protect } from "../middleware/auth.js"
import {
    getBookingMeta,
    getBookingsWeekSummary,
    listBookings,
    createBooking,
    getBooking,
    updateBooking,
    deleteBooking,
} from "../controllers/bookingController.js"

const router = express.Router()

router.use(protect)

router.get("/meta", getBookingMeta)
router.get("/summary/week", getBookingsWeekSummary)
router.get("/", listBookings)
router.post("/", createBooking)
router.get("/:id", getBooking)
router.put("/:id", updateBooking)
router.delete("/:id", deleteBooking)

export default router
