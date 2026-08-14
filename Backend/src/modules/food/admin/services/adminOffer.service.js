import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Admin-created coupons, extracted from admin.service.js.
 *
 * A coupon names its restaurants either singly (restaurantId) or as a list
 * (restaurantIds). Both are still supported because both exist in the data and
 * the admin UI writes either; the list is the newer form.
 *
 * `restaurantIds` is a plain String[] column, so the two .populate() calls the
 * Mongo version used become one lookup of every named restaurant across the
 * page.
 */

const num = (value) => Number(value || 0);

/** Hydrate every restaurant any of these offers names, in one query. */
const restaurantsNamedBy = async (offers) => {
    const ids = [
        ...new Set(
            offers
                .flatMap((offer) => [...(offer.restaurantIds || []), offer.restaurantId])
                .map((id) => String(id || ''))
                .filter(isId)
        ),
    ];
    if (!ids.length) return new Map();

    const rows = await prisma.foodRestaurant.findMany({
        where: { id: { in: ids } },
        select: { id: true, restaurantName: true },
    });
    return new Map(rows.map((r) => [r.id, r]));
};

export async function getAllOffers(_query = {}) {
    const list = await prisma.foodOffer.findMany({ orderBy: { createdAt: 'desc' } });
    const byId = await restaurantsNamedBy(list);
    const now = Date.now();

    const offers = list.map((o, index) => {
        const endTs = o.endDate ? new Date(o.endDate).getTime() : null;
        const isExpired = Boolean(endTs && now >= endTs);

        const selectedIds = (o.restaurantIds || []).length
            ? o.restaurantIds
            : o.restaurantId ? [o.restaurantId] : [];

        const restaurantName =
            o.restaurantScope === 'selected'
                ? selectedIds
                    .map((id) => byId.get(String(id))?.restaurantName)
                    .filter(Boolean)
                    .join(', ') || 'Selected Restaurants'
                : 'All Restaurants';

        return {
            sl: index + 1,
            offerId: o.id,
            dishId: 'all',
            restaurantName,
            dishName: 'All Items',
            couponCode: o.couponCode,
            // The enum's Prisma name is first_time; the UI says 'new'.
            customerGroup: o.customerScope === 'first_time' ? 'new' : 'all',
            discountType: o.discountType,
            discountPercentage: o.discountType === 'percentage' ? num(o.discountValue) : 0,
            originalPrice: o.discountType === 'flat_price' ? num(o.discountValue) : 0,
            discountedPrice: 0,
            // Expiry is derived from the date, not stored — a coupon whose end
            // date has passed reads inactive even before the sweep runs.
            status: isExpired ? 'inactive' : o.status || 'active',
            showInCart: o.showInCart !== false,
            endDate: o.endDate || null,
            minOrderValue: num(o.minOrderValue),
            maxDiscount: o.maxDiscount === null ? null : num(o.maxDiscount),
            usageLimit: o.usageLimit ?? null,
            usedCount: o.usedCount ?? 0,
            restaurantScope: o.restaurantScope,
            createdByRole: o.createdByRole || 'ADMIN',
            // Who funds the discount. The column has a default, so the old
            // "derive it from createdByRole" fallback is only reached for a row
            // written before the columns existed.
            adminBearPercentage: num(o.adminBearPercentage),
            restaurantBearPercentage: num(o.restaurantBearPercentage),
        };
    });

    return { offers };
}

export async function createAdminOffer(body = {}) {
    const selected = body.restaurantScope === 'selected';
    const restaurantIds = selected
        ? (body.restaurantIds || []).map(String).filter(isId)
        : [];

    let offer;
    try {
        offer = await prisma.foodOffer.create({
            data: {
                couponCode: body.couponCode,
                discountType: body.discountType,
                discountValue: body.discountValue,
                customerScope: body.customerScope,
                restaurantScope: body.restaurantScope,
                restaurantId: selected && isId(body.restaurantId) ? String(body.restaurantId) : null,
                restaurantIds,
                minOrderValue: body.minOrderValue ?? 0,
                maxDiscount: body.maxDiscount ?? null,
                usageLimit: body.usageLimit ?? null,
                perUserLimit: body.perUserLimit ?? null,
                startDate: body.startDate ? new Date(body.startDate) : null,
                endDate: body.endDate ? new Date(body.endDate) : null,
                isFirstOrderOnly: body.isFirstOrderOnly ?? false,
                // Created already expired: start inactive rather than appearing
                // live until a sweep notices.
                status:
                    body.endDate && new Date(body.endDate).getTime() <= Date.now()
                        ? 'inactive'
                        : 'active',
                showInCart: true,
                createdByRole: 'ADMIN',
                // An admin campaign is platform-funded by default.
                adminBearPercentage: body.adminBearPercentage ?? 100,
                restaurantBearPercentage: body.restaurantBearPercentage ?? 0,
            },
        });
    } catch (error) {
        // couponCode is unique; the insert settles it rather than a prior lookup.
        if (error?.code === 'P2002') throw new ValidationError('Coupon code already exists');
        throw error;
    }

    const invited = offer.restaurantScope === 'selected'
        ? [...(offer.restaurantIds || []), offer.restaurantId].filter(Boolean)
        : [];

    if (invited.length) {
        try {
            const { notifyOwnersSafely } = await import('../../../../core/notifications/firebase.service.js');
            await notifyOwnersSafely(
                invited.map((ownerId) => ({ ownerType: 'RESTAURANT', ownerId })),
                {
                    title: 'New Campaign Invitation!',
                    body: `You have been invited to join a new campaign: "${offer.couponCode}". Check it out now!`,
                    image: 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png',
                    data: {
                        type: 'campaign_invitation',
                        offerId: offer.id,
                        couponCode: offer.couponCode,
                    },
                },
            );
        } catch (e) {
            console.error('Failed to send campaign invitation notification:', e);
        }
    }

    return offer;
}

export async function updateAdminOfferCartVisibility(offerId, itemId, showInCart) {
    if (!isId(offerId) || !itemId) return null;

    const { count } = await prisma.foodOffer.updateMany({
        where: { id: String(offerId) },
        data: { showInCart: Boolean(showInCart) },
    });
    if (!count) return null;

    return prisma.foodOffer.findUnique({ where: { id: String(offerId) } });
}

export async function deleteAdminOffer(id) {
    if (!isId(id)) return null;

    // Usage rows cascade from the offer (onDelete: Cascade), so deleting the
    // offer takes them with it — the explicit second delete Mongo needed is
    // gone, and there is no window where usages outlive their offer.
    const { count } = await prisma.foodOffer.deleteMany({ where: { id: String(id) } });
    return count ? { id: String(id) } : null;
}

/** Sweep coupons whose end date has passed. Called by the maintenance worker. */
export async function expireExpiredOffers() {
    const { count } = await prisma.foodOffer.updateMany({
        where: { status: 'active', endDate: { lte: new Date() } },
        data: { status: 'inactive' },
    });
    return { expired: count };
}
