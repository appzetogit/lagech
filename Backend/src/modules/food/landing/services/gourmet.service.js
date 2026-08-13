import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { toRestaurantLocation } from '../../restaurant/restaurant.mapper.js';

/**
 * The curated "gourmet" rail.
 *
 * Mongo fetched the entries, collected their restaurantIds and ran a second
 * query to hydrate them. `restaurantId` is a real foreign key now, so one
 * query with an include does it.
 *
 * An entry whose restaurant is unapproved, or outside the requested zone,
 * still comes back with `restaurant: null` rather than being dropped — the
 * admin screen lists the curation itself and needs to show the gaps.
 */
export const getPublicGourmetRestaurants = async (zoneId) => {
    const entries = await prisma.foodGourmetRestaurant.findMany({
        where: { isActive: true },
        orderBy: [{ priority: 'asc' }, { createdAt: 'desc' }],
        include: {
            restaurant: {
                select: {
                    id: true, restaurantName: true, area: true, city: true,
                    profileImage: true, rating: true, cuisines: true, slug: true,
                    pureVegRestaurant: true, estimatedDeliveryTime: true, zoneId: true,
                    status: true,
                    // toRestaurantLocation rebuilds the nested `location` the
                    // clients read; these are the columns it needs.
                    latitude: true, longitude: true, formattedAddress: true,
                    addressLine1: true, addressLine2: true, state: true,
                    pincode: true, landmark: true,
                },
            },
        },
    });

    const wantedZone = isId(zoneId) ? String(zoneId) : null;

    return entries.map((entry) => {
        const r = entry.restaurant;
        const visible = r?.status === 'approved' && (!wantedZone || r.zoneId === wantedZone);

        return {
            ...entry,
            restaurant: visible
                ? {
                    _id: r.id,
                    name: r.restaurantName,
                    restaurantName: r.restaurantName,
                    rating: r.rating || 0,
                    profileImage: r.profileImage ? { url: r.profileImage } : null,
                    area: r.area,
                    city: r.city,
                    cuisines: r.cuisines || [],
                    slug: r.slug,
                    pureVegRestaurant: r.pureVegRestaurant,
                    location: toRestaurantLocation(r),
                    estimatedDeliveryTime: r.estimatedDeliveryTime,
                    zoneId: r.zoneId,
                }
                : null,
        };
    });
};
