import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { notifyOwnersSafely } from '../../../../core/notifications/firebase.service.js';
import { fromFoodTypeColumn } from '../../shared/foodType.util.js';
import { dropMenuCache } from '../../shared/menuCache.util.js';
import {
    getFoodDisplayOtherPrice,
    getFoodDisplayPrice,
    serializeFoodVariants,
} from './foodVariant.service.js';

/**
 * The admin approval queue: dishes and add-ons a restaurant has submitted.
 *
 * Both kinds are rendered in one table, so they are merged into a single shape
 * with an `entityType` discriminator.
 */

const FALLBACK_IMAGE = 'https://i.ibb.co/5GzXz7r/Switcheats-Brand-Image.png';

/** The short id the approval table shows instead of the full 24 characters. */
const toRestaurantDisplayId = (id) => {
    const s = String(id || '');
    return s.length >= 5 ? s.slice(-5) : s;
};

export async function listPendingFoodApprovals(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 200, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const foodWhere = { approvalStatus: 'pending' };
    if (isId(query.restaurantId)) foodWhere.restaurantId = String(query.restaurantId);
    if (query.search && String(query.search).trim()) {
        const contains = { contains: String(query.search).trim().slice(0, 80), mode: 'insensitive' };
        foodWhere.OR = [{ name: contains }, { categoryName: contains }];
    }

    const addonWhere = { approvalStatus: 'pending', isDeleted: false };
    const order = [{ requestedAt: 'desc' }, { createdAt: 'desc' }];

    // ponytail: the two queues are paginated independently and merged in
    // memory, so page 2 onward is approximate. A UNION view over both tables is
    // the fix if the queue ever grows past a screenful.
    const [foodList, foodTotal, addonList, addonTotal] = await Promise.all([
        prisma.foodItem.findMany({
            where: foodWhere,
            orderBy: order,
            skip,
            take: limit,
            select: {
                id: true, restaurantId: true, categoryName: true, name: true,
                image: true, foodType: true, approvalStatus: true,
                requestedAt: true, createdAt: true,
                price: true, otherPrice: true,
                variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] },
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodItem.count({ where: foodWhere }),
        prisma.foodAddon.findMany({
            where: addonWhere,
            orderBy: order,
            skip,
            take: limit,
            select: {
                id: true, restaurantId: true, draft: true, isAvailable: true,
                requestedAt: true, createdAt: true,
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodAddon.count({ where: addonWhere }),
    ]);

    const foodRequests = foodList.map((f) => ({
        _id: f.id,
        id: f.id,
        entityType: 'food',
        type: 'food',
        restaurantName: f.restaurant?.restaurantName || 'Unknown Restaurant',
        restaurantId: toRestaurantDisplayId(f.restaurantId),
        category: f.categoryName || '',
        itemName: f.name,
        foodType: fromFoodTypeColumn(f.foodType),
        sectionName: f.categoryName || '',
        subsectionName: '',
        approvalStatus: f.approvalStatus,
        price: getFoodDisplayPrice(f),
        otherPrice: getFoodDisplayOtherPrice(f),
        variants: serializeFoodVariants(f.variants),
        image: f.image || '',
        images: f.image ? [f.image] : [],
        requestedAt: f.requestedAt || f.createdAt,
        isActionable: f.approvalStatus === 'pending',
    }));

    const addonRequests = addonList.map((a) => {
        // The editable copy is a Json column, so everything below is untyped.
        const draft = a.draft || {};
        const images = Array.isArray(draft.images) ? draft.images : [];
        return {
            _id: a.id,
            id: a.id,
            entityType: 'addon',
            type: 'addon',
            restaurantName: a.restaurant?.restaurantName || 'Unknown Restaurant',
            restaurantId: toRestaurantDisplayId(a.restaurantId),
            category: 'Add-on',
            itemName: draft.name || 'Unnamed Add-on',
            foodType: 'Add-on',
            sectionName: 'Add-on',
            subsectionName: '',
            approvalStatus: 'pending',
            price: draft.price ?? 0,
            image: draft.image || images[0] || '',
            images: images.length ? images : (draft.image ? [draft.image] : []),
            requestedAt: a.requestedAt || a.createdAt,
            isActionable: true,
            description: draft.description || '',
        };
    });

    const requests = [...foodRequests, ...addonRequests]
        .sort((a, b) => new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime())
        .slice(0, limit);

    // The old code reported the merged page length here, so the table believed
    // there was never a second page.
    return { requests, page, limit, total: foodTotal + addonTotal };
}

/**
 * Approve or reject one dish.
 *
 * The status is part of the filter, not just the update, so two admins clicking
 * at once cannot both act on the same dish — the loser matches nothing.
 */
const decideFoodItem = async (id, decision, reason = '') => {
    if (!isId(id)) throw new ValidationError('Invalid food id');

    const approved = decision === 'approved';
    const now = new Date();

    const { count } = await prisma.foodItem.updateMany({
        where: { id: String(id), approvalStatus: 'pending' },
        data: approved
            ? { approvalStatus: 'approved', approvedAt: now, rejectedAt: null, rejectionReason: '' }
            : { approvalStatus: 'rejected', rejectedAt: now, approvedAt: null, rejectionReason: reason },
    });
    if (!count) return null;

    const food = await prisma.foodItem.findUnique({ where: { id: String(id) } });
    if (!food) return null;

    await dropMenuCache(food.restaurantId);

    await notifyOwnersSafely(
        [{ ownerType: 'RESTAURANT', ownerId: food.restaurantId }],
        {
            title: approved ? 'Dish Approved! 🍲' : 'Dish Rejected ❌',
            body: approved
                ? `Your dish "${food.name}" has been approved and is now visible to customers.`
                : `Your dish "${food.name}" was rejected. Reason: ${reason}`,
            image: food.image || FALLBACK_IMAGE,
            data: {
                type: approved ? 'food_approved' : 'food_rejected',
                foodId: food.id,
                restaurantId: food.restaurantId,
                ...(approved ? {} : { reason }),
            },
        }
    ).catch((err) => console.error('Failed to send food approval notification:', err));

    return food;
};

export const approveFoodItem = (id) => decideFoodItem(id, 'approved');

export async function rejectFoodItem(id, reason) {
    if (!isId(id)) throw new ValidationError('Invalid food id');

    const trimmed = typeof reason === 'string' ? reason.trim() : '';
    if (!trimmed) throw new ValidationError('Rejection reason is required');
    if (trimmed.length > 500) throw new ValidationError('Rejection reason is too long');

    return decideFoodItem(id, 'rejected', trimmed);
}
