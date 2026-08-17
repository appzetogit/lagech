import { prisma } from '../../../../config/prisma.js';
import { notifyOwnerSafely, notifyAdminsSafely } from '../../../../core/notifications/firebase.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;

const toDateLabel = (value) => {
    const date = value ? new Date(value) : null;
    if (!date || Number.isNaN(date.getTime())) return 'N/A';
    return date.toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        year: 'numeric'
    });
};

const startOfToday = () => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), now.getDate());
};

const nextDay = (date) => new Date(date.getTime() + DAY_MS);

const buildAdminSummary = (restaurant) => {
    const expiryDate = restaurant.fssaiExpiry ? new Date(restaurant.fssaiExpiry) : null;
    const expiryLabel = toDateLabel(expiryDate);
    const restaurantName = restaurant.restaurantName || 'Restaurant';
    return {
        id: `fssai-expired-${restaurant.id}`,
        restaurantId: restaurant.id,
        restaurantName,
        ownerName: restaurant.ownerName || '',
        ownerPhone: restaurant.ownerPhone || '',
        fssaiNumber: restaurant.fssaiNumber || '',
        fssaiExpiry: expiryDate ? expiryDate.toISOString() : null,
        expiryLabel,
        title: 'FSSAI License Expired',
        message: `${restaurantName} FSSAI expired on ${expiryLabel}. Owner: ${restaurant.ownerName || 'N/A'}.`,
        createdAt: expiryDate
            ? expiryDate.toISOString()
            : restaurant.updatedAt || restaurant.createdAt || new Date().toISOString(),
        path: '/admin/food/restaurants'
    };
};

export const listExpiredFssaiRestaurants = async () => {
    // Anything dated before tomorrow has expired: a licence that runs out today
    // is not valid tomorrow, and the column carries no time of day.
    const restaurants = await prisma.foodRestaurant.findMany({
        where: { status: 'approved', fssaiExpiry: { lt: nextDay(startOfToday()) } },
        select: {
            id: true,
            restaurantName: true,
            ownerName: true,
            ownerPhone: true,
            fssaiNumber: true,
            fssaiExpiry: true,
            createdAt: true,
            updatedAt: true,
        },
        orderBy: [{ fssaiExpiry: 'desc' }, { updatedAt: 'desc' }],
    });

    return restaurants.filter((r) => r.fssaiExpiry).map(buildAdminSummary);
};

export const syncExpiredFssaiNotifications = async () => {
    const restaurants = await listExpiredFssaiRestaurants();
    if (!restaurants.length) return { totalExpired: 0, createdCount: 0 };

    // One read for the whole batch. The old code asked per restaurant, so a
    // hundred expired licences meant a hundred round trips before any work.
    const alreadySent = await prisma.foodNotification.findMany({
        where: {
            ownerType: 'RESTAURANT',
            source: 'FSSAI_EXPIRY',
            ownerId: { in: restaurants.map((r) => r.restaurantId) },
        },
        select: { ownerId: true, metadata: true },
    });

    // Keyed by expiry too: a renewed-then-expired-again licence is a new alert,
    // but the same expiry date must never be announced twice.
    const seen = new Set(
        alreadySent.map((n) => `${n.ownerId}|${n.metadata?.expiryDate || ''}`)
    );

    let createdCount = 0;

    for (const summary of restaurants) {
        const { restaurantId, fssaiExpiry: expiryIso } = summary;
        if (!restaurantId || !expiryIso) continue;
        if (seen.has(`${restaurantId}|${expiryIso}`)) continue;

        const message = `${summary.restaurantName} FSSAI license expired on ${summary.expiryLabel}.`
            + ` Owner: ${summary.ownerName || 'Restaurant owner'}.`
            + ` FSSAI No: ${summary.fssaiNumber || 'N/A'}.`;

        // ponytail: check-then-insert. Safe because this runs from a single
        // scheduled job; a unique index on (ownerId, source, expiry) is the fix
        // if it ever runs concurrently.
        await prisma.foodNotification.create({
            data: {
                ownerType: 'RESTAURANT',
                ownerId: restaurantId,
                title: 'FSSAI License Expired',
                message,
                link: '/restaurant/fssai',
                category: 'compliance',
                source: 'FSSAI_EXPIRY',
                metadata: {
                    restaurantId,
                    restaurantName: summary.restaurantName,
                    ownerName: summary.ownerName,
                    ownerPhone: summary.ownerPhone,
                    fssaiNumber: summary.fssaiNumber,
                    expiryDate: expiryIso,
                },
            },
        });
        seen.add(`${restaurantId}|${expiryIso}`);

        const data = {
            restaurantId,
            expiryDate: expiryIso,
            fssaiNumber: summary.fssaiNumber || '',
        };

        await notifyOwnerSafely(
            { ownerType: 'RESTAURANT', ownerId: restaurantId },
            { title: 'FSSAI License Expired', body: message, data: { type: 'fssai_expired', ...data } }
        );

        await notifyAdminsSafely({
            title: 'Restaurant FSSAI Expired',
            body: summary.message,
            data: { type: 'restaurant_fssai_expired', ...data },
        });

        createdCount += 1;
    }

    return { totalExpired: restaurants.length, createdCount };
};
