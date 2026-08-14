import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { toRestaurant } from '../../restaurant/restaurant.mapper.js';
import { getRestaurantMenu } from '../../restaurant/services/restaurantMenu.service.js';

/**
 * The admin restaurant directory, extracted from admin.service.js.
 *
 * Read paths only — approval, status and deletion live in
 * adminRestaurantLifecycle.service.js.
 */

const RESTAURANT_ROW = {
    id: true, restaurantName: true, restaurantNameNormalized: true,
    area: true, city: true, state: true, pincode: true, landmark: true,
    addressLine1: true, addressLine2: true, formattedAddress: true,
    latitude: true, longitude: true,
    status: true, ownerName: true, ownerPhone: true, primaryContactNumber: true,
    zoneId: true, profileImage: true, coverImages: true, menuImages: true,
    rating: true, totalRatings: true, createdAt: true,
};

const ZONE_SUMMARY = { select: { id: true, name: true, zoneName: true } };

/**
 * "Active" means approved.
 *
 * FoodRestaurant has no isActive column and never did — Mongo documents simply
 * lacked the field, so `isActive: { $ne: false }` matched every restaurant and
 * `isActive: false` matched none. The filter and the active/inactive counts on
 * the admin dashboard were therefore meaningless: both counts equalled the
 * total.
 *
 * updateRestaurantStatus already treats the same flag as approved/rejected, so
 * that is the mapping used here.
 */
const activeFilter = (raw) => {
    if (raw === 'true' || raw === true) return { status: 'approved' };
    if (raw === 'false' || raw === false) return { status: { not: 'approved' } };
    return null;
};

export async function getRestaurants(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const status = query.status;
    const search = String(query.search || '').trim().slice(0, 80);
    const sortBy = String(query.sortBy || 'created-desc').trim();
    const includeStats = query.includeStats === 'true' || query.includeStats === true;

    const where = {};
    if (['pending', 'approved', 'rejected'].includes(status)) where.status = status;

    if (search) {
        const contains = { contains: search, mode: 'insensitive' };
        const or = [
            { restaurantName: contains },
            { ownerName: contains },
            { ownerEmail: contains },
            { ownerPhone: contains },
            { primaryContactNumber: contains },
        ];

        const normalized = search.toLowerCase().replace(/\s+/g, ' ');
        if (normalized.length >= 2) {
            or.push({ restaurantNameNormalized: { contains: normalized, mode: 'insensitive' } });
        }

        // A partial phone is matched against the digits-only columns, so a
        // number typed with spaces or a +91 still finds the restaurant.
        const phoneDigits = search.replace(/\D/g, '');
        if (phoneDigits.length >= 4) {
            or.push({ ownerPhoneLast10: { contains: phoneDigits } });
            or.push({ ownerPhoneDigits: { contains: phoneDigits } });
        }

        where.OR = or;
    }

    const active = activeFilter(query.isActive);
    if (active) Object.assign(where, active);

    const orderBy = {
        'created-desc': { createdAt: 'desc' },
        'created-asc': { createdAt: 'asc' },
        'name-asc': { restaurantName: 'asc' },
        'name-desc': { restaurantName: 'desc' },
        'owner-asc': { ownerName: 'asc' },
        'owner-desc': { ownerName: 'desc' },
        'rating-asc': { rating: 'asc' },
        'rating-desc': { rating: 'desc' },
        // 'active' is the approval status, per activeFilter above.
        'active-asc': { status: 'asc' },
        'active-desc': { status: 'desc' },
    }[sortBy] || { createdAt: 'desc' };

    const [rows, total] = await Promise.all([
        prisma.foodRestaurant.findMany({
            where,
            orderBy,
            skip,
            take: limit,
            select: { ...RESTAURANT_ROW, zone: ZONE_SUMMARY },
        }),
        prisma.foodRestaurant.count({ where }),
    ]);

    const result = {
        // The nested `location` the admin tables read is rebuilt from the flat
        // columns.
        restaurants: rows.map(toRestaurant),
        total,
        page,
        limit,
    };

    if (includeStats) {
        // Scoped to the status filter, but not to the search — the header
        // counts describe the whole set the admin is filtering within.
        const statsWhere = ['pending', 'approved', 'rejected'].includes(status) ? { status } : {};

        const [statsTotal, statsActive] = await Promise.all([
            prisma.foodRestaurant.count({ where: statsWhere }),
            // AND, not a spread: statsWhere may already constrain `status`, and
            // spreading would let the second key silently replace the filter —
            // counting every approved restaurant while the admin is looking at
            // the pending ones.
            prisma.foodRestaurant.count({
                where: { AND: [statsWhere, { status: 'approved' }] },
            }),
        ]);

        result.stats = {
            total: statsTotal,
            active: statsActive,
            // Previously both of these equalled the total, because the column
            // they counted on did not exist.
            inactive: statsTotal - statsActive,
        };
    }

    return result;
}

export async function getRestaurantById(id) {
    if (!isId(id)) return null;

    const doc = await prisma.foodRestaurant.findUnique({
        where: { id: String(id) },
        include: {
            zone: { select: { id: true, name: true, zoneName: true, serviceLocation: true, isActive: true } },
        },
    });
    return doc ? toRestaurant(doc) : null;
}

/**
 * The menu an admin sees for a restaurant.
 *
 * Mongo kept a `menu` snapshot on the restaurant document that had to be kept
 * in step with food_items by hand. Menus are generated from the dishes now —
 * one source of truth — so this reads through the same builder the restaurant's
 * own menu endpoint uses.
 */
export async function getRestaurantMenuById(id) {
    if (!isId(id)) return null;
    return getRestaurantMenu(String(id));
}

export async function updateRestaurantMenuById() {
    // Matches restaurantMenu.service.js: the layout is derived, so there is
    // nothing to save. Kept so the existing route answers clearly instead of
    // silently writing to a column that no longer exists.
    throw new ValidationError('Menu editing is disabled. Menu is generated from food items.');
}
