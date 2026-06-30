export const GALLERY_LABEL_MAX_LEN = 80
export const DEFAULT_GENERAL_SET_LABEL = "General"

export function galleryCollectionFieldsFromFolder(folder) {
    const obj = folder?.toObject ? folder.toObject() : folder || {}
    const out = {
        generalSetSortOrder:
            obj.generalSetSortOrder != null && Number.isFinite(obj.generalSetSortOrder)
                ? obj.generalSetSortOrder
                : -1,
    }
    const all = obj.allMediaLabel != null ? String(obj.allMediaLabel).trim() : ""
    const general = obj.generalSetLabel != null ? String(obj.generalSetLabel).trim() : ""
    if (all) out.allMediaLabel = all
    if (general) out.generalSetLabel = general
    return out
}

export function effectiveGeneralSetLabel(galleryConfig = {}) {
    const label = galleryConfig?.generalSetLabel
    if (label != null && String(label).trim()) return String(label).trim()
    return DEFAULT_GENERAL_SET_LABEL
}

/**
 * @param {unknown} raw
 * @param {string} fieldName
 * @returns {string | undefined} trimmed label, or undefined when `raw` is omitted
 */
export function parseGalleryCollectionLabel(raw, fieldName) {
    if (raw === undefined) return undefined
    const trimmed = String(raw ?? "").trim()
    if (!trimmed) {
        const err = new Error(`${fieldName} cannot be empty`)
        err.status = 400
        throw err
    }
    if (trimmed.length > GALLERY_LABEL_MAX_LEN) {
        const err = new Error(
            `${fieldName} must be ${GALLERY_LABEL_MAX_LEN} characters or fewer`
        )
        err.status = 400
        throw err
    }
    return trimmed
}

export function sortMediaItems(items) {
    return [...items].sort((a, b) => {
        const orderDiff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        if (orderDiff !== 0) return orderDiff
        return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    })
}

/**
 * Group media into General + named set buckets, sort buckets by tab order,
 * sort items within each bucket by media sortOrder.
 */
export function buildOrderedSetBuckets(items, setDocs, galleryConfig = {}) {
    const generalLabel = effectiveGeneralSetLabel(galleryConfig)
    const generalSortOrder = galleryConfig?.generalSetSortOrder ?? -1

    const bySetId = new Map()
    for (const s of setDocs) {
        bySetId.set(String(s._id), {
            setId: String(s._id),
            name: s.name,
            sortOrder: s.sortOrder ?? 0,
            items: [],
        })
    }

    const general = {
        setId: null,
        name: generalLabel,
        sortOrder: generalSortOrder,
        items: [],
    }

    for (const item of items) {
        const sid = item?.setId ?? null
        if (sid && bySetId.has(String(sid))) {
            bySetId.get(String(sid)).items.push(item)
        } else {
            general.items.push(item)
        }
    }

    const buckets = [general, ...bySetId.values()]
    buckets.sort((a, b) => {
        const diff = (a.sortOrder ?? 0) - (b.sortOrder ?? 0)
        if (diff !== 0) return diff
        if (a.setId == null) return -1
        if (b.setId == null) return 1
        return String(a.setId).localeCompare(String(b.setId))
    })

    for (const bucket of buckets) {
        bucket.items = sortMediaItems(bucket.items)
    }

    return buckets
}
