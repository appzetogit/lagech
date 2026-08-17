/**
 * FoodType's Prisma name for 'Non-Veg' is NonVeg — the hyphen is a `@map`, so
 * the value on the wire and the value in the client differ and have to be
 * translated in both directions. Getting this wrong does not throw; it silently
 * marks a dish as the wrong diet, which is why it lives in one place.
 */

/** Client value → Prisma enum member. */
export const toFoodTypeColumn = (value) => (String(value || '').trim() === 'Veg' ? 'Veg' : 'NonVeg');

/**
 * Prisma enum member (or a client value) → the hyphenated form the apps read.
 * 'Egg' and anything unrecognised have always counted as non-veg.
 */
export const fromFoodTypeColumn = (value) => (String(value || '').trim() === 'Veg' ? 'Veg' : 'Non-Veg');
