import express from "express"
import { protect } from "../middleware/auth.js"
import {
    getInvoiceMeta,
    listInvoices,
    getInvoice,
    createInvoice,
    replaceInvoice,
    patchInvoice,
    deleteInvoice,
} from "../controllers/invoiceController.js"

const router = express.Router()

router.use(protect)

router.get("/meta", getInvoiceMeta)
router.get("/", listInvoices)
router.post("/", createInvoice)
router.get("/:id", getInvoice)
router.put("/:id", replaceInvoice)
router.patch("/:id", patchInvoice)
router.delete("/:id", deleteInvoice)

export default router
