/**
 * Search tags on a dish ("healthy food", "momos"): one tidy form wherever they
 * come from -- the admin form, the old system, or a search box -- so a search
 * for "Momos " finds a dish tagged "momos".
 *
 * Lowercase, emoji and punctuation dropped, spaces collapsed, each tag once,
 * at most 10 of 30 characters. Accepts an array or a comma-separated string.
 */
export const MAX_TAGS = 10;
export const MAX_TAG_LENGTH = 30;

export const normalizeTag = (value) =>
    String(value ?? '')
        // "HealthyFood" is two words; lowercase would glue them for good.
        .replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_TAG_LENGTH)
        .trim();

export function normalizeTags(raw) {
    const list = Array.isArray(raw) ? raw : String(raw ?? '').split(',');
    const tags = [];
    for (const entry of list) {
        const tag = normalizeTag(entry);
        if (tag && !tags.includes(tag)) tags.push(tag);
        if (tags.length === MAX_TAGS) break;
    }
    return tags;
}
