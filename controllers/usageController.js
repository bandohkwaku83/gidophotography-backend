import Folder from "../models/Folder.js"
import FolderMedia from "../models/FolderMedia.js"
import Client from "../models/Client.js"

const MEDIA = FolderMedia.collection.name
const CLIENTS_COLL = Client.collection.name

function pct(part, total) {
    if (!total || total <= 0) return 0
    return Math.round((part / total) * 10000) / 100
}

/**
 * Global storage totals and category percentages (bytes from FolderMedia.size).
 */
export const getUsageSummary = async (req, res) => {
    try {
        const rows = await FolderMedia.aggregate([
            {
                $group: {
                    _id: null,
                    raws_size_bytes: {
                        $sum: {
                            $cond: [
                                { $eq: ["$kind", "raw"] },
                                { $ifNull: ["$size", 0] },
                                0,
                            ],
                        },
                    },
                    selections_size_bytes: {
                        $sum: {
                            $cond: [
                                { $eq: ["$kind", "selection"] },
                                { $ifNull: ["$size", 0] },
                                0,
                            ],
                        },
                    },
                    finals_size_bytes: {
                        $sum: {
                            $cond: [
                                { $eq: ["$kind", "final"] },
                                { $ifNull: ["$size", 0] },
                                0,
                            ],
                        },
                    },
                },
            },
        ])

        const r = rows[0] || {}
        const raws_size_bytes = r.raws_size_bytes || 0
        const selections_size_bytes = r.selections_size_bytes || 0
        const finals_size_bytes = r.finals_size_bytes || 0
        const total_storage_bytes =
            raws_size_bytes + selections_size_bytes + finals_size_bytes

        return res.status(200).json({
            total_storage_bytes,
            raws_size_bytes,
            selections_size_bytes,
            finals_size_bytes,
            by_category: {
                raws: {
                    bytes: raws_size_bytes,
                    percent_of_total: pct(raws_size_bytes, total_storage_bytes),
                },
                selections: {
                    bytes: selections_size_bytes,
                    percent_of_total: pct(
                        selections_size_bytes,
                        total_storage_bytes
                    ),
                },
                finals: {
                    bytes: finals_size_bytes,
                    percent_of_total: pct(
                        finals_size_bytes,
                        total_storage_bytes
                    ),
                },
            },
        })
    } catch (error) {
        console.error("Usage summary error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}

const SORT_FIELDS = new Set(["total_size", "name"])

/**
 * Per-gallery (folder) breakdown with client name.
 * Query: sort_by=total_size|name (default total_size), order=asc|desc
 * Default order: desc for total_size, asc for name.
 */
export const getUsageGalleries = async (req, res) => {
    try {
        let sortBy = (req.query.sort_by || "total_size").toLowerCase()
        if (sortBy === "total") sortBy = "total_size"
        if (!SORT_FIELDS.has(sortBy)) {
            return res.status(400).json({
                message: 'sort_by must be "total_size" or "name"',
            })
        }

        let order = (req.query.order || "").toLowerCase()
        if (!order) {
            order = sortBy === "name" ? "asc" : "desc"
        }
        if (order !== "asc" && order !== "desc") {
            return res.status(400).json({
                message: 'order must be "asc" or "desc"',
            })
        }
        const sortDir = order === "asc" ? 1 : -1

        const sortStage =
            sortBy === "name"
                ? { name: sortDir }
                : { total_size_bytes: sortDir }

        const galleries = await Folder.aggregate([
            {
                $lookup: {
                    from: MEDIA,
                    let: { fid: "$_id" },
                    pipeline: [
                        {
                            $match: {
                                $expr: { $eq: ["$folder", "$$fid"] },
                            },
                        },
                        {
                            $group: {
                                _id: null,
                                raws_size_bytes: {
                                    $sum: {
                                        $cond: [
                                            { $eq: ["$kind", "raw"] },
                                            { $ifNull: ["$size", 0] },
                                            0,
                                        ],
                                    },
                                },
                                selections_size_bytes: {
                                    $sum: {
                                        $cond: [
                                            { $eq: ["$kind", "selection"] },
                                            { $ifNull: ["$size", 0] },
                                            0,
                                        ],
                                    },
                                },
                                finals_size_bytes: {
                                    $sum: {
                                        $cond: [
                                            { $eq: ["$kind", "final"] },
                                            { $ifNull: ["$size", 0] },
                                            0,
                                        ],
                                    },
                                },
                            },
                        },
                    ],
                    as: "usageAgg",
                },
            },
            {
                $addFields: {
                    raws_size_bytes: {
                        $let: {
                            vars: {
                                row: { $arrayElemAt: ["$usageAgg", 0] },
                            },
                            in: { $ifNull: ["$$row.raws_size_bytes", 0] },
                        },
                    },
                    selections_size_bytes: {
                        $let: {
                            vars: {
                                row: { $arrayElemAt: ["$usageAgg", 0] },
                            },
                            in: { $ifNull: ["$$row.selections_size_bytes", 0] },
                        },
                    },
                    finals_size_bytes: {
                        $let: {
                            vars: {
                                row: { $arrayElemAt: ["$usageAgg", 0] },
                            },
                            in: { $ifNull: ["$$row.finals_size_bytes", 0] },
                        },
                    },
                },
            },
            {
                $addFields: {
                    total_size_bytes: {
                        $add: [
                            "$raws_size_bytes",
                            "$selections_size_bytes",
                            "$finals_size_bytes",
                        ],
                    },
                },
            },
            {
                $lookup: {
                    from: CLIENTS_COLL,
                    localField: "client",
                    foreignField: "_id",
                    as: "clientDoc",
                },
            },
            {
                $unwind: {
                    path: "$clientDoc",
                    preserveNullAndEmptyArrays: true,
                },
            },
            {
                $project: {
                    _id: 0,
                    id: "$_id",
                    name: "$eventName",
                    client: {
                        id: "$clientDoc._id",
                        name: {
                            $ifNull: ["$clientDoc.name", ""],
                        },
                    },
                    raws_size_bytes: 1,
                    selections_size_bytes: 1,
                    finals_size_bytes: 1,
                    total_size_bytes: 1,
                },
            },
            { $sort: sortStage },
        ])

        return res.status(200).json({
            count: galleries.length,
            sort_by: sortBy,
            order,
            galleries,
        })
    } catch (error) {
        console.error("Usage galleries error:", error)
        return res.status(500).json({ message: "Server error" })
    }
}
