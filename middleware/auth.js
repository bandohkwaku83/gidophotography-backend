import jwt from "jsonwebtoken"
import User from "../models/User.js"
import BlacklistedToken from "../models/BlacklistedToken.js"

export const protect = async (req, res, next) => {
    try {
        const authHeader = req.headers.authorization
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return res
                .status(401)
                .json({ message: "Not authorized, token missing" })
        }

        const token = authHeader.split(" ")[1]

        const blacklisted = await BlacklistedToken.findOne({ token })
        if (blacklisted) {
            return res
                .status(401)
                .json({ message: "Token has been invalidated, please log in again" })
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET)

        const user = await User.findById(decoded.id)
        if (!user) {
            return res.status(401).json({ message: "User no longer exists" })
        }

        req.user = user
        req.token = token
        req.tokenExp = decoded.exp
        next()
    } catch (error) {
        return res.status(401).json({ message: "Not authorized, token invalid" })
    }
}
