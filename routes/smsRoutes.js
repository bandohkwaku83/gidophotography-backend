import express from "express"
import { protect } from "../middleware/auth.js"
import {
    getSmsMeta,
    listSmsMessages,
    sendBulkSms,
} from "../controllers/smsController.js"

const router = express.Router()

router.use(protect)

router.get("/meta", getSmsMeta)
router.get("/messages", listSmsMessages)
router.post("/send", sendBulkSms)

export default router
