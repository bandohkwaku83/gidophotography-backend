/** Lowercase slug for shoot category ids (e.g. "Baptism/Christening" → "baptism-christening"). */
export function slugify(text) {
    return String(text ?? "")
        .trim()
        .toLowerCase()
        .replace(/[^\w\s-]/g, "")
        .replace(/\//g, " ")
        .replace(/\s+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
}
