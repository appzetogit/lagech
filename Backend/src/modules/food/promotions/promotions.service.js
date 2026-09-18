import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';
import { ValidationError } from '../../../core/auth/errors.js';

/**
 * Restaurant advertisements and reels.
 *
 * An advertisement promotes one restaurant, as a card (cover image and logo)
 * or a video. A restaurant asks for one and it waits for the admin; an admin
 * can also place one directly. What customers see is decided from the stored
 * status and the dates together:
 *
 *   pending  -> waiting for the admin
 *   denied   -> refused (with a note)
 *   paused   -> approved but held back
 *   approved -> "scheduled" before its start, "running" between its dates,
 *               "expired" after its end
 *
 * Reels are short restaurant videos: always visible, or only between dates.
 */

const AD_TYPES = ['restaurant', 'video'];
const AD_DECISIONS = ['approved', 'denied', 'paused'];

const text = (value, max, label) => {
    const out = String(value ?? '').trim();
    if (out.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer`);
    return out;
};

const date = (value, label) => {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) throw new ValidationError(`${label} is required`);
    return d;
};

const url = (value) => {
    const out = String(value ?? '').trim();
    if (out && !/^(https?:\/\/|\/uploads\/)/.test(out)) throw new ValidationError('Media must be an uploaded file');
    return out;
};

/** What the ad is doing right now, from its status and dates. */
export function adState(ad, now = new Date()) {
    if (ad.status !== 'approved') return ad.status;
    if (new Date(ad.endDate) < now) return 'expired';
    if (new Date(ad.startDate) > now) return 'scheduled';
    return 'running';
}

const RESTAURANT_CARD = {
    select: { id: true, restaurantName: true, profileImage: true, coverImage: true, rating: true, totalRatings: true, area: true, city: true },
};

const serializeAd = (ad) => ({
    ...ad,
    state: adState(ad),
    restaurantName: ad.restaurant?.restaurantName || '',
});

/** Validated fields for an ad from a form, full or partial. */
function adData(body = {}, { partial = false } = {}) {
    const data = {};
    if (!partial || body.type !== undefined) {
        const type = String(body.type || 'restaurant');
        if (!AD_TYPES.includes(type)) throw new ValidationError('Type must be restaurant or video');
        data.type = type;
    }
    if (!partial || body.title !== undefined) {
        data.title = text(body.title, 120, 'Title');
        if (!data.title) throw new ValidationError('Title is required');
    }
    if (body.description !== undefined) data.description = text(body.description, 500, 'Description');
    if (body.coverImage !== undefined) data.coverImage = url(body.coverImage);
    if (body.logoImage !== undefined) data.logoImage = url(body.logoImage);
    if (body.videoUrl !== undefined) data.videoUrl = url(body.videoUrl);
    if (!partial || body.startDate !== undefined) data.startDate = date(body.startDate, 'Start date');
    if (!partial || body.endDate !== undefined) data.endDate = date(body.endDate, 'End date');
    if (data.startDate && data.endDate) {
        data.endDate.setHours(23, 59, 59, 999);
        if (data.endDate < data.startDate) throw new ValidationError('End date must be on or after the start date');
    }
    if (body.priority !== undefined) {
        const p = body.priority === '' || body.priority === null ? null : Number(body.priority);
        if (p !== null && (!Number.isInteger(p) || p < 0)) throw new ValidationError('Priority must be a whole number');
        data.priority = p;
    }
    if (body.showRating !== undefined) data.showRating = Boolean(body.showRating);
    if (body.showReviews !== undefined) data.showReviews = Boolean(body.showReviews);
    return data;
}

const requireMedia = (ad) => {
    if (ad.type === 'video' && !ad.videoUrl) throw new ValidationError('A video ad needs a video');
    if (ad.type === 'restaurant' && !ad.coverImage) throw new ValidationError('A restaurant ad needs a cover image');
};

// ─── admin ───────────────────────────────────────────────────────────────────

export async function listAdsAdmin(query = {}) {
    const where = {};
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    const rows = await prisma.foodAdvertisement.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        include: { restaurant: RESTAURANT_CARD },
    });
    const ads = rows.map(serializeAd);
    const state = String(query.state || 'all');
    const counts = ads.reduce((acc, ad) => ({ ...acc, [ad.state]: (acc[ad.state] || 0) + 1 }), {});
    return { ads: state === 'all' ? ads : ads.filter((ad) => ad.state === state), counts };
}

/** An admin placing an ad directly: approved from the start. */
export async function createAdAdmin(body = {}) {
    if (!isId(body.restaurantId)) throw new ValidationError('Choose a restaurant');
    const data = adData(body);
    requireMedia(data);
    const ad = await prisma.foodAdvertisement.create({
        data: { ...data, restaurantId: String(body.restaurantId), status: 'approved', createdBy: 'admin' },
        include: { restaurant: RESTAURANT_CARD },
    });
    return serializeAd(ad);
}

export async function updateAdAdmin(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid advertisement');
    const existing = await prisma.foodAdvertisement.findUnique({ where: { id: String(id) } });
    if (!existing) throw new ValidationError('Advertisement not found');
    const data = adData(body, { partial: true });
    requireMedia({ ...existing, ...data });
    const ad = await prisma.foodAdvertisement.update({ where: { id: existing.id }, data, include: { restaurant: RESTAURANT_CARD } });
    return serializeAd(ad);
}

/** Approve, deny or pause; resuming a paused ad is approving it again. */
export async function decideAd(id, { status, note } = {}) {
    if (!isId(id)) throw new ValidationError('Invalid advertisement');
    if (!AD_DECISIONS.includes(status)) throw new ValidationError('Status must be approved, denied or paused');
    const cleanNote = text(note, 300, 'Note');
    if (status !== 'approved' && !cleanNote) throw new ValidationError('Say why, so the restaurant knows');
    const ad = await prisma.foodAdvertisement
        .update({ where: { id: String(id) }, data: { status, note: status === 'approved' ? '' : cleanNote }, include: { restaurant: RESTAURANT_CARD } })
        .catch(() => {
            throw new ValidationError('Advertisement not found');
        });
    return serializeAd(ad);
}

export async function deleteAd(id) {
    if (!isId(id)) throw new ValidationError('Invalid advertisement');
    const { count } = await prisma.foodAdvertisement.deleteMany({ where: { id: String(id) } });
    if (!count) throw new ValidationError('Advertisement not found');
    return { deleted: true };
}

// ─── restaurant ──────────────────────────────────────────────────────────────

export async function listAdsForRestaurant(restaurantId) {
    const rows = await prisma.foodAdvertisement.findMany({ where: { restaurantId: String(restaurantId) }, orderBy: { createdAt: 'desc' } });
    return rows.map(serializeAd);
}

/** A restaurant asking for an ad: it waits for the admin. */
export async function requestAd(restaurantId, body = {}) {
    const data = adData(body);
    requireMedia(data);
    delete data.priority; // the admin sets the order
    const ad = await prisma.foodAdvertisement.create({
        data: { ...data, restaurantId: String(restaurantId), status: 'pending', createdBy: 'restaurant' },
    });
    return serializeAd(ad);
}

/** A restaurant withdrawing a request the admin has not decided yet. */
export async function withdrawAdRequest(restaurantId, id) {
    if (!isId(id)) throw new ValidationError('Invalid advertisement');
    const { count } = await prisma.foodAdvertisement.deleteMany({
        where: { id: String(id), restaurantId: String(restaurantId), status: 'pending' },
    });
    if (!count) throw new ValidationError('Only a request still waiting for approval can be withdrawn');
    return { deleted: true };
}

// ─── public ──────────────────────────────────────────────────────────────────

/** Running ads for the customer app, best priority first. */
export async function listRunningAds() {
    const now = new Date();
    const rows = await prisma.foodAdvertisement.findMany({
        where: {
            status: 'approved',
            startDate: { lte: now },
            endDate: { gte: now },
            restaurant: { status: 'approved' },
        },
        orderBy: [{ priority: { sort: 'asc', nulls: 'last' } }, { createdAt: 'desc' }],
        include: { restaurant: RESTAURANT_CARD },
        take: 50,
    });
    return rows.map((ad) => ({
        id: ad.id,
        type: ad.type,
        title: ad.title,
        description: ad.description,
        coverImage: ad.coverImage || ad.restaurant?.coverImage || '',
        logoImage: ad.logoImage || ad.restaurant?.profileImage || '',
        videoUrl: ad.videoUrl,
        restaurant: {
            id: ad.restaurant.id,
            name: ad.restaurant.restaurantName,
            area: ad.restaurant.area || ad.restaurant.city || '',
            ...(ad.showRating ? { rating: Number(ad.restaurant.rating) } : {}),
            ...(ad.showReviews ? { totalRatings: ad.restaurant.totalRatings } : {}),
        },
    }));
}

// ─── reels ───────────────────────────────────────────────────────────────────

function reelData(body = {}, { partial = false } = {}) {
    const data = {};
    if (!partial || body.restaurantId !== undefined) {
        if (!isId(body.restaurantId)) throw new ValidationError('Choose a restaurant');
        data.restaurantId = String(body.restaurantId);
    }
    if (!partial || body.videoUrl !== undefined) {
        data.videoUrl = url(body.videoUrl);
        if (!data.videoUrl) throw new ValidationError('A reel needs a video');
    }
    if (body.description !== undefined) data.description = text(body.description, 300, 'Description');
    if (body.thumbnail !== undefined) data.thumbnail = url(body.thumbnail);
    if (body.isActive !== undefined) data.isActive = Boolean(body.isActive);
    if (body.sortOrder !== undefined) data.sortOrder = Number.parseInt(body.sortOrder, 10) || 0;
    if (body.alwaysVisible !== undefined) data.alwaysVisible = Boolean(body.alwaysVisible);
    if (body.startDate !== undefined) data.startDate = body.startDate ? date(body.startDate, 'Start date') : null;
    if (body.endDate !== undefined) {
        data.endDate = body.endDate ? date(body.endDate, 'End date') : null;
        if (data.endDate) data.endDate.setHours(23, 59, 59, 999);
    }
    if (data.alwaysVisible === false && (!data.startDate || !data.endDate) && !partial) {
        throw new ValidationError('A reel that is not always visible needs a start and end date');
    }
    return data;
}

export const reelState = (reel, now = new Date()) => {
    if (!reel.isActive) return 'off';
    if (reel.alwaysVisible) return 'showing';
    if (reel.endDate && new Date(reel.endDate) < now) return 'expired';
    if (reel.startDate && new Date(reel.startDate) > now) return 'scheduled';
    return 'showing';
};

export async function listReelsAdmin() {
    const rows = await prisma.foodReel.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        include: { restaurant: { select: { id: true, restaurantName: true } } },
    });
    return rows.map((r) => ({ ...r, state: reelState(r), restaurantName: r.restaurant?.restaurantName || '' }));
}

export async function createReel(body = {}) {
    return prisma.foodReel.create({ data: reelData(body) });
}

export async function updateReel(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid reel');
    return prisma.foodReel.update({ where: { id: String(id) }, data: reelData(body, { partial: true }) }).catch(() => {
        throw new ValidationError('Reel not found');
    });
}

export async function deleteReel(id) {
    if (!isId(id)) throw new ValidationError('Invalid reel');
    const { count } = await prisma.foodReel.deleteMany({ where: { id: String(id) } });
    if (!count) throw new ValidationError('Reel not found');
    return { deleted: true };
}

/** Reels showing now, for the customer app. */
export async function listShowingReels() {
    const now = new Date();
    const rows = await prisma.foodReel.findMany({
        where: {
            isActive: true,
            restaurant: { status: 'approved' },
            OR: [{ alwaysVisible: true }, { startDate: { lte: now }, endDate: { gte: now } }],
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
        include: { restaurant: { select: { id: true, restaurantName: true, profileImage: true } } },
        take: 50,
    });
    return rows.map((r) => ({
        id: r.id,
        description: r.description,
        videoUrl: r.videoUrl,
        thumbnail: r.thumbnail,
        views: r.views,
        likes: r.likes,
        restaurant: { id: r.restaurant.id, name: r.restaurant.restaurantName, logo: r.restaurant.profileImage },
    }));
}

/** Count a view, like, or tap through to the restaurant. */
export async function countReelEvent(id, event) {
    const column = { view: 'views', like: 'likes', visit: 'restaurantVisits' }[event];
    if (!column || !isId(id)) throw new ValidationError('Invalid reel event');
    const { count } = await prisma.foodReel.updateMany({ where: { id: String(id), isActive: true }, data: { [column]: { increment: 1 } } });
    return { counted: count > 0 };
}
