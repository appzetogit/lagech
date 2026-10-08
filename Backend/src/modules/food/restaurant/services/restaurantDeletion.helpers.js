/**
 * What survives a restaurant being deleted (by itself or by the admin).
 *
 * Support tickets and feedback are the admin's history, not the restaurant's
 * property, so they are detached rather than erased: restaurantId goes to null
 * and restaurant tickets keep the name they were raised under.
 *
 * Runs inside the deleting transaction, before the restaurant row goes.
 */
export async function detachRestaurantHistory(tx, restaurant) {
    const id = String(restaurant.id);
    const name = String(restaurant.restaurantName || '');

    // Tickets raised before restaurantName existed have it blank.
    await tx.foodRestaurantSupportTicket.updateMany({
        where: { restaurantId: id, restaurantName: '' },
        data: { restaurantName: name },
    });
    await tx.foodRestaurantSupportTicket.updateMany({
        where: { restaurantId: id },
        data: { restaurantId: null },
    });
    // Customer tickets and feedback about the restaurant stay, unlinked.
    await tx.foodSupportTicket.updateMany({ where: { restaurantId: id }, data: { restaurantId: null } });
    await tx.feedbackExperience.updateMany({ where: { restaurantId: id }, data: { restaurantId: null } });
}
