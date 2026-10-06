/**
 * Nutrition facts and allergens on a dish ("Calories 250 kcal", "Peanuts").
 *
 * Free text, as the previous system stored them, so unlike search tags the
 * case and punctuation are kept -- "Vitamin B12" and "5g fibre" read as typed.
 * Only tidied: spaces collapsed, each entry once (ignoring case), at most 30
 * entries of 60 characters. Accepts an array or a comma-separated string.
 */
export const MAX_FACTS = 30;
export const MAX_FACT_LENGTH = 60;

export const normalizeFact = (value) =>
    String(value ?? '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, MAX_FACT_LENGTH)
        .trim();

export function normalizeFacts(raw) {
    if (raw === null || raw === undefined) return [];
    const list = Array.isArray(raw) ? raw : String(raw).split(',');
    const out = [];
    const seen = new Set();
    for (const entry of list) {
        const fact = normalizeFact(entry);
        const key = fact.toLowerCase();
        if (!fact || seen.has(key)) continue;
        seen.add(key);
        out.push(fact);
        if (out.length === MAX_FACTS) break;
    }
    return out;
}

/** The two fields from a request body, only those it mentions. */
export function nutritionFields(body = {}) {
    const data = {};
    if (body.nutrition !== undefined) data.nutrition = normalizeFacts(body.nutrition);
    if (body.allergens !== undefined) data.allergens = normalizeFacts(body.allergens);
    return data;
}

/** Both lists as the apps read them: always arrays. */
export const serializeNutrition = (food = {}) => ({
    nutrition: Array.isArray(food.nutrition) ? food.nutrition : [],
    allergens: Array.isArray(food.allergens) ? food.allergens : [],
});
