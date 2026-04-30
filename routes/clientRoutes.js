import express from "express"
import {
    createClient,
    getClients,
    getClient,
    updateClient,
    deleteClient,
} from "../controllers/clientController.js"
import { protect } from "../middleware/auth.js"

const router = express.Router()

router.use(protect)

router.post("/", createClient)
router.get("/", getClients)
router.get("/:id", getClient)
router.put("/:id", updateClient)
router.delete("/:id", deleteClient)

export default router
