import { buildGalleryShareUrl } from "./shareUrl.js"

export const SMS_PLACEHOLDER_DEFS = [
    {
        key: "client_name",
        token: "{{client_name}}",
        label: "Client name",
    },
    {
        key: "event_date",
        token: "{{event_date}}",
        label: "Event date",
    },
    {
        key: "gallery_link",
        token: "{{gallery_link}}",
        label: "Gallery link",
    },
]

const TOKEN_PATTERN =
    /\{\{\s*(client_name|event_date|gallery_link)\s*\}\}/g

function formatEventDate(dateVal) {
    if (!dateVal) return ""
    const x = new Date(dateVal)
    if (Number.isNaN(x.getTime())) return ""
    const dd = String(x.getDate()).padStart(2, "0")
    const mm = String(x.getMonth() + 1).padStart(2, "0")
    const yyyy = x.getFullYear()
    return `${dd}/${mm}/${yyyy}`
}

/**
 * @param {string} template
 * @param {{ clientName?: string, folder?: object|null, galleryLinkOverride?: string }} ctx
 *        galleryLinkOverride — when set, used instead of buildGalleryShareUrl(folder) for {{gallery_link}}
 */
export function replaceSmsPlaceholders(template, ctx = {}) {
    const clientName = ctx.clientName ?? ""
    const folder = ctx.folder
    const eventDate = folder ? formatEventDate(folder.eventDate) : ""
    let galleryLink = ""
    if (ctx.galleryLinkOverride !== undefined && ctx.galleryLinkOverride !== null) {
        galleryLink = String(ctx.galleryLinkOverride)
    } else if (folder) {
        galleryLink = buildGalleryShareUrl(folder)
    }

    return String(template).replace(TOKEN_PATTERN, (_, key) => {
        if (key === "client_name") return clientName
        if (key === "event_date") return eventDate
        if (key === "gallery_link") return galleryLink
        return ""
    })
}

export function templateNeedsFolder(template) {
    return /\{\{\s*event_date\s*\}\}/.test(template) ||
        /\{\{\s*gallery_link\s*\}\}/.test(template)
}
