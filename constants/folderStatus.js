/** Stored on Folder; `completed` is legacy — normalize to `delivered` for UI. */
export const FOLDER_STATUS_VALUES = [
    "draft",
    "selecting",
    "delivered",
    "completed",
]

export function normalizeFolderStatus(status) {
    if (!status) return "draft"
    if (status === "completed") return "delivered"
    return status
}
