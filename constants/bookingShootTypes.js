import { slugify } from "../utils/slugify.js"

const SHOOT_TYPE_LABELS = [
    "Family",
    "Adventure",
    "Anniversary",
    "Architecture",
    "Automotive",
    "Baby",
    "Baptism/Christening",
    "Bar/Bat Mitzvah",
    "Birth",
    "Birthday",
    "Boudoir",
    "Bridal",
    "Brit",
    "Business",
    "Children",
    "Christmas",
    "Commercial",
    "Concert",
    "Confirmation",
    "Couples",
    "Dance",
    "Editorial",
    "Elopement",
    "Engagement",
    "Equine",
    "Event",
    "Farewell",
    "Film",
    "First Communion",
    "Food",
    "Graduation",
    "Headshots",
    "Holidays",
    "Interiors",
    "Landscape",
    "Lifestyle",
    "Live Music",
    "Look Book",
    "Maternity",
    "Milestones",
    "Mini Session",
    "Modeling",
    "Newborn",
    "Other",
    "Outdoor",
    "Passion Portrait",
    "Personal Branding",
    "Pets",
    "Photo Booth",
    "Portraits",
    "Pre-Wedding",
    "Products",
    "Proposal",
    "Quinceanera",
    "Real Estate",
    "Rehearsal Dinner",
    "Religious",
    "School",
    "Seniors",
    "Sport",
    "Styled Shoots",
    "Theater",
    "Travel",
    "Video",
    "Vow Renewal",
    "Wedding",
    "Workshop",
]

const SHOOT_TYPE_COLORS = [
    "red",
    "teal",
    "purple",
    "green",
    "pink",
    "blue",
    "orange",
    "sky",
    "amber",
    "indigo",
    "rose",
    "cyan",
    "lime",
    "violet",
    "fuchsia",
    "emerald",
]

export const BOOKING_SHOOT_TYPES = SHOOT_TYPE_LABELS.map((label, index) => ({
    id: slugify(label) || "other",
    label,
    color: SHOOT_TYPE_COLORS[index % SHOOT_TYPE_COLORS.length],
}))

/** Legacy booking category ids → current type id */
const LEGACY_CATEGORY_IDS = {
    christening: "baptism-christening",
}

const byId = new Map(BOOKING_SHOOT_TYPES.map((t) => [t.id, t]))
const byLabel = new Map(
    BOOKING_SHOOT_TYPES.map((t) => [t.label.toLowerCase(), t])
)

const resolveMeta = (categoryId) => {
    const id = LEGACY_CATEGORY_IDS[categoryId] ?? categoryId
    return byId.get(id)
}

export const normalizeShootCategory = (value) => {
    const raw = value?.trim()
    if (!raw) return { error: "Shoot type is required" }

    const slug = raw.toLowerCase()
    const legacyId = LEGACY_CATEGORY_IDS[slug]
    if (legacyId) {
        return { category: legacyId, meta: byId.get(legacyId) }
    }

    if (byId.has(slug)) {
        return { category: slug, meta: byId.get(slug) }
    }

    const fromLabel = byLabel.get(slug)
    if (fromLabel) {
        return { category: fromLabel.id, meta: fromLabel }
    }

    const partial = BOOKING_SHOOT_TYPES.find(
        (t) => t.label.toLowerCase() === slug || t.id === slug.replace(/\s+/g, "-")
    )
    if (partial) {
        return { category: partial.id, meta: partial }
    }

    return { error: "Invalid shoot type" }
}

export const shootTypeLabel = (category) =>
    resolveMeta(category)?.label ?? "Other"

export const shootTypeColor = (category) =>
    resolveMeta(category)?.color ?? "sky"

/** @deprecated Use BOOKING_SHOOT_TYPES ids */
export const BOOKING_SHOOT_TYPE_LABELS = SHOOT_TYPE_LABELS
