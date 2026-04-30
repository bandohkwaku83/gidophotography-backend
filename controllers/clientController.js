import mongoose from "mongoose"
import Client from "../models/Client.js"

export const createClient = async (req, res) => {
    try {
        const { name, email, contact, location } = req.body

        if (!name || !contact || !location) {
            return res.status(400).json({
                message: "Name, contact and location are required",
            })
        }

        const client = await Client.create({
            name: name.trim(),
            email: email ? email.toLowerCase().trim() : undefined,
            contact: contact.trim(),
            location: location.trim(),
            createdBy: req.user?._id,
        })

        return res
            .status(201)
            .json({ message: "Client created successfully", client })
    } catch (error) {
        console.error("Create client error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getClients = async (req, res) => {
    try {
        const { search } = req.query

        const filter = {}
        if (search) {
            filter.$or = [
                { name: { $regex: search, $options: "i" } },
                { email: { $regex: search, $options: "i" } },
                { contact: { $regex: search, $options: "i" } },
                { location: { $regex: search, $options: "i" } },
            ]
        }

        const clients = await Client.find(filter).sort({ createdAt: -1 })

        return res.status(200).json({ count: clients.length, clients })
    } catch (error) {
        console.error("Get clients error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const getClient = async (req, res) => {
    try {
        const { id } = req.params

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid client id" })
        }

        const client = await Client.findById(id)
        if (!client) {
            return res.status(404).json({ message: "Client not found" })
        }

        return res.status(200).json({ client })
    } catch (error) {
        console.error("Get client error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const updateClient = async (req, res) => {
    try {
        const { id } = req.params
        const { name, email, contact, location } = req.body

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid client id" })
        }

        const updates = {}
        if (name !== undefined) updates.name = name.trim()
        if (email !== undefined)
            updates.email = email ? email.toLowerCase().trim() : ""
        if (contact !== undefined) updates.contact = contact.trim()
        if (location !== undefined) updates.location = location.trim()

        const client = await Client.findByIdAndUpdate(id, updates, {
            new: true,
            runValidators: true,
        })

        if (!client) {
            return res.status(404).json({ message: "Client not found" })
        }

        return res
            .status(200)
            .json({ message: "Client updated successfully", client })
    } catch (error) {
        console.error("Update client error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const deleteClient = async (req, res) => {
    try {
        const { id } = req.params

        if (!mongoose.Types.ObjectId.isValid(id)) {
            return res.status(400).json({ message: "Invalid client id" })
        }

        const client = await Client.findByIdAndDelete(id)
        if (!client) {
            return res.status(404).json({ message: "Client not found" })
        }

        return res
            .status(200)
            .json({ message: "Client deleted successfully", client })
    } catch (error) {
        console.error("Delete client error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
