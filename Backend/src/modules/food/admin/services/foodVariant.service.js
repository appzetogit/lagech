import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const toTrimmedString = (value) => (value == null ? '' : String(value).trim());

const toNonNegativeNumber = (value, fallback = 0) => {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
};

export const extractRawFoodVariants = (value = {}) => {
    if (Array.isArray(value?.variants)) return value.variants;
    if (Array.isArray(value?.variations)) return value.variations;
    return [];
};

export const normalizeFoodVariantsInput = (value = [], options = {}) => {
    const {
        allowEmpty = true,
        priceLabel = 'Variant price'
    } = options;

    if (value == null || value === '') {
        if (allowEmpty) return [];
        throw new ValidationError('At least one variant is required');
    }

    if (!Array.isArray(value)) {
        throw new ValidationError('Variants must be an array');
    }

    const normalized = value
        .map((entry = {}) => {
            const name = toTrimmedString(entry?.name);
            if (!name) {
                throw new ValidationError('Each variant must have a name');
            }

            const price = Number(entry?.price);
            if (!Number.isFinite(price) || price <= 0) {
                throw new ValidationError(`${priceLabel} must be greater than 0`);
            }

            const variant = {
                name,
                price,
                otherPrice: toNonNegativeNumber(entry?.otherPrice, 0)
            };

            // A supplied id means "update this variant" rather than "add one".
            const variantId = entry?._id || entry?.id;
            if (isId(variantId)) variant.id = String(variantId);

            return variant;
        })
        .filter(Boolean);

    if (!allowEmpty && normalized.length === 0) {
        throw new ValidationError('At least one variant is required');
    }

    return normalized;
};

export const serializeFoodVariants = (value = []) =>
    (Array.isArray(value) ? value : [])
        .map((entry = {}) => {
            const name = toTrimmedString(entry?.name);
            const price = Number(entry?.price);
            if (!name || !Number.isFinite(price) || price <= 0) return null;

            const variantId = entry?._id || entry?.id;
            return {
                id: variantId ? String(variantId) : '',
                _id: variantId ? String(variantId) : '',
                name,
                price,
                otherPrice: toNonNegativeNumber(entry?.otherPrice, 0)
            };
        })
        .filter(Boolean);

export const hasFoodVariants = (value = {}) => serializeFoodVariants(value?.variants || value?.variations || []).length > 0;

export const getFoodDisplayPrice = (value = {}) => {
    const variants = serializeFoodVariants(value?.variants || value?.variations || []);
    if (variants.length > 0) {
        return Math.min(...variants.map((entry) => Number(entry.price) || 0));
    }

    const price = Number(value?.price);
    return Number.isFinite(price) ? price : 0;
};

export const getFoodDisplayOtherPrice = (value = {}) => {
    const variants = serializeFoodVariants(value?.variants || value?.variations || []);
    if (variants.length > 0) {
        const validOtherPrices = variants
            .map((entry) => Number(entry.otherPrice) || 0)
            .filter((p) => p > 0);
        return validOtherPrices.length > 0 ? Math.min(...validOtherPrices) : 0;
    }

    const otherPrice = Number(value?.otherPrice);
    if (Number.isFinite(otherPrice) && otherPrice > 0) {
        return otherPrice;
    }

    return 0;
};

/**
 * Reconcile a dish's variant rows against what the client sent.
 *
 * An entry carrying an id updates that row; one without is new; a row whose id
 * is absent from the payload is removed. Replacing the whole set wholesale
 * would reissue every id, and a cart already holding one would fail checkout
 * with "that size no longer exists".
 *
 * Takes a transaction client, because the variant write and the dish's own
 * reprice have to land together.
 */
export const syncFoodVariants = async (tx, foodItemId, variants = []) => {
    const keepIds = variants.map((variant) => variant.id).filter(Boolean);

    await tx.foodItemVariant.deleteMany({
        where: { foodItemId, ...(keepIds.length ? { id: { notIn: keepIds } } : {}) },
    });

    for (const [index, variant] of variants.entries()) {
        const data = {
            name: variant.name,
            price: variant.price,
            otherPrice: variant.otherPrice,
            sortOrder: index,
        };
        if (variant.id) {
            await tx.foodItemVariant.update({ where: { id: variant.id }, data });
        } else {
            await tx.foodItemVariant.create({ data: { foodItemId, ...data } });
        }
    }
};
