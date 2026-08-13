import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { calculateOrderPricing } from '../../orders/services/order-pricing.service.js';

const toPositiveInt = (value, fallback = 1) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.floor(parsed);
};

const toNonNegativeNumber = (value, fallback = 0) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return fallback;
    return parsed;
};

/**
 * The delivery-fee GST a stored cart already recorded.
 *
 * This used to invent 18% whenever the stored value was zero, which is a second
 * home for a rate that belongs in the fee settings — and it would have silently
 * put the charge back on every cart the moment it was switched off there. A
 * stored zero now means zero.
 */
const resolveStoredDeliveryFeeGst = (deliveryFee, deliveryFeeGst) => {
    if (toNonNegativeNumber(deliveryFee, 0) <= 0) return 0;
    return toNonNegativeNumber(deliveryFeeGst, 0);
};

const normalizeCartItems = (items = []) => {
    if (!Array.isArray(items)) return [];

    return items
        .filter((item) => item && typeof item === 'object')
        .map((item) => {
            const quantity = toPositiveInt(item.quantity, 1);
            const price = toNonNegativeNumber(item.price ?? item.variantPrice, 0);
            const variantPrice = toNonNegativeNumber(item.variantPrice ?? item.price, price);

            return {
                lineItemId: String(item.lineItemId || item.id || ''),
                itemId: String(item.itemId || item.productId || item.id || ''),
                name: String(item.name || 'Item').trim(),
                price,
                otherPrice: (() => {
                    const other = toNonNegativeNumber(item.otherPrice, 0);
                    return other > price ? other : 0;
                })(),
                quantity,
                variantId: String(item.variantId || ''),
                variantName: String(item.variantName || ''),
                variantPrice,
                image: String(item.image || item.imageUrl || ''),
                foodType: String(item.foodType || ''),
                isVeg: item.isVeg === true || String(item.foodType || '').toLowerCase() === 'veg',
            };
        })
        .filter((item) => item.name && item.quantity > 0);
};

const normalizePricingSnapshot = (pricing = null) => {
    if (!pricing || typeof pricing !== 'object') return null;

    const subtotal = toNonNegativeNumber(pricing.subtotal, 0);
    const tax = toNonNegativeNumber(pricing.tax, 0);
    const packagingFee = toNonNegativeNumber(pricing.packagingFee, 0);
    const deliveryFee = toNonNegativeNumber(pricing.deliveryFee, 0);
    const deliveryFeeGst = resolveStoredDeliveryFeeGst(deliveryFee, pricing.deliveryFeeGst);
    const platformFee = toNonNegativeNumber(pricing.platformFee, 0);
    const discount = toNonNegativeNumber(pricing.discount, 0);
    const deliveryMode = pricing.deliveryMode === 'quick' ? 'quick' : 'basic';
    const quickDeliveryFee = toNonNegativeNumber(pricing.quickDeliveryFee, 0);
    const total = toNonNegativeNumber(
        pricing.total,
        subtotal + packagingFee + deliveryFee + deliveryFeeGst + platformFee + tax - discount,
    );
    const savings = toNonNegativeNumber(pricing.savings, 0);

    return {
        subtotal,
        tax,
        packagingFee,
        deliveryFee,
        deliveryFeeGst,
        platformFee,
        quickDeliveryFee,
        deliveryMode,
        discount,
        total,
        savings,
        couponCode: String(pricing.couponCode || pricing.appliedCoupon?.code || '').trim(),
        deliveryFeeBreakdown: pricing.deliveryFeeBreakdown || null,
        appliedCoupon: pricing.appliedCoupon || null,
    };
};

const mapCartItemsForPricing = (items = []) =>
    items.map((item) => ({
        itemId: item.itemId,
        id: item.itemId,
        price: item.price,
        quantity: item.quantity,
        variantId: item.variantId || undefined,
        variantName: item.variantName || undefined,
        variantPrice: item.variantPrice || item.price,
        name: item.name,
    }));

async function enrichStoredCartPricing(cart, storedPricing) {
    if (!storedPricing || typeof storedPricing !== 'object') return storedPricing;

    const storedDelivery = toNonNegativeNumber(storedPricing.deliveryFee, 0);
    if (storedDelivery > 0) {
        return {
            ...storedPricing,
            deliveryFeeGst: resolveStoredDeliveryFeeGst(storedDelivery, storedPricing.deliveryFeeGst),
        };
    }

    if (!isId(cart.restaurantId)) return storedPricing;

    try {
        const result = await calculateOrderPricing(
            cart.userId,
            {
                restaurantId: cart.restaurantId,
                items: mapCartItemsForPricing(cart.items),
            },
            { skipAvailabilityCheck: true },
        );
        const recalc = result?.pricing;
        if (!recalc) return storedPricing;

        const recalcDelivery = toNonNegativeNumber(recalc.deliveryFee, 0);
        const recalcDeliveryGst = toNonNegativeNumber(recalc.deliveryFeeGst, 0);
        if (recalcDelivery <= 0) return storedPricing;

        const subtotal = toNonNegativeNumber(storedPricing.subtotal, Number(cart.subtotal) || 0);
        const platformFee = toNonNegativeNumber(
            storedPricing.platformFee,
            toNonNegativeNumber(recalc.platformFee, 0),
        );
        const tax = toNonNegativeNumber(storedPricing.tax, toNonNegativeNumber(recalc.tax, 0));
        const discount = toNonNegativeNumber(storedPricing.discount, 0);
        const total = Math.max(0, subtotal + recalcDelivery + recalcDeliveryGst + platformFee + tax - discount);

        return {
            ...storedPricing,
            deliveryFee: recalcDelivery,
            deliveryFeeGst: recalcDeliveryGst,
            deliveryFeeBreakdown: recalc.deliveryFeeBreakdown || storedPricing.deliveryFeeBreakdown || null,
            total,
        };
    } catch {
        return storedPricing;
    }
}

export async function syncUserCart(userId, rawItems = [], rawPricing = null) {
    if (!isId(userId)) throw new ValidationError('Invalid user');

    const id = String(userId);
    const items = normalizeCartItems(rawItems);

    if (items.length === 0) {
        // deleteMany, not delete: emptying a cart that was never saved is a
        // no-op, not a missing-record error.
        await prisma.foodUserCart.deleteMany({ where: { userId: id } });
        return null;
    }

    const rawFirst = Array.isArray(rawItems) ? rawItems[0] : null;
    const data = {
        restaurantId: String(rawFirst?.restaurantId || ''),
        restaurantName: String(rawFirst?.restaurant || rawFirst?.restaurantName || ''),
        // The cart is replaced wholesale on every sync and never queried across
        // users, so items and pricing stay snapshots rather than tables.
        items,
        itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        subtotal: items.reduce((sum, item) => sum + item.price * item.quantity, 0),
        pricing: normalizePricingSnapshot(rawPricing) ?? undefined,
    };

    return prisma.foodUserCart.upsert({
        where: { userId: id },
        create: { userId: id, ...data },
        update: data,
    });
}

export async function listUserCartsForAdmin(query = {}) {
    const page = Math.max(1, toPositiveInt(query.page, 1));
    const limit = Math.min(100, Math.max(1, toPositiveInt(query.limit, 20)));
    const skip = (page - 1) * limit;
    const search = String(query.search || '').trim();

    // itemCount is maintained on every sync, so "has items" is a plain column
    // test rather than probing for the existence of items[0].
    const where = { itemCount: { gt: 0 } };

    if (search) {
        // The customer is matched through the relation instead of pre-resolving
        // up to 200 ids and hoping the real match falls inside that slice.
        where.OR = [
            { restaurantName: { contains: search, mode: 'insensitive' } },
            { restaurantId: { contains: search, mode: 'insensitive' } },
            { user: { name: { contains: search, mode: 'insensitive' } } },
            { user: { phone: { contains: search, mode: 'insensitive' } } },
            { user: { email: { contains: search, mode: 'insensitive' } } },
        ];
    }

    const [carts, total] = await Promise.all([
        prisma.foodUserCart.findMany({
            where,
            include: { user: { select: { id: true, name: true, phone: true, email: true, profileImage: true } } },
            orderBy: { updatedAt: 'desc' },
            skip,
            take: limit,
        }),
        prisma.foodUserCart.count({ where }),
    ]);

    const normalized = await Promise.all(
        carts.map(async (cart) => {
            const user = cart.user || null;
            let pricing = cart.pricing || null;
            if (pricing) {
                pricing = normalizePricingSnapshot(pricing);
            }
            if (pricing && Number(pricing.deliveryFee) === 0) {
                pricing = normalizePricingSnapshot(await enrichStoredCartPricing(cart, pricing));
            }

            return {
                id: cart.id,
                userId: user?.id || cart.userId || '',
                userName: user?.name || 'Unknown user',
                userPhone: user?.phone || '',
                userEmail: user?.email || '',
                userImage: user?.profileImage || '',
                restaurantId: cart.restaurantId || '',
                restaurantName: cart.restaurantName || '',
                items: Array.isArray(cart.items) ? cart.items : [],
                itemCount: Number(cart.itemCount) || 0,
                subtotal: Number(cart.subtotal) || 0,
                pricing,
                updatedAt: cart.updatedAt,
                createdAt: cart.createdAt,
            };
        }),
    );

    return {
        carts: normalized,
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
    };
}

export async function getUserCartPricingForAdmin(cartId) {
    if (!isId(cartId)) throw new ValidationError('Invalid cart id');

    const cart = await prisma.foodUserCart.findUnique({ where: { id: String(cartId) } });
    if (!cart || !Array.isArray(cart.items) || cart.items.length === 0) {
        throw new NotFoundError('Cart not found');
    }

    if (cart.pricing && Number(cart.pricing.total) > 0) {
        const enriched = await enrichStoredCartPricing(cart, cart.pricing);
        return normalizePricingSnapshot(enriched) || enriched;
    }

    if (!isId(cart.restaurantId)) {
        const subtotal = Number(cart.subtotal) || 0;
        return {
            subtotal,
            tax: 0,
            packagingFee: 0,
            deliveryFee: 0,
            platformFee: 0,
            discount: 0,
            total: subtotal,
            savings: 0,
            couponCode: '',
            deliveryFeeBreakdown: null,
            appliedCoupon: null,
        };
    }

    const result = await calculateOrderPricing(
        cart.userId,
        {
            restaurantId: cart.restaurantId,
            items: mapCartItemsForPricing(cart.items),
            couponCode: cart.pricing?.couponCode || undefined,
            deliveryMode: cart.pricing?.deliveryMode === 'quick' ? 'quick' : 'basic',
        },
        { skipAvailabilityCheck: true },
    );

    const recalc = result?.pricing || null;
    if (!recalc) return null;

    const deliveryMode = cart.pricing?.deliveryMode === 'quick' ? 'quick' : 'basic';
    const quickDeliveryFee =
        deliveryMode === 'quick'
            ? toNonNegativeNumber(recalc.quickDeliveryFee, 0)
            : 0;

    return {
        ...recalc,
        quickDeliveryFee,
        deliveryMode,
        couponCode: cart.pricing?.couponCode || recalc.couponCode || '',
        appliedCoupon: recalc.appliedCoupon || cart.pricing?.appliedCoupon || null,
    };
}
