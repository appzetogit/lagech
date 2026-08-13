import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { getPublicGourmetRestaurants } from '../services/gourmet.service.js';

/** The shape the admin grid renders each row from. */
const toAdminRow = (entry, restaurant) => ({
    _id: entry.id,
    restaurantId: entry.restaurantId,
    priority: entry.priority,
    order: entry.priority,
    isActive: entry.isActive,
    restaurant: restaurant
        ? {
            _id: restaurant.id || restaurant._id,
            name: restaurant.name || restaurant.restaurantName,
            rating: restaurant.rating || 0,
            profileImage: restaurant.profileImage?.url
                ? restaurant.profileImage
                : restaurant.profileImage ? { url: restaurant.profileImage } : null,
            area: restaurant.area,
            city: restaurant.city,
        }
        : null,
});

/** GET /hero-banners/gourmet — every entry, including inactive ones. */
export const listGourmetAdmin = async (req, res, next) => {
    try {
        // restaurantId is a foreign key now, so the hydration the Mongo version
        // did with a second query and a Map is just an include.
        const entries = await prisma.foodGourmetRestaurant.findMany({
            orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
            include: {
                restaurant: {
                    select: {
                        id: true, restaurantName: true, area: true,
                        city: true, profileImage: true, rating: true,
                    },
                },
            },
        });

        res.status(200).json({
            success: true,
            message: 'Gourmet restaurants fetched',
            data: { restaurants: entries.map((e) => toAdminRow(e, e.restaurant)) },
        });
    } catch (error) {
        next(error);
    }
};

/** POST /hero-banners/gourmet — body: { restaurantId } */
export const createGourmetAdmin = async (req, res, next) => {
    try {
        const { restaurantId } = req.body || {};
        if (!isId(restaurantId)) {
            return res.status(400).json({ success: false, message: 'restaurantId is required' });
        }

        // The foreign key makes an unknown restaurant a 500 otherwise; check for
        // it and answer properly.
        const exists = await prisma.foodRestaurant.count({ where: { id: String(restaurantId) } });
        if (!exists) {
            return res.status(404).json({ success: false, message: 'Restaurant not found' });
        }

        const already = await prisma.foodGourmetRestaurant.count({
            where: { restaurantId: String(restaurantId) },
        });
        if (already) {
            return res.status(400).json({ success: false, message: 'Restaurant already in Gourmet' });
        }
        // ponytail: check-then-insert, so two admins adding the same restaurant
        // at once get two rows. A @@unique on restaurantId is the real fix, and
        // needs a migration.

        const item = await prisma.foodGourmetRestaurant.create({
            data: {
                restaurantId: String(restaurantId),
                priority: await prisma.foodGourmetRestaurant.count(),
            },
        });

        const list = await getPublicGourmetRestaurants();
        res.status(201).json({
            success: true,
            message: 'Restaurant added to Gourmet',
            data: {
                restaurants: list.map((entry) => toAdminRow(entry, entry.restaurant)),
                item,
            },
        });
    } catch (error) {
        next(error);
    }
};

/** DELETE /hero-banners/gourmet/:id */
export const deleteGourmetAdmin = async (req, res, next) => {
    try {
        const { id } = req.params;
        const { count } = await prisma.foodGourmetRestaurant.deleteMany({ where: { id } });
        if (!count) {
            return res.status(404).json({ success: false, message: 'Gourmet entry not found' });
        }
        res.status(200).json({ success: true, message: 'Restaurant removed from Gourmet', data: { id } });
    } catch (error) {
        next(error);
    }
};

/** PATCH /hero-banners/gourmet/:id/order — body: { order } */
export const updateGourmetOrderAdmin = async (req, res, next) => {
    try {
        const { id } = req.params;
        const order = parseInt(req.body?.order, 10);
        if (Number.isNaN(order)) {
            return res.status(400).json({ success: false, message: 'order must be a number' });
        }

        const { count } = await prisma.foodGourmetRestaurant.updateMany({
            where: { id },
            data: { priority: order },
        });
        if (!count) {
            return res.status(404).json({ success: false, message: 'Gourmet entry not found' });
        }

        const doc = await prisma.foodGourmetRestaurant.findUnique({ where: { id } });
        res.status(200).json({ success: true, message: 'Order updated', data: doc });
    } catch (error) {
        next(error);
    }
};

/** PATCH /hero-banners/gourmet/:id/status — toggle isActive */
export const toggleGourmetStatusAdmin = async (req, res, next) => {
    try {
        const { id } = req.params;
        const current = await prisma.foodGourmetRestaurant.findUnique({
            where: { id },
            select: { isActive: true },
        });
        if (!current) {
            return res.status(404).json({ success: false, message: 'Gourmet entry not found' });
        }

        const doc = await prisma.foodGourmetRestaurant.update({
            where: { id },
            data: { isActive: !current.isActive },
        });
        res.status(200).json({
            success: true,
            message: doc.isActive ? 'Activated' : 'Deactivated',
            data: doc,
        });
    } catch (error) {
        next(error);
    }
};
