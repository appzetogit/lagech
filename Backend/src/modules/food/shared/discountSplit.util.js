/**
 * Who pays for a discount — the platform, the restaurant, or both.
 *
 * Takes the same flat `money` object as restaurantPayout.util.js; see the note
 * there on why these do not take an order or a transaction directly.
 */

function calculateOfferDiscount(offer, subtotal) {
    const safeSubtotal = Math.max(0, Number(subtotal) || 0);
    if (!offer || safeSubtotal <= 0) return 0;
    // Only 'percentage' is scaled; every other type — including the enum member
    // Prisma spells flat_price — is a fixed number of rupees.
    if (offer.discountType === 'percentage') {
        const raw = safeSubtotal * ((Number(offer.discountValue) || 0) / 100);
        const capped = Number(offer.maxDiscount) ? Math.min(raw, Number(offer.maxDiscount)) : raw;
        return Math.max(0, Math.min(safeSubtotal, Math.floor(capped)));
    }
    return Math.max(0, Math.min(safeSubtotal, Math.floor(Number(offer.discountValue) || 0)));
}

function offerMatchesRestaurant(offer, restaurantId) {
    if (!offer || offer.restaurantScope !== 'selected') return true;
    const ids = Array.isArray(offer.restaurantIds) && offer.restaurantIds.length > 0
        ? offer.restaurantIds
        : [offer.restaurantId].filter(Boolean);
    return ids.some((id) => String(id) === String(restaurantId));
}

const NO_SPLIT = {
    adminDiscountShare: 0,
    restaurantDiscountShare: 0,
    adminBearPercentage: 0,
    restaurantBearPercentage: 0,
};

export function resolveDiscountSplit({ money = {}, offers, restaurantId }) {
    const discount = Number(money.discount) || 0;
    if (discount <= 0) return { ...NO_SPLIT };

    // Recorded at checkout: that is what actually happened, so nothing is re-derived.
    const savedAdminShare = Number(money.adminDiscountShare) || 0;
    const savedRestaurantShare = Number(money.restaurantDiscountShare) || 0;
    if (savedAdminShare > 0 || savedRestaurantShare > 0) {
        return {
            adminDiscountShare: savedAdminShare,
            restaurantDiscountShare: savedRestaurantShare,
            adminBearPercentage: Number(money.discountAdminBearPercentage) || 0,
            restaurantBearPercentage: Number(money.discountRestaurantBearPercentage) || 0,
        };
    }

    // Older orders stored no split, so the offer that produced the discount has
    // to be identified — by coupon code where there was one, otherwise by which
    // offer would have produced exactly this amount.
    const couponCode = String(money.couponCode || '').trim().toUpperCase();
    const subtotal = Number(money.subtotal) || 0;
    const scopedOffers = (offers || []).filter((offer) => offerMatchesRestaurant(offer, restaurantId));
    const matchedByCode = couponCode
        ? scopedOffers.find((offer) => String(offer?.couponCode || '').trim().toUpperCase() === couponCode)
        : null;
    const matchingOffers = matchedByCode
        ? [matchedByCode]
        : scopedOffers.filter((offer) => calculateOfferDiscount(offer, subtotal) === discount);

    // Ambiguous, or nothing matched: the platform absorbs it. Guessing wrong
    // here would take money off a restaurant that never agreed to the offer.
    if (matchingOffers.length !== 1) {
        return {
            adminDiscountShare: discount,
            restaurantDiscountShare: 0,
            adminBearPercentage: 100,
            restaurantBearPercentage: 0,
        };
    }

    return splitDiscountForOffer(matchingOffers[0], discount);
}

/**
 * Splits a discount amount between admin and restaurant based on the offer's
 * bear percentages (normalized). A missing/unknown offer defaults to admin bearing 100%.
 */
export function splitDiscountForOffer(offer, discount) {
    const safeDiscount = Math.max(0, Number(discount) || 0);
    if (safeDiscount <= 0) return { ...NO_SPLIT };

    // A restaurant's own offer is on the restaurant unless it says otherwise.
    const byRestaurant = offer?.createdByRole === 'RESTAURANT';
    const clamp = (value) => Math.max(0, Math.min(100, Number(value) || 0));
    const adminPct = clamp(offer?.adminBearPercentage ?? (byRestaurant ? 0 : 100));
    const restaurantPct = clamp(offer?.restaurantBearPercentage ?? (byRestaurant ? 100 : 0));

    const totalPct = adminPct + restaurantPct;
    const adminBearPercentage = totalPct > 0 ? (adminPct / totalPct) * 100 : 100;
    const restaurantBearPercentage = totalPct > 0 ? (restaurantPct / totalPct) * 100 : 0;

    const restaurantDiscountShare = Math.round(safeDiscount * (restaurantBearPercentage / 100) * 100) / 100;
    const adminDiscountShare = Math.max(0, Math.round((safeDiscount - restaurantDiscountShare) * 100) / 100);

    return { adminDiscountShare, restaurantDiscountShare, adminBearPercentage, restaurantBearPercentage };
}

/**
 * Looks up the coupon's offer and splits the discount. Falls back to
 * admin-bears-100% when the offer cannot be loaded.
 */
export async function resolveDiscountSplitByCoupon({ couponCode, discount }) {
    const safeDiscount = Math.max(0, Number(discount) || 0);
    if (safeDiscount <= 0) return { ...NO_SPLIT };

    let offer = null;
    if (couponCode) {
        try {
            const { prisma } = await import('../../../config/prisma.js');
            offer = await prisma.foodOffer.findUnique({
                where: { couponCode: String(couponCode).trim().toUpperCase() },
            });
        } catch (err) {
            offer = null;
        }
    }
    return splitDiscountForOffer(offer, safeDiscount);
}
