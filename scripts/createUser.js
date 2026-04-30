import mongoose from "mongoose"
import dotenv from "dotenv"
import path from "path"
import readline from "readline"
import { fileURLToPath } from "url"
import User from "../models/User.js"
import { mongoUrlFromEnv } from "../utils/mongoUrlFromEnv.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.join(__dirname, "..", ".env"), override: true })

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
})

const ask = (question) =>
    new Promise((resolve) => rl.question(question, (answer) => resolve(answer)))

const run = async () => {
    try {
        const mongoUrl = mongoUrlFromEnv()
        if (!mongoUrl) {
            console.error("MONGO_URL (or MONGO_URI) is not set in .env.")
            process.exit(1)
        }
        await mongoose.connect(mongoUrl)
        console.log("Connected to MongoDB\n")

        const argEmail = process.argv[2]
        const argPassword = process.argv[3]
        const argName = process.argv[4]
        const argRole = process.argv[5]

        const email = argEmail || (await ask("Email: "))
        const password = argPassword || (await ask("Password: "))
        const name = argName || (await ask("Name (optional): "))
        const role =
            argRole ||
            (await ask("Role (user/admin) [default: user]: ")) ||
            "user"

        if (!email || !password) {
            console.error("Email and password are required.")
            process.exit(1)
        }

        const existing = await User.findOne({
            email: email.toLowerCase().trim(),
        })
        if (existing) {
            console.error(`A user with email "${email}" already exists.`)
            process.exit(1)
        }

        const user = await User.create({
            email: email.toLowerCase().trim(),
            password,
            name: name || undefined,
            role: role || "user",
        })

        console.log("\nUser created successfully:")
        console.log({
            id: user._id.toString(),
            email: user.email,
            name: user.name,
            role: user.role,
        })

        process.exit(0)
    } catch (error) {
        console.error("Error creating user:", error.message)
        process.exit(1)
    } finally {
        rl.close()
    }
}

run()
