/**
 * Which restaurants the admin Restaurants list (and the dashboard's Restaurants
 * card) counts.
 *
 * The old panel listed every store whose owner was approved, with an on/off
 * switch beside it; switching a store off kept it in the list. Here that switch
 * writes status 'rejected' with the reason below (updateRestaurantStatus, and the
 * legacy importer for stores the old admin had switched off), so the list is the
 * approved restaurants plus those switched off. Join requests -- pending, or
 * rejected with a reason of their own -- stay on Joining Request.
 *
 * Customer-facing reads never use this: they keep to status 'approved'.
 */

/** The reason the admin's on/off switch writes when it turns a restaurant off. */
export const DISABLED_BY_ADMIN = 'Disabled by admin';

/** Approved, or switched off by an admin. */
export const LISTED_RESTAURANT_WHERE = Object.freeze({
    OR: [
        { status: 'approved' },
        { status: 'rejected', rejectionReason: DISABLED_BY_ADMIN },
    ],
});

/** The admin list's `status` query value for the old panel's list. */
export const LISTED_STATUS = 'listed';

/**
 * The where clause for the admin restaurant list's `status` query, or null for
 * no status filter. 'listed' is the Restaurants page; the plain statuses are
 * kept for the other screens that ask for one.
 */
export function restaurantStatusWhere(status) {
    if (status === LISTED_STATUS) return LISTED_RESTAURANT_WHERE;
    if (['pending', 'approved', 'rejected'].includes(status)) return { status };
    return null;
}

/** Is this restaurant one the admin switched off (rather than a rejected join request)? */
export const isDisabledByAdmin = (restaurant) =>
    restaurant?.status === 'rejected' && restaurant?.rejectionReason === DISABLED_BY_ADMIN;
