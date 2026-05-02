import jwt from "jsonwebtoken"
import User from "../models/User.js"
import BlacklistedToken from "../models/BlacklistedToken.js"

const generateToken = (userId) => {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES_IN || "7d",
    })
}

export const login = async (req, res) => {
    try {
        const { email, password } = req.body

        if (!email || !password) {
            return res
                .status(400)
                .json({ message: "Email and password are required" })
        }

        const normalizedEmail = email.toLowerCase().trim()
        const user = await User.findOne({ email: normalizedEmail })
        if (!user) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[auth] login: no user with email ${JSON.stringify(normalizedEmail)} (wrong email or empty DB / different MONGO_URL database).`
                )
            }
            return res.status(401).json({ message: "Invalid credentials" })
        }

        const isMatch = await user.comparePassword(password)
        if (!isMatch) {
            if (process.env.NODE_ENV !== "production") {
                console.warn(
                    `[auth] login: user exists for ${JSON.stringify(normalizedEmail)} but password did not match.`
                )
            }
            return res.status(401).json({ message: "Invalid credentials" })
        }

        const token = generateToken(user._id)

        return res.status(200).json({
            message: "Login successful",
            token,
            user,
        })
    } catch (error) {
        console.error("Login error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const me = async (req, res) => {
    return res.status(200).json({ user: req.user })
}

export const updateMe = async (req, res) => {
    try {
        const body = req.body || {}
        const user = req.user

        if (body.name !== undefined) {
            const n = String(body.name ?? "").trim()
            user.name = n || undefined
        }
        if (body.contact !== undefined) {
            user.contact = String(body.contact ?? "").trim()
        }

        await user.save()
        return res.status(200).json({
            message: "Profile updated",
            user,
        })
    } catch (error) {
        console.error("Update profile error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const logout = async (req, res) => {
    try {
        const token = req.token
        const expiresAt = req.tokenExp
            ? new Date(req.tokenExp * 1000)
            : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)

        await BlacklistedToken.updateOne(
            { token },
            { token, expiresAt },
            { upsert: true }
        )

        return res.status(200).json({ message: "Logged out successfully" })
    } catch (error) {
        console.error("Logout error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

export const forgotPassword = async (req, res) => {
    try {
        const { email, newPassword, confirmPassword } = req.body

        if (!email || !newPassword || !confirmPassword) {
            return res.status(400).json({
                message:
                    "Email, new password and confirm password are required",
            })
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ message: "Passwords do not match" })
        }

        if (newPassword.length < 6) {
            return res.status(400).json({
                message: "Password must be at least 6 characters",
            })
        }

        const user = await User.findOne({ email: email.toLowerCase().trim() })
        if (!user) {
            return res.status(404).json({ message: "User not found" })
        }

        user.password = newPassword
        await user.save()

        return res
            .status(200)
            .json({ message: "Password reset successful. You can now log in." })
    } catch (error) {
        console.error("Forgot password error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
