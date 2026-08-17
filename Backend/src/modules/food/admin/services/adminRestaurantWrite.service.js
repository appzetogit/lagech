import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { fromRestaurantLocation, toRestaurant } from '../../restaurant/restaurant.mapper.js';
import {
    DAY_NAMES,
    normalizeDayName,
    normalizeRestaurantTime,
    parseBooleanLike,
    toFiniteNumber,
    validateOpeningClosingTimes,
} from './adminRestaurantWrite.helpers.js';

/**
 * Creating and editing a restaurant from the admin panel, extracted from
 * admin.service.js.
 *
 * These are the two long field-mapping functions. What changed with Postgres is
 * mostly shape: the nested `location` subdocument is flat columns (the mapper
 * owns that translation), `diningSettings` is three columns, and a phone
 * collision is decided by the database rather than by a lookup first.
 */

const toStr = (v) => (v != null ? String(v).trim() : '');
const getUrl = (v) => (v && typeof v === 'object' ? v.url : v);
const toUrl = (v) => toStr(getUrl(v)) || undefined;
const toUrlList = (value, max) => {
    const list = Array.isArray(value) ? value : [value];
    return list.map((v) => toStr(getUrl(v))).filter(Boolean).slice(0, max);
};

const ZONE_DETAIL = {
    select: { id: true, name: true, zoneName: true, serviceLocation: true, isActive: true },
};

/**
 * Keep the day-wise outlet timings in step with the simple opening/closing
 * fields an admin edits.
 *
 * A day the restaurant has already closed stays closed — only the hours move.
 */
const syncOutletTimings = async (tx, restaurant) => {
    const openingTime = normalizeRestaurantTime(restaurant?.openingTime) || '09:00';
    const closingTime = normalizeRestaurantTime(restaurant?.closingTime) || '22:00';

    const openDays = Array.isArray(restaurant?.openDays)
        ? [...new Set(restaurant.openDays.map(normalizeDayName).filter(Boolean))]
        : [];
    const fallbackOpenDays = new Set(openDays.length ? openDays : DAY_NAMES);

    const existing = await tx.foodRestaurantOutletTimings.findUnique({
        where: { restaurantId: restaurant.id },
        select: { timings: true },
    });
    const existingTimings = Array.isArray(existing?.timings) ? existing.timings : [];

    const timings = DAY_NAMES.map((day) => {
        const current = existingTimings.find((slot) => normalizeDayName(slot?.day) === day);
        const isOpen = current ? current.isOpen !== false : fallbackOpenDays.has(day);
        return {
            day,
            isOpen,
            openingTime: isOpen ? openingTime : '',
            closingTime: isOpen ? closingTime : '',
        };
    });

    await tx.foodRestaurantOutletTimings.upsert({
        where: { restaurantId: restaurant.id },
        create: { restaurantId: restaurant.id, timings },
        update: { timings },
    });
};

/**
 * Editing a restaurant changes the cached public payload.
 *
 * Invalidated on every edit, not only a timings change: the name, cuisines and
 * every image field are part of that payload, so editing an image and seeing
 * the old one for the rest of the TTL was indistinguishable from the upload
 * having failed.
 */
const dropPublicCaches = async () => {
    const { invalidateCache } = await import('../../../../middleware/cache.js');
    void invalidateCache('restaurants:*');
    void invalidateCache('restaurant_detail:*');
    void invalidateCache('restaurant_timings:*');
};

export async function updateRestaurantById(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodRestaurant.findUnique({ where: { id: String(id) } });
    if (!existing) return null;

    const data = {};

    if (body.name !== undefined || body.restaurantName !== undefined) {
        const name = toStr(body.name !== undefined ? body.name : body.restaurantName);
        if (!name) throw new ValidationError('Restaurant name cannot be empty');
        data.restaurantName = name;
    }

    if (body.ownerName !== undefined) data.ownerName = toStr(body.ownerName);
    if (body.ownerEmail !== undefined) data.ownerEmail = toStr(body.ownerEmail).toLowerCase();
    if (body.ownerPhone !== undefined) data.ownerPhone = toStr(body.ownerPhone);
    if (body.primaryContactNumber !== undefined) {
        data.primaryContactNumber = toStr(body.primaryContactNumber);
    }

    if (body.pureVegRestaurant !== undefined) {
        data.pureVegRestaurant = parseBooleanLike(body.pureVegRestaurant, 'pureVegRestaurant');
    }

    if (body.isAcceptingOrders !== undefined) {
        data.isAcceptingOrders = parseBooleanLike(body.isAcceptingOrders, 'isAcceptingOrders');
        // Going back online clears a manual force-offline.
        data.outsideHoursOverride = false;
    }

    if (body.cuisines !== undefined) {
        if (Array.isArray(body.cuisines)) {
            data.cuisines = body.cuisines.map(toStr).filter(Boolean).slice(0, 50);
        } else if (typeof body.cuisines === 'string') {
            data.cuisines = body.cuisines.split(',').map(toStr).filter(Boolean).slice(0, 50);
        } else {
            throw new ValidationError('cuisines must be an array or comma-separated string');
        }
    }

    if (body.openingTime !== undefined) {
        data.openingTime = normalizeRestaurantTime(body.openingTime) || '';
    }
    if (body.closingTime !== undefined) {
        data.closingTime = normalizeRestaurantTime(body.closingTime) || '';
    }
    validateOpeningClosingTimes(
        data.openingTime ?? existing.openingTime,
        data.closingTime ?? existing.closingTime,
    );

    if (Array.isArray(body.openDays)) data.openDays = body.openDays.map(toStr).filter(Boolean);
    if (body.offer !== undefined) data.offer = toStr(body.offer);

    if (body.estimatedDeliveryTime !== undefined) {
        data.estimatedDeliveryTime = toStr(body.estimatedDeliveryTime);
    }
    if (body.estimatedDeliveryTimeMinutes !== undefined) {
        const minutes = toFiniteNumber(body.estimatedDeliveryTimeMinutes);
        if (minutes === null) data.estimatedDeliveryTimeMinutes = null;
        else if (minutes < 0) throw new ValidationError('estimatedDeliveryTimeMinutes must be >= 0');
        else data.estimatedDeliveryTimeMinutes = Math.round(minutes);
    }

    // Business and documents
    if (body.panNumber !== undefined) data.panNumber = toStr(body.panNumber);
    if (body.nameOnPan !== undefined) data.nameOnPan = toStr(body.nameOnPan);
    if (body.gstRegistered !== undefined) {
        data.gstRegistered = parseBooleanLike(body.gstRegistered, 'gstRegistered');
    }
    if (body.gstNumber !== undefined) data.gstNumber = toStr(body.gstNumber);
    if (body.gstLegalName !== undefined) data.gstLegalName = toStr(body.gstLegalName);
    if (body.gstAddress !== undefined) data.gstAddress = toStr(body.gstAddress);
    if (body.fssaiNumber !== undefined) data.fssaiNumber = toStr(body.fssaiNumber);
    if (body.fssaiExpiry !== undefined) {
        data.fssaiExpiry = body.fssaiExpiry ? new Date(body.fssaiExpiry) : null;
    }

    // Bank details
    if (body.accountNumber !== undefined) data.accountNumber = toStr(body.accountNumber);
    if (body.ifscCode !== undefined) data.ifscCode = toStr(body.ifscCode);
    if (body.accountHolderName !== undefined) data.accountHolderName = toStr(body.accountHolderName);
    if (body.accountType !== undefined) data.accountType = toStr(body.accountType);

    if (body.featuredDish !== undefined) data.featuredDish = toStr(body.featuredDish);
    if (body.featuredPrice !== undefined) data.featuredPrice = toFiniteNumber(body.featuredPrice);

    // Images
    if (body.profileImage !== undefined) data.profileImage = toUrl(body.profileImage) ?? '';
    if (body.panImage !== undefined) data.panImage = toUrl(body.panImage) ?? '';
    if (body.gstImage !== undefined) data.gstImage = toUrl(body.gstImage) ?? '';
    if (body.fssaiImage !== undefined) data.fssaiImage = toUrl(body.fssaiImage) ?? '';
    if (body.menuImages !== undefined) data.menuImages = toUrlList(body.menuImages, 10);

    // The cover and premises gallery were missing here, so an admin could edit
    // a restaurant's documents but not the two images the customer app and the
    // rider's pickup screen actually show.
    if (body.coverImage !== undefined) data.coverImage = toUrl(body.coverImage) ?? '';
    if (body.coverImages !== undefined) data.coverImages = toUrlList(body.coverImages, 10);
    if (body.galleryImages !== undefined) data.galleryImages = toUrlList(body.galleryImages, 10);

    const updated = await prisma.$transaction(async (tx) => {
        const row = await tx.foodRestaurant.update({ where: { id: existing.id }, data });
        if (body.openingTime !== undefined || body.closingTime !== undefined) {
            await syncOutletTimings(tx, row);
        }
        return row;
    });

    await dropPublicCaches();

    const doc = await prisma.foodRestaurant.findUnique({
        where: { id: updated.id },
        include: { zone: ZONE_DETAIL },
    });
    return toRestaurant(doc);
}

/** Admin creates a restaurant. Image URLs are already uploaded by the caller. */
export async function createRestaurantByAdmin(body = {}) {
    const loc = body.location || {};

    const restaurantName = toStr(body.restaurantName) || toStr(body.name);
    const ownerName = toStr(body.ownerName);
    const ownerPhone = toStr(body.ownerPhone);
    const primaryContactNumber = toStr(body.primaryContactNumber) || ownerPhone;

    if (!restaurantName || !ownerName) {
        throw new ValidationError('Restaurant name and owner name are required');
    }
    if (!ownerPhone && !primaryContactNumber) {
        throw new ValidationError('Owner phone or primary contact number is required');
    }

    const openingTime = normalizeRestaurantTime(body.openingTime) || '09:00';
    const closingTime = normalizeRestaurantTime(body.closingTime) || '22:00';
    validateOpeningClosingTimes(openingTime, closingTime);

    let zoneId = null;
    if (body.zoneId !== undefined) {
        const raw = toStr(body.zoneId);
        if (raw && !isId(raw)) throw new ValidationError('Invalid zoneId');
        zoneId = raw || null;
    }

    // A restaurant's phone is how its owner logs in, so the same number must
    // not reach two accounts. Every spelling of it is checked: as given, digits
    // only, and the last ten.
    const phoneCandidates = [...new Set(
        [ownerPhone, primaryContactNumber]
            .filter(Boolean)
            .flatMap((phone) => {
                const digits = phone.replace(/\D/g, '');
                return [phone, digits, digits.slice(-10)].filter(Boolean);
            })
    )];

    if (phoneCandidates.length) {
        const [duplicateRestaurant, duplicateUser] = await Promise.all([
            prisma.foodRestaurant.findFirst({
                where: {
                    OR: [
                        { ownerPhone: { in: phoneCandidates } },
                        { primaryContactNumber: { in: phoneCandidates } },
                        { ownerPhoneDigits: { in: phoneCandidates } },
                        { ownerPhoneLast10: { in: phoneCandidates } },
                    ],
                },
                select: { id: true },
            }),
            prisma.foodUser.findFirst({
                where: { role: 'RESTAURANT', phone: { in: phoneCandidates } },
                select: { id: true },
            }),
        ]);

        if (duplicateRestaurant) {
            throw new ValidationError('A restaurant with this phone number already exists');
        }
        if (duplicateUser) {
            throw new ValidationError('A restaurant account with this phone number already exists');
        }
    }

    const dining = body.diningSettings && typeof body.diningSettings === 'object'
        ? {
            diningEnabled: Boolean(body.diningSettings.isEnabled),
            diningMaxGuests: Math.max(1, parseInt(body.diningSettings.maxGuests, 10) || 6),
            diningType: toStr(body.diningSettings.diningType) || 'family-dining',
        }
        : {};

    const created = await prisma.$transaction(async (tx) => {
        const row = await tx.foodRestaurant.create({
            data: {
                restaurantName,
                ownerName,
                ownerEmail: toStr(body.ownerEmail),
                ownerPhone,
                primaryContactNumber,
                pureVegRestaurant: body.pureVegRestaurant !== undefined
                    ? parseBooleanLike(body.pureVegRestaurant, 'pureVegRestaurant')
                    : false,
                // The nested location subdocument is flat columns now, and the
                // PostGIS point beside them is derived by a trigger.
                ...fromRestaurantLocation({
                    latitude: loc.latitude,
                    longitude: loc.longitude,
                    coordinates: loc.coordinates,
                    formattedAddress: loc.formattedAddress || loc.address || loc.addressLine1,
                    addressLine1: loc.addressLine1 || loc.formattedAddress || loc.address,
                    addressLine2: loc.addressLine2,
                    area: loc.area,
                    city: loc.city,
                    state: loc.state,
                    pincode: loc.pincode || loc.zipCode || loc.postalCode,
                    landmark: loc.landmark,
                }),
                zoneId,
                cuisines: Array.isArray(body.cuisines) ? body.cuisines : [],
                openingTime,
                closingTime,
                openDays: Array.isArray(body.openDays) ? body.openDays : [],
                panNumber: toStr(body.panNumber),
                nameOnPan: toStr(body.nameOnPan),
                gstRegistered: Boolean(body.gstRegistered),
                gstNumber: toStr(body.gstNumber),
                gstLegalName: toStr(body.gstLegalName),
                gstAddress: toStr(body.gstAddress),
                fssaiNumber: toStr(body.fssaiNumber),
                fssaiExpiry: body.fssaiExpiry ? new Date(body.fssaiExpiry) : null,
                accountNumber: toStr(body.accountNumber),
                ifscCode: toStr(body.ifscCode),
                accountHolderName: toStr(body.accountHolderName),
                accountType: toStr(body.accountType),
                menuImages: toUrlList(body.menuImages, 10),
                profileImage: toUrl(body.profileImage) ?? '',
                panImage: toUrl(body.panImage) ?? '',
                gstImage: toUrl(body.gstImage) ?? '',
                fssaiImage: toUrl(body.fssaiImage) ?? '',
                estimatedDeliveryTime: toStr(body.estimatedDeliveryTime),
                featuredDish: toStr(body.featuredDish),
                featuredPrice: toFiniteNumber(body.featuredPrice),
                offer: toStr(body.offer),
                ...dining,
                // An admin creating it is the approval.
                status: 'approved',
                approvedAt: new Date(),
            },
        });

        // Seeded in the same transaction: a restaurant with no timings row
        // reads as closed every day, so an approved outlet could never take an
        // order.
        await syncOutletTimings(tx, row);
        return row;
    });

    await dropPublicCaches();
    return toRestaurant(created);
}
