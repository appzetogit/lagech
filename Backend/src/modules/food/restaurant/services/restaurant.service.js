import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { uploadImageBuffer } from '../../../../services/cloudinary.service.js';
import { normalizeMediaUrlForStorage } from '../../../../services/storage.service.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { findZoneForPoint } from '../../shared/zone.service.js';
import {
    restaurantIdsMatchingCuisine,
    restaurantsNearPoint,
} from '../../shared/restaurantQuery.util.js';
import { fromRestaurantLocation, toRestaurant } from '../restaurant.mapper.js';
import { attachOutletTimingsToRestaurants } from './outletTimings.service.js';
import { getRestaurantOperationalStatus } from '../helpers/restaurantAvailability.helper.js';
import {
    calculateDistanceKm,
    normalizeRestaurantLocation,
} from '../../shared/geo.utils.js';
import { getRestaurantSubscriptionSettings } from '../../admin/services/admin.service.js';
import { GST_RATE } from './subscriptionPlan.service.js';
import {
    createRazorpayOrder,
    getRazorpayKeyId,
    isRazorpayConfigured,
    verifyPaymentSignature,
} from '../../orders/helpers/razorpay.helper.js';

const normalizeName = (value) =>
    String(value || '')
        .trim()
        .toLowerCase()
        .replace(/-/g, ' ')
        .replace(/\s+/g, ' ');

const normalizePhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '').slice(-15);
    return {
        digits: digits || '',
        last10: digits ? digits.slice(-10) : ''
    };
};

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const normalizeDayName = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const exact = DAY_NAMES.find((d) => d.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const abbr = raw.slice(0, 3).toLowerCase();
    return DAY_NAMES.find((d) => d.toLowerCase().startsWith(abbr)) || null;
};


const normalizeRatingValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.min(5, Number(numeric.toFixed(1))));
};

const normalizeTotalRatingsValue = (value) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return 0;
    return Math.max(0, Math.floor(numeric));
};

const toUrl = (v) => {
    const raw = (v && (typeof v === 'string' ? v : v.url)) ? (typeof v === 'string' ? v : v.url) : '';
    return normalizeMediaUrlForStorage(raw);
};

const normalizeRestaurantTime = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const toHHMM = (hour, minute) => {
        const h = Number(hour);
        const m = Number(minute);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
        if (h < 0 || h > 23 || m < 0 || m > 59) return '';
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    // HH:mm / H:mm
    const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) return toHHMM(hhmm[1], hhmm[2]);

    // hh:mm AM/PM
    const ampm = raw.match(/^(\d{1,2}):(\d{2})\s*([AaPp][Mm])$/);
    if (ampm) {
        let hour = Number(ampm[1]);
        const minute = Number(ampm[2]);
        const period = ampm[3].toUpperCase();
        if (!Number.isFinite(hour) || !Number.isFinite(minute)) return '';
        if (hour < 1 || hour > 12 || minute < 0 || minute > 59) return '';
        if (period === 'AM') hour = hour === 12 ? 0 : hour;
        if (period === 'PM') hour = hour === 12 ? 12 : hour + 12;
        return toHHMM(hour, minute);
    }

    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.getTime())) {
        return toHHMM(parsed.getHours(), parsed.getMinutes());
    }

    return '';
};

const extractRecommendedItems = (sections) => {
    const recommended = [];
    if (!Array.isArray(sections)) return recommended;

    for (const section of sections) {
        if (!section) continue;

        // Items in main section
        if (Array.isArray(section.items)) {
            for (const item of section.items) {
                if (item && (item.isRecommended === true || item.isRecommended === 'true')) {
                    recommended.push({
                        id: item.id || item._id,
                        name: item.name || 'Unnamed Item',
                        price: item.price || item.featuredPrice || 0,
                        image: item.image || item.profileImage || ''
                    });
                }
                if (recommended.length >= 10) return recommended;
            }
        }

        // Items in subsections
        if (Array.isArray(section.subsections)) {
            for (const sub of section.subsections) {
                if (!sub || !Array.isArray(sub.items)) continue;
                for (const item of sub.items) {
                    if (item && (item.isRecommended === true || item.isRecommended === 'true')) {
                        recommended.push({
                            id: item.id || item._id,
                            name: item.name || 'Unnamed Item',
                            price: item.price || item.featuredPrice || 0,
                            image: item.image || item.profileImage || ''
                        });
                    }
                    if (recommended.length >= 10) return recommended;
                }
            }
        }
    }
    return recommended;
};

const timeToMinutes = (value) => {
    const normalized = normalizeRestaurantTime(value);
    if (!normalized) return null;
    const [h, m] = normalized.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
};

const parseEstimatedDeliveryMinutes = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const matches = raw.match(/\d+/g);
    if (!matches || !matches.length) return null;
    const numbers = matches.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n >= 0);
    if (!numbers.length) return null;
    return Math.round(numbers[numbers.length - 1]);
};

const buildActivePublicOfferFilter = (now = new Date()) => {
    // An offer ending "today" stays claimable all day, so the end bound is
    // compared against midnight rather than the current time.
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    return {
        status: 'active',
        showInCart: true,
        AND: [
            { OR: [{ startDate: null }, { startDate: { lte: now } }] },
            { OR: [{ endDate: null }, { endDate: { gte: startOfToday } }] },
            {
                OR: [
                    { usageLimit: null },
                    // 0 means unlimited, not "exhausted".
                    { usageLimit: 0 },
                    // Was a Mongo $expr comparing two fields. Prisma expresses
                    // it as a field reference, so it still resolves in the
                    // database rather than by fetching every offer.
                    { usedCount: { lt: prisma.foodOffer.fields.usageLimit } },
                ],
            },
        ],
    };
};

const formatRestaurantOfferSummary = (offer) => {
    if (!offer) return '';

    const discountType = offer.discountType;
    const discountValue = Number(offer.discountValue) || 0;
    const minOrderValue = Number(offer.minOrderValue) || 0;

    let summary = '';
    if (discountType === 'flat-price') {
        summary = `Flat ₹${discountValue} OFF`;
    } else {
        summary = `${discountValue}% OFF`;
        const maxDiscount = Number(offer.maxDiscount);
        if (Number.isFinite(maxDiscount) && maxDiscount > 0) {
            summary += ` up to ₹${maxDiscount}`;
        }
    }

    if (minOrderValue > 0) {
        summary += ` above ₹${minOrderValue}`;
    }

    return summary.trim();
};

const attachPublicOffersToRestaurants = async (restaurants = []) => {
    if (!Array.isArray(restaurants) || restaurants.length === 0) return restaurants;

    const idOf = (restaurant) =>
        String(restaurant?.id || restaurant?._id || restaurant?.restaurantId || '');

    const restaurantIds = restaurants.map(idOf).filter(isId);

    if (!restaurantIds.length) {
        return restaurants.map((restaurant) => ({
            ...restaurant,
            activeOffers: [],
            offerCount: 0,
        }));
    }

    const activeOfferFilter = buildActivePublicOfferFilter();
    const offers = await prisma.foodOffer.findMany({
        where: {
            ...activeOfferFilter,
            AND: [
                ...activeOfferFilter.AND,
                {
                    OR: [
                        { restaurantScope: 'all' },
                        { restaurantId: { in: restaurantIds } },
                        // hasSome, not `in`: restaurantIds is an array column,
                        // and the question is whether it overlaps this page.
                        { restaurantIds: { hasSome: restaurantIds } },
                    ],
                },
            ],
        },
        select: {
            id: true, couponCode: true, discountType: true, discountValue: true,
            minOrderValue: true, maxDiscount: true,
            restaurantScope: true, restaurantId: true, restaurantIds: true,
        },
        orderBy: { createdAt: 'desc' },
    });

    const globalOfferSummaries = [];
    const selectedOfferMap = new Map();

    for (const offer of offers) {
        const summary = formatRestaurantOfferSummary(offer);
        if (!summary) continue;

        const payload = {
            id: offer.id,
            couponCode: offer.couponCode || '',
            summary,
            discountType: offer.discountType,
            // Decimal columns, so each is converted rather than handed to the
            // client as a string.
            discountValue: Number(offer.discountValue) || 0,
            minOrderValue: Number(offer.minOrderValue) || 0,
            maxDiscount: Number.isFinite(Number(offer.maxDiscount)) ? Number(offer.maxDiscount) : null,
            restaurantScope: offer.restaurantScope,
        };

        if (offer.restaurantScope === 'all') {
            globalOfferSummaries.push(payload);
            continue;
        }

        const eligibleIds = new Set(
            [...(offer.restaurantIds || []), offer.restaurantId]
                .map((id) => String(id || ''))
                .filter(Boolean)
        );

        for (const restaurantId of eligibleIds) {
            if (!selectedOfferMap.has(restaurantId)) selectedOfferMap.set(restaurantId, []);
            selectedOfferMap.get(restaurantId).push(payload);
        }
    }

    return restaurants.map((restaurant) => {
        const restaurantId = idOf(restaurant);
        const combinedOffers = [
            ...globalOfferSummaries,
            ...(selectedOfferMap.get(restaurantId) || []),
        ];
        // A restaurant can be named both directly and by an all-restaurants
        // offer; the card must not show the same coupon twice.
        const dedupedOffers = [...new Map(combinedOffers.map((o) => [o.id, o])).values()];

        return { ...restaurant, activeOffers: dedupedOffers, offerCount: dedupedOffers.length };
    });
};

const toRestaurantProfile = (doc) => {
    if (!doc) return null;
    const loc = doc.location && typeof doc.location === 'object' ? doc.location : null;
    const location =
        (loc?.formattedAddress ||
            loc?.address ||
            loc?.addressLine1 ||
            loc?.addressLine2 ||
            loc?.area ||
            loc?.city ||
            loc?.state ||
            loc?.pincode ||
            loc?.landmark ||
            doc.addressLine1 ||
            doc.addressLine2 ||
            doc.area ||
            doc.city ||
            doc.state ||
            doc.pincode ||
            doc.landmark)
            ? normalizeRestaurantLocation({
                type: loc?.type || 'Point',
                coordinates: Array.isArray(loc?.coordinates) ? loc.coordinates : undefined,
                latitude: loc?.latitude ?? loc?.lat,
                longitude: loc?.longitude ?? loc?.lng,
                formattedAddress: loc?.formattedAddress || loc?.address || '',
                address: loc?.address || loc?.formattedAddress || '',
                addressLine1: loc?.addressLine1 || doc.addressLine1 || '',
                addressLine2: loc?.addressLine2 || doc.addressLine2 || '',
                area: loc?.area || doc.area || '',
                city: loc?.city || doc.city || '',
                state: loc?.state || doc.state || '',
                pincode: loc?.pincode || doc.pincode || '',
                landmark: loc?.landmark || doc.landmark || ''
            })
            : null;

    const menuImages = Array.isArray(doc.menuImages)
        ? doc.menuImages.map((m) => toUrl(m)).filter(Boolean).map((url) => ({ url, publicId: null }))
        : [];
    const coverImages = Array.isArray(doc.coverImages)
        ? doc.coverImages.map((m) => toUrl(m)).filter(Boolean).map((url) => ({ url, publicId: null }))
        : [];

    return {
        id: doc._id,
        _id: doc._id,
        restaurantId: doc.restaurantId || undefined,
        name: doc.restaurantName || '',
        restaurantName: doc.restaurantName || '',
        zoneId: doc.zoneId ? String(doc.zoneId) : '',
        cuisines: Array.isArray(doc.cuisines) ? doc.cuisines : [],
        location,
        ownerName: doc.ownerName || '',
        ownerEmail: doc.ownerEmail || '',
        ownerPhone: doc.ownerPhone || '',
        primaryContactNumber: doc.primaryContactNumber || '',
        panNumber: doc.panNumber || '',
        nameOnPan: doc.nameOnPan || '',
        panImage: doc.panImage ? { url: doc.panImage } : null,
        gstRegistered: Boolean(doc.gstRegistered),
        gstNumber: doc.gstNumber || '',
        gstLegalName: doc.gstLegalName || '',
        gstAddress: doc.gstAddress || '',
        gstImage: doc.gstImage ? { url: doc.gstImage } : null,
        fssaiNumber: doc.fssaiNumber || '',
        fssaiExpiry: doc.fssaiExpiry || null,
        fssaiImage: doc.fssaiImage ? { url: doc.fssaiImage } : null,
        accountNumber: doc.accountNumber || '',
        ifscCode: doc.ifscCode || '',
        accountHolderName: doc.accountHolderName || '',
        accountType: doc.accountType || '',
        upiId: doc.upiId || '',
        upiQrImage: doc.upiQrImage ? { url: doc.upiQrImage } : null,
        pureVegRestaurant: Boolean(doc.pureVegRestaurant),
        profileImage: doc.profileImage ? { url: doc.profileImage } : null,
        menuImages,
        coverImages,
        openingTime: normalizeRestaurantTime(doc.openingTime) || null,
        closingTime: normalizeRestaurantTime(doc.closingTime) || null,
        openDays: Array.isArray(doc.openDays) ? doc.openDays : [],
        estimatedDeliveryTime: doc.estimatedDeliveryTime || '',
        estimatedDeliveryTimeMinutes:
            Number.isFinite(Number(doc.estimatedDeliveryTimeMinutes))
                ? Number(doc.estimatedDeliveryTimeMinutes)
                : null,
        diningSettings: {
            isEnabled: doc.diningSettings?.isEnabled !== false,
            maxGuests: Math.max(1, parseInt(doc.diningSettings?.maxGuests, 10) || 6),
            diningType: String(doc.diningSettings?.diningType || 'family-dining').trim() || 'family-dining'
        },
        isAcceptingOrders: doc.isAcceptingOrders !== false,
        outsideHoursOverride: doc.outsideHoursOverride === true,
        subscriptionPlan: doc.subscriptionPlan || '',
        subscriptionAmount: Number.isFinite(Number(doc.subscriptionAmount)) ? Number(doc.subscriptionAmount) : 0,
        subscriptionPaidAmount: Number.isFinite(Number(doc.subscriptionPaidAmount)) ? Number(doc.subscriptionPaidAmount) : 0,
        subscriptionDueAmount: Number.isFinite(Number(doc.subscriptionDueAmount)) ? Number(doc.subscriptionDueAmount) : 0,
        subscriptionStatus: doc.subscriptionStatus || 'due',
        subscriptionValidTill: doc.subscriptionValidTill || null,
        onboardingFeePaid: Boolean(doc.onboardingFeePaid),
        onboardingFeePaidAt: doc.onboardingFeePaidAt || null,
        onboardingFeePaymentMethod: doc.onboardingFeePaymentMethod || '',
        onboardingFeePaymentOrderId: doc.onboardingFeePaymentOrderId || '',
        onboardingFeePaymentId: doc.onboardingFeePaymentId || '',
        onboardingFeePaymentSignature: doc.onboardingFeePaymentSignature || '',
        status: doc.status || null,
        locationUpdateStatus: doc.locationUpdateStatus || 'none',
        locationUpdateRequestedAt: doc.locationUpdateRequestedAt || null,
        locationUpdateReviewedAt: doc.locationUpdateReviewedAt || null,
        locationRejectionReason: doc.locationRejectionReason || '',
        pendingLocation: normalizeProfileLocation(doc.pendingLocation),
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
        rating: normalizeRatingValue(doc.rating),
        totalRatings: normalizeTotalRatingsValue(doc.totalRatings)
    };
};

const toFiniteNumber = (value) => {
    const n = typeof value === 'number' ? value : parseFloat(String(value));
    return Number.isFinite(n) ? n : null;
};

const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const normalizeCuisine = (value) => String(value || '').trim().slice(0, 80);

const parseSortBy = (value) => {
    const v = String(value || '').trim();
    const allowed = new Set(['nearest', 'rating', 'newest', 'deliveryTime', 'price-low', 'price-high', 'rating-high', 'rating-low']);
    return allowed.has(v) ? v : null;
};

/**
 * The restaurant's own profile.
 *
 * Spelled out rather than left to Prisma's default of every column: the table
 * also holds fcmTokens and the auth token version, which have no business in a
 * profile response.
 */
const PROFILE_SELECT = {
    accountHolderName: true, accountNumber: true, accountType: true,
    addressLine1: true, addressLine2: true, area: true, city: true,
    closingTime: true, coverImages: true, createdAt: true, cuisines: true,
    diningEnabled: true, diningMaxGuests: true, diningType: true,
    estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
    formattedAddress: true, fssaiExpiry: true, fssaiImage: true, fssaiNumber: true,
    gstAddress: true, gstImage: true, gstLegalName: true, gstNumber: true,
    gstRegistered: true, id: true, ifscCode: true, isAcceptingOrders: true,
    landmark: true, latitude: true, longitude: true, menuImages: true,
    nameOnPan: true, onboardingFeePaid: true, onboardingFeePaidAt: true,
    onboardingFeePaymentId: true, onboardingFeePaymentMethod: true,
    onboardingFeePaymentOrderId: true, onboardingFeePaymentSignature: true,
    openDays: true, openingTime: true, outsideHoursOverride: true,
    ownerEmail: true, ownerName: true, ownerPhone: true, panImage: true,
    panNumber: true, pincode: true, primaryContactNumber: true,
    profileImage: true, pureVegRestaurant: true, restaurantName: true,
    state: true, status: true, subscriptionAmount: true, subscriptionDueAmount: true,
    subscriptionPaidAmount: true, subscriptionPlan: true, subscriptionStatus: true,
    subscriptionValidTill: true, updatedAt: true, upiId: true, upiQrImage: true,
    zoneId: true,
    // The location-change approval flow reads these.
    pendingLatitude: true, pendingLongitude: true, pendingZoneId: true,
    locationUpdateStatus: true, locationUpdateRequestedAt: true,
    locationUpdateReviewedAt: true, locationRejectionReason: true,
};

const findMatchedZoneForCoordinates = async (lat, lng) => {
    if (lat === null || lng === null) return null;
    const zone = await findZoneForPoint(lat, lng);
    // Callers read `_id`; the raw query returns `id`.
    return zone ? { ...zone, _id: zone.id } : null;
};

const hasPublishedRestaurantLocation = (restaurant = {}) => {
    // Reads the flat columns, falling back to a nested `location` for callers
    // that hand over an already-mapped restaurant.
    const loc = restaurant?.location && typeof restaurant.location === 'object' ? restaurant.location : {};
    const lat = toFiniteNumber(restaurant?.latitude ?? loc.latitude ?? loc?.coordinates?.[1]);
    const lng = toFiniteNumber(restaurant?.longitude ?? loc.longitude ?? loc?.coordinates?.[0]);
    return lat !== null && lng !== null;
};

const buildLocationObjectFromInput = (loc = {}) => {
    const toStr = (v) => (v != null ? String(v).trim() : '');
    const formattedAddress = toStr(loc.formattedAddress || loc.address);
    const lat = toFiniteNumber(loc.latitude);
    const lng = toFiniteNumber(loc.longitude);
    return {
        type: 'Point',
        coordinates: lat !== null && lng !== null ? [lng, lat] : undefined,
        latitude: lat ?? undefined,
        longitude: lng ?? undefined,
        formattedAddress,
        address: formattedAddress,
        addressLine1: toStr(loc.addressLine1),
        addressLine2: toStr(loc.addressLine2),
        area: toStr(loc.area),
        city: toStr(loc.city),
        state: toStr(loc.state),
        pincode: toStr(loc.pincode),
        landmark: toStr(loc.landmark)
    };
};

const normalizeProfileLocation = (loc) => {
    if (!loc || typeof loc !== 'object') return null;
    return normalizeRestaurantLocation({
        type: loc?.type || 'Point',
        coordinates: Array.isArray(loc?.coordinates) ? loc.coordinates : undefined,
        latitude: loc?.latitude ?? loc?.lat,
        longitude: loc?.longitude ?? loc?.lng,
        formattedAddress: loc?.formattedAddress || loc?.address || '',
        address: loc?.address || loc?.formattedAddress || '',
        addressLine1: loc?.addressLine1 || '',
        addressLine2: loc?.addressLine2 || '',
        area: loc?.area || '',
        city: loc?.city || '',
        state: loc?.state || '',
        pincode: loc?.pincode || '',
        landmark: loc?.landmark || ''
    });
};

const stripPendingLocationFromPublicRestaurant = (doc) => {
    if (!doc || typeof doc !== 'object') return doc;
    const {
        pendingLocation,
        pendingZoneId,
        locationUpdateStatus,
        locationUpdateRequestedAt,
        locationUpdateReviewedAt,
        locationRejectionReason,
        ...publicDoc
    } = doc;
    return publicDoc;
};

/**
 * Keep public restaurant.location.latitude/longitude in sync with GeoJSON coordinates
 * so user-home Haversine matches delivery (which already parses coordinates-first).
 * Optionally attach distanceInKm when the client sent lat/lng.
 */
const normalizePublicRestaurantGeo = (doc, userLat = null, userLng = null) => {
    if (!doc || typeof doc !== 'object') return doc;

    const location = doc.location
        ? normalizeRestaurantLocation(doc.location)
        : doc.location;

    const next = location ? { ...doc, location } : { ...doc };

    if (
        Number.isFinite(userLat) &&
        Number.isFinite(userLng) &&
        location
    ) {
        const km = calculateDistanceKm(
            { latitude: userLat, longitude: userLng },
            location,
        );
        if (Number.isFinite(km)) {
            next.distanceInKm = Number(km.toFixed(2));
        }
    }

    return next;
};

const notifyAdminsAboutRestaurantLocationUpdate = async (restaurantId, restaurantName) => {
    try {
        const { notifyAdminsSafely } = await import('../../../../core/notifications/firebase.service.js');
        void notifyAdminsSafely({
            title: 'Restaurant Location Update',
            body: `Restaurant "${restaurantName || 'Unknown Restaurant'}" requested a location change and is pending approval.`,
            data: {
                type: 'restaurant_location_updated',
                subType: 'restaurant',
                id: String(restaurantId)
            }
        });
    } catch (e) {
        console.error('Failed to notify admins of restaurant location update:', e);
    }
};

const notifyAdminsAboutRestaurantProfileReview = async (restaurantId, restaurantName) => {
    try {
        const { notifyAdminsSafely } = await import('../../../../core/notifications/firebase.service.js');
        void notifyAdminsSafely({
            title: 'Restaurant Profile Updated',
            body: `Restaurant "${restaurantName || 'Unknown Restaurant'}" updated its profile and is pending approval again.`,
            data: {
                type: 'restaurant_profile_updated',
                subType: 'restaurant',
                id: String(restaurantId)
            }
        });
    } catch (e) {
        console.error('Failed to notify admins of restaurant profile resubmission:', e);
    }
};

export const uploadRestaurantAttachment = async (file, folderType = 'profile') => {
    if (!file || !file.buffer) {
        throw new Error('File is required for upload');
    }

    let folder = 'food/restaurants';
    if (folderType === 'profile') folder += '/profile';
    else if (folderType === 'pan') folder += '/pan';
    else if (folderType === 'gst') folder += '/gst';
    else if (folderType === 'fssai') folder += '/fssai';
    else if (folderType === 'menu') folder += '/menu';
    else folder += '/others';

    const url = await uploadImageBuffer(file.buffer, folder);
    return { url };
};

const computeOnboardingFeeWithGst = (baseFee) => {
    const fee = Math.max(0, Number(baseFee) || 0);
    const gstAmount = Math.round(fee * GST_RATE * 100) / 100;
    const total = Math.round((fee + gstAmount) * 100) / 100;
    return { baseFee: fee, gstAmount, total };
};

export const createRestaurantOnboardingFeeOrder = async ({ ownerPhone }) => {
    const settings = await getRestaurantSubscriptionSettings();
    const fee = Math.max(0, Number(settings?.onboardingFee) || 0);
    if (fee <= 0) {
        throw new ValidationError('Onboarding fee is not required');
    }

    const { baseFee, gstAmount, total } = computeOnboardingFeeWithGst(fee);

    const { last10 } = normalizePhone(ownerPhone);
    if (!last10) {
        throw new ValidationError('Owner phone is required to create onboarding fee payment');
    }

    const amountPaise = Math.round(total * 100);

    if (!isRazorpayConfigured()) {
        return {
            onboardingFeeAmount: baseFee,
            onboardingFeeGst: gstAmount,
            onboardingFeeTotal: total,
            razorpay: {
                key: getRazorpayKeyId() || 'rzp_test_dummy',
                orderId: `order_dev_onboarding_${last10}_${Date.now()}`,
                amount: amountPaise,
                currency: 'INR',
            },
        };
    }

    const receipt = `onboarding_${last10}_${Date.now()}`;
    const order = await createRazorpayOrder(amountPaise, 'INR', receipt);
    return {
        onboardingFeeAmount: baseFee,
        onboardingFeeGst: gstAmount,
        onboardingFeeTotal: total,
        razorpay: {
            key: getRazorpayKeyId(),
            orderId: String(order.id),
            amount: Number(order.amount) || amountPaise,
            currency: order.currency || 'INR',
        },
    };
};

export const registerRestaurant = async (payload, files) => {
    const {
        restaurantName,
        ownerName,
        ownerEmail,
        ownerPhone,
        primaryContactNumber,
        pureVegRestaurant,
        addressLine1,
        addressLine2,
        area,
        city,
        state,
        pincode,
        landmark,
        formattedAddress,
        latitude,
        longitude,
        zoneId,
        cuisines,
        openingTime,
        closingTime,
        openDays,
        estimatedDeliveryTime,
        panNumber,
        nameOnPan,
        gstRegistered,
        gstNumber,
        gstLegalName,
        gstAddress,
        fssaiNumber,
        fssaiExpiry,
        accountNumber,
        ifscCode,
        accountHolderName,
        accountType,
        subscriptionPlan,
        subscriptionAmount,
        subscriptionPaidAmount,
        subscriptionDueAmount,
        onboardingFeeAmount,
        onboardingFeePaid,
        paymentType,
        razorpayOrderId,
        razorpayPaymentId,
        razorpaySignature,
        // Pre-uploaded image URLs from background uploads
        profileImage: preUploadedProfileImage,
        panImage: preUploadedPanImage,
        gstImage: preUploadedGstImage,
        fssaiImage: preUploadedFssaiImage,
        menuImages: preUploadedMenuImages
    } = payload;

    if (!ownerPhone) {
        throw new ValidationError('Owner phone is required to register a restaurant');
    }

    const { digits: ownerPhoneDigits, last10: ownerPhoneLast10 } = normalizePhone(ownerPhone);
    if (!ownerPhoneLast10) {
        throw new ValidationError('Owner phone is invalid');
    }

    const restaurantNameNormalized = normalizeName(restaurantName);
    if (!restaurantNameNormalized) {
        throw new ValidationError('Restaurant name is required to register a restaurant');
    }

    const images = {
        profileImage: preUploadedProfileImage || '',
        panImage: preUploadedPanImage || '',
        gstImage: preUploadedGstImage || '',
        fssaiImage: preUploadedFssaiImage || ''
    };

    const uploadTasks = [];
    const imageMap = {};

    if (files?.profileImage?.[0]) {
        uploadTasks.push(uploadImageBuffer(files.profileImage[0].buffer, 'food/restaurants/profile')
            .then(url => { imageMap.profileImage = url; }));
    }
    if (files?.panImage?.[0]) {
        uploadTasks.push(uploadImageBuffer(files.panImage[0].buffer, 'food/restaurants/pan')
            .then(url => { imageMap.panImage = url; }));
    }
    if (files?.gstImage?.[0]) {
        uploadTasks.push(uploadImageBuffer(files.gstImage[0].buffer, 'food/restaurants/gst')
            .then(url => { imageMap.gstImage = url; }));
    }
    if (files?.fssaiImage?.[0]) {
        uploadTasks.push(uploadImageBuffer(files.fssaiImage[0].buffer, 'food/restaurants/fssai')
            .then(url => { imageMap.fssaiImage = url; }));
    }

    let menuImages = [];
    // If we have pre-uploaded menu images, use them
    if (preUploadedMenuImages) {
        try {
            menuImages = Array.isArray(preUploadedMenuImages)
                ? preUploadedMenuImages
                : (typeof preUploadedMenuImages === 'string' ? JSON.parse(preUploadedMenuImages) : []);
        } catch (e) {
            console.error('Error parsing preUploadedMenuImages:', e);
        }
    }

    if (files?.menuImages?.length) {
        uploadTasks.push(Promise.all(
            files.menuImages.map((file) => uploadImageBuffer(file.buffer, 'food/restaurants/menu'))
        ).then(urls => { menuImages = [...menuImages, ...urls]; }));
    }

    // Main cover image (single hero shot of the restaurant).
    let coverImage = String(payload.coverImage || '').trim();
    if (files?.coverImage?.[0]) {
        uploadTasks.push(
            uploadImageBuffer(files.coverImage[0].buffer, 'food/restaurants/cover')
                .then((url) => { if (url) coverImage = url; })
        );
    }

    // Premises gallery — the rider uses these to identify the shop at pickup.
    let galleryImages = [];
    if (payload.galleryImages) {
        try {
            const pre = typeof payload.galleryImages === 'string'
                ? JSON.parse(payload.galleryImages)
                : payload.galleryImages;
            if (Array.isArray(pre)) galleryImages = pre.map((u) => String(u || '').trim()).filter(Boolean);
        } catch {
            // A single pre-uploaded URL rather than a JSON array is fine too.
            const single = String(payload.galleryImages).trim();
            if (single.startsWith('http') || single.startsWith('/')) galleryImages = [single];
        }
    }
    if (files?.galleryImages?.length) {
        uploadTasks.push(Promise.all(
            files.galleryImages.map((file) => uploadImageBuffer(file.buffer, 'food/restaurants/gallery'))
        ).then((urls) => { galleryImages = [...galleryImages, ...urls.filter(Boolean)]; }));
    }

    // Wait for all uploads to complete in parallel
    if (uploadTasks.length > 0) {
        console.log(`[ONBOARDING] Starting upload of ${uploadTasks.length} image tasks...`);
        console.time('ImageUploadTotal');
        await Promise.all(uploadTasks);
        console.timeEnd('ImageUploadTotal');
        console.log('[ONBOARDING] All image uploads completed.');
    }

    Object.assign(images, imageMap);

    const normalizedOpeningTime = normalizeRestaurantTime(openingTime);
    const normalizedClosingTime = normalizeRestaurantTime(closingTime);
    const openingMinutes = timeToMinutes(normalizedOpeningTime);
    const closingMinutes = timeToMinutes(normalizedClosingTime);
    if (openingMinutes !== null && closingMinutes !== null) {
        if (openingMinutes === closingMinutes) {
            throw new ValidationError('Opening time and closing time cannot be same');
        }
        if (closingMinutes < openingMinutes) {
            throw new ValidationError('Closing time cannot be less than opening time');
        }
    }
    const estimatedDeliveryTimeText = String(estimatedDeliveryTime || '').trim();
    const estimatedDeliveryTimeMinutes = parseEstimatedDeliveryMinutes(estimatedDeliveryTimeText);

    const subscriptionSettings = await getRestaurantSubscriptionSettings();
    const requiredOnboardingFee = Math.max(0, Number(subscriptionSettings?.onboardingFee) || 0);
    const { total: requiredOnboardingFeeTotal } = computeOnboardingFeeWithGst(requiredOnboardingFee);
    let onboardingFeeFields = {};

    if (requiredOnboardingFee > 0) {
        if (!onboardingFeePaid) {
            throw new ValidationError('Onboarding fee payment is required before completing registration');
        }
        const paidAmount = Math.max(0, Number(onboardingFeeAmount) || 0);
        if (Math.abs(paidAmount - requiredOnboardingFeeTotal) > 0.01) {
            throw new ValidationError('Onboarding fee amount does not match the configured fee');
        }
        const orderId = String(razorpayOrderId || '').trim();
        const paymentId = String(razorpayPaymentId || '').trim();
        const signature = String(razorpaySignature || '').trim();
        if (!orderId || !paymentId || !signature) {
            throw new ValidationError('Complete onboarding fee payment details are required');
        }
        const verified = isRazorpayConfigured()
            ? verifyPaymentSignature(orderId, paymentId, signature)
            : true;
        if (!verified) {
            throw new ValidationError('Onboarding fee payment verification failed');
        }
        onboardingFeeFields = {
            onboardingFeePaid: true,
            onboardingFeeAmount: requiredOnboardingFeeTotal,
            onboardingFeePaidAt: new Date(),
            onboardingFeePaymentMethod: paymentType || 'razorpay',
            onboardingFeePaymentOrderId: orderId,
            onboardingFeePaymentId: paymentId,
            onboardingFeePaymentSignature: signature,
        };
    }

    try {
        const restaurant = await prisma.$transaction(async (tx) => {
            const created = await tx.foodRestaurant.create({
                data: {
                    restaurantName,
                    restaurantNameNormalized,
                    ownerName,
                    ownerEmail,
                    // Digits-only, to match the format the OTP login flow stores.
                    ownerPhone: ownerPhoneDigits,
                    ownerPhoneDigits,
                    ownerPhoneLast10,
                    primaryContactNumber,
                    pureVegRestaurant: pureVegRestaurant === true,
                    zoneId: isId(String(zoneId || '').trim()) ? String(zoneId).trim() : null,
                    // The nested location subdocument is flat columns now, and
                    // the PostGIS point beside them is derived by a trigger, so
                    // the mapper is the one place that knows the translation.
                    ...fromRestaurantLocation({
                        latitude,
                        longitude,
                        formattedAddress:
                            typeof formattedAddress === 'string' ? formattedAddress.trim() : '',
                        addressLine1: addressLine1 || '',
                        addressLine2: addressLine2 || '',
                        area: area || '',
                        city: city || '',
                        state: state || '',
                        pincode: pincode || '',
                        landmark: landmark || '',
                    }),
                    cuisines: cuisines || [],
                    openingTime: normalizedOpeningTime || undefined,
                    closingTime: normalizedClosingTime || undefined,
                    openDays: openDays || [],
                    estimatedDeliveryTime: estimatedDeliveryTimeText || undefined,
                    estimatedDeliveryTimeMinutes: estimatedDeliveryTimeMinutes ?? undefined,
                    panNumber,
                    nameOnPan,
                    gstRegistered,
                    gstNumber,
                    gstLegalName,
                    gstAddress,
                    fssaiNumber,
                    fssaiExpiry,
                    accountNumber,
                    ifscCode,
                    accountHolderName,
                    accountType,
                    menuImages,
                    coverImage,
                    galleryImages,
                    // coverImages (the public banner strip) is seeded from
                    // onboarding so the restaurant page is not blank before they
                    // manage banners themselves.
                    coverImages: coverImage ? [coverImage, ...galleryImages] : galleryImages,
                    // Postpaid subscription: monthly invoices from GMV at month end.
                    ...onboardingFeeFields,
                    ...images,
                },
            });

            // Seed day-wise outlet timings from the onboarding opening/closing
            // fields. In the same transaction as the restaurant: a restaurant
            // with no timings row reads as closed every day, so a failure here
            // used to leave an approved outlet that could never take an order.
            const normalizedOpenDays = Array.isArray(openDays)
                ? [...new Set(openDays.map(normalizeDayName).filter(Boolean))]
                : [];
            const openDaysSet = new Set(normalizedOpenDays.length ? normalizedOpenDays : DAY_NAMES);
            const seedOpeningTime = normalizedOpeningTime || '09:00';
            const seedClosingTime = normalizedClosingTime || '22:00';

            await tx.foodRestaurantOutletTimings.create({
                data: {
                    restaurantId: created.id,
                    timings: DAY_NAMES.map((day) => {
                        const isOpen = openDaysSet.has(day);
                        return {
                            day,
                            isOpen,
                            openingTime: isOpen ? seedOpeningTime : '',
                            closingTime: isOpen ? seedClosingTime : '',
                        };
                    }),
                },
            });

            return created;
        });

        try {
            const { notifyAdminsSafely } = await import('../../../../core/notifications/firebase.service.js');
            void notifyAdminsSafely({
                title: 'New Restaurant Registration',
                body: `A new restaurant "${restaurant.restaurantName}" has registered and is pending approval.`,
                data: {
                    type: 'new_registration',
                    subType: 'restaurant',
                    id: restaurant.id,
                },
            });
        } catch (e) {
            console.error('Failed to notify admins of new restaurant registration:', e);
        }

        return toRestaurant(restaurant);
    } catch (err) {
        // A unique index decides the race rather than a prior lookup.
        if (err?.code === 'P2002') {
            throw new ValidationError('Restaurant with this name and owner phone already exists');
        }
        throw err;
    }
};

export const getCurrentRestaurantProfile = async (restaurantId) => {
    if (!isId(restaurantId)) return null;

    const doc = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: PROFILE_SELECT,
    });
    if (!doc) return null;

    const profile = toRestaurantProfile(toRestaurant(doc));
    if (!profile) return null;
    return enrichRestaurantProfileWithAvailability(profile, doc);
};

const enrichRestaurantProfileWithAvailability = async (profile, doc) => {
    if (!profile || !doc) return profile;
    const [withTimings] = await attachOutletTimingsToRestaurants([doc]);
    const outletTimings = withTimings?.outletTimings || null;
    const operationalStatus = getRestaurantOperationalStatus({
        ...doc,
        isAcceptingOrders: profile.isAcceptingOrders,
        outsideHoursOverride: false,
        outletTimings,
    });
    return {
        ...profile,
        outsideHoursOverride: false,
        outletTimings,
        operationalStatus,
    };
};

export const updateRestaurantAcceptingOrders = async (restaurantId, isAcceptingOrders) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');

    // Offline = a manual force-offline. Online = clear the override and go back
    // to following the outlet timings.
    const { count } = await prisma.foodRestaurant.updateMany({
        where: { id: String(restaurantId) },
        data: { isAcceptingOrders: Boolean(isAcceptingOrders), outsideHoursOverride: false },
    });
    if (!count) return null;

    const doc = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: PROFILE_SELECT,
    });
    const profile = toRestaurantProfile(toRestaurant(doc));
    if (!profile) return null;
    return enrichRestaurantProfileWithAvailability(profile, doc);
};

export const updateCurrentRestaurantDiningSettings = async (restaurantId, body = {}) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const id = String(restaurantId);

    const current = await prisma.foodRestaurant.findUnique({
        where: { id },
        select: { diningEnabled: true, diningMaxGuests: true, diningType: true },
    });
    if (!current) throw new ValidationError('Restaurant not found');

    /** Accepts a real boolean or the strings a multipart form sends. */
    const parseBoolean = (value, fallback = false) => {
        if (value === undefined || value === null) return Boolean(fallback);
        if (typeof value === 'boolean') return value;
        const normalized = String(value).trim().toLowerCase();
        if (['true', '1', 'yes'].includes(normalized)) return true;
        if (['false', '0', 'no'].includes(normalized)) return false;
        return Boolean(fallback);
    };

    // The nested diningSettings subdocument is three columns now, so a partial
    // edit no longer has to rebuild the whole object — which is what made the
    // Mongo version read the current values first just to avoid erasing them.
    await prisma.foodRestaurant.update({
        where: { id },
        data: {
            diningEnabled: parseBoolean(body.isEnabled, current.diningEnabled),
            diningMaxGuests: Math.max(
                1,
                parseInt(body.maxGuests ?? current.diningMaxGuests ?? 6, 10) || 6
            ),
            diningType:
                String(body.diningType ?? current.diningType ?? 'family-dining').trim() ||
                'family-dining',
        },
    });

    const doc = await prisma.foodRestaurant.findUnique({ where: { id }, select: PROFILE_SELECT });
    const profile = toRestaurantProfile(toRestaurant(doc));
    if (!profile) return null;
    return enrichRestaurantProfileWithAvailability(profile, doc);
};

export const updateRestaurantProfile = async (restaurantId, body = {}) => {
    if (!isId(restaurantId)) {
        throw new ValidationError('Invalid restaurant id');
    }

    const currentRestaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: {
            id: true, restaurantName: true, restaurantNameNormalized: true,
            ownerPhone: true, ownerPhoneDigits: true, ownerPhoneLast10: true,
            primaryContactNumber: true, status: true,
            latitude: true, longitude: true,
        },
    });

    if (!currentRestaurant) {
        throw new ValidationError('Restaurant not found');
    }

    const update = {};

    // Owner/contact fields (used by restaurant Contact Details screens)
    if (body.ownerName !== undefined) {
        const ownerName = String(body.ownerName || '').trim();
        if (!ownerName) {
            throw new ValidationError('Owner name cannot be empty');
        }
        if (ownerName.length > 120) {
            throw new ValidationError('Owner name is too long');
        }
        update.ownerName = ownerName;
    }

    if (body.ownerEmail !== undefined) {
        const ownerEmail = String(body.ownerEmail || '').trim().toLowerCase();
        if (ownerEmail) {
            const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
            if (!EMAIL_REGEX.test(ownerEmail)) {
                throw new ValidationError('Owner email is invalid');
            }
            const domainParts = ownerEmail.split('@')[1].split('.');
            for (let i = 0; i < domainParts.length - 1; i++) {
                if (domainParts[i] === domainParts[i + 1] && domainParts[i].length > 0) {
                    throw new ValidationError('Owner email has repeated domain parts (like .com.com)');
                }
            }
            if (ownerEmail.includes('..')) {
                throw new ValidationError('Owner email cannot contain consecutive dots');
            }
            if (ownerEmail.length > 254) {
                throw new ValidationError('Owner email is too long');
            }
            update.ownerEmail = ownerEmail;
        } else {
            update.ownerEmail = '';
        }
    }

    // Note: UI keeps phone read-only, but we accept it safely and normalize if sent.
    if (body.ownerPhone !== undefined) {
        const { digits, last10 } = normalizePhone(body.ownerPhone);
        if (!digits || digits.length < 8) {
            throw new ValidationError('Owner phone is invalid');
        }

        const currentOwnerPhoneDigits =
            currentRestaurant.ownerPhoneDigits ||
            normalizePhone(currentRestaurant.ownerPhone).digits ||
            '';

        if (digits !== currentOwnerPhoneDigits) {
            update.ownerPhone = digits;
            update.ownerPhoneDigits = digits;
            update.ownerPhoneLast10 = last10 || undefined;
        }
    }

    if (body.primaryContactNumber !== undefined) {
        const { digits } = normalizePhone(body.primaryContactNumber);
        const normalizedPrimaryContact =
            digits || String(body.primaryContactNumber || '').trim();
        const currentPrimaryContact =
            currentRestaurant.primaryContactNumber != null
                ? String(currentRestaurant.primaryContactNumber).trim()
                : '';

        if (normalizedPrimaryContact !== currentPrimaryContact) {
            update.primaryContactNumber = normalizedPrimaryContact;
        }
    }

    if (body.pureVegRestaurant !== undefined) {
        if (typeof body.pureVegRestaurant === 'boolean') {
            update.pureVegRestaurant = body.pureVegRestaurant;
        } else if (typeof body.pureVegRestaurant === 'string') {
            const normalized = body.pureVegRestaurant.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
                update.pureVegRestaurant = true;
            } else if (normalized === 'false' || normalized === '0' || normalized === 'no') {
                update.pureVegRestaurant = false;
            } else {
                throw new ValidationError('pureVegRestaurant must be a boolean');
            }
        } else {
            throw new ValidationError('pureVegRestaurant must be a boolean');
        }
    }

    if (body.zoneId !== undefined && body.location === undefined) {
        const zoneId = String(body.zoneId || '').trim();
        update.zoneId = isId(zoneId) ? zoneId : null;
    }

    // Bank + UPI fields (Explore -> Update Bank Details page)
    if (body.accountHolderName !== undefined) {
        update.accountHolderName = String(body.accountHolderName || '').trim();
    }
    if (body.accountNumber !== undefined) {
        update.accountNumber = String(body.accountNumber || '').replace(/\s|-/g, '').trim();
    }
    if (body.ifscCode !== undefined) {
        update.ifscCode = String(body.ifscCode || '').trim().toUpperCase();
    }
    if (body.accountType !== undefined) {
        update.accountType = String(body.accountType || '').trim();
    }
    if (body.upiId !== undefined) {
        update.upiId = String(body.upiId || '').trim();
    }
    if (body.upiQrImage !== undefined || body.upiQrCode !== undefined) {
        const qrImage = body.upiQrImage !== undefined ? body.upiQrImage : body.upiQrCode;
        update.upiQrImage = String(qrImage || '').trim();
    }

    if (body.name !== undefined || body.restaurantName !== undefined) {
        const raw = body.name !== undefined ? body.name : body.restaurantName;
        const name = String(raw || '').trim();
        if (!name) {
            throw new ValidationError('Restaurant name cannot be empty');
        }
        const normalizedName = normalizeName(name) || undefined;
        const currentName = String(currentRestaurant.restaurantName || '').trim();
        const currentNormalizedName =
            currentRestaurant.restaurantNameNormalized || normalizeName(currentName) || undefined;

        if (name !== currentName || normalizedName !== currentNormalizedName) {
            update.restaurantName = name;
            update.restaurantNameNormalized = normalizedName;
        }
    }

    if (body.cuisines !== undefined) {
        if (!Array.isArray(body.cuisines)) {
            throw new ValidationError('Cuisines must be an array of strings');
        }
        const cuisines = body.cuisines
            .map((c) => String(c || '').trim())
            .filter(Boolean)
            .slice(0, 50);
        update.cuisines = cuisines;
    }

    if (body.location !== undefined) {
        const loc = body.location && typeof body.location === 'object' ? body.location : null;
        if (!loc) {
            throw new ValidationError('Location must be an object');
        }

        const nextLocation = buildLocationObjectFromInput(loc);
        const lat = toFiniteNumber(nextLocation.latitude);
        const lng = toFiniteNumber(nextLocation.longitude);
        if (lat === null || lng === null) {
            throw new ValidationError('Location latitude and longitude are required');
        }

        const matchedZone = await findMatchedZoneForCoordinates(lat, lng);
        if (!matchedZone?._id) {
            throw new ValidationError('Selected location is outside the service zone. Please pin inside an active zone.');
        }

        const pendingZoneId = String(matchedZone.id);

        // Moving an already-published restaurant is a request, not an edit: the
        // live location keeps serving orders until an admin approves the new one.
        if (hasPublishedRestaurantLocation(currentRestaurant)) {
            Object.assign(update, fromRestaurantLocation(nextLocation, { pending: true }));
            update.pendingZoneId = pendingZoneId;
            update.locationUpdateStatus = 'pending';
            update.locationUpdateRequestedAt = new Date();
            update.locationRejectionReason = '';
            update.locationUpdateReviewedAt = null;
        } else {
            // First time setting a location — nothing to protect, so it goes live.
            // fromRestaurantLocation writes the address columns too, which the
            // Mongo version had to copy across one field at a time.
            Object.assign(update, fromRestaurantLocation(nextLocation));
            update.zoneId = pendingZoneId;
            update.locationUpdateStatus = 'none';
        }
    }

    if (body.openingTime !== undefined) {
        update.openingTime = normalizeRestaurantTime(body.openingTime) || '';
    }
    if (body.closingTime !== undefined) {
        update.closingTime = normalizeRestaurantTime(body.closingTime) || '';
    }
    if (body.openDays !== undefined) {
        if (!Array.isArray(body.openDays)) {
            throw new ValidationError('openDays must be an array');
        }
        update.openDays = body.openDays
            .map((day) => String(day || '').trim())
            .filter(Boolean)
            .slice(0, 7);
    }
    if (body.estimatedDeliveryTime !== undefined) {
        const estimatedDeliveryTimeText = String(body.estimatedDeliveryTime || '').trim();
        update.estimatedDeliveryTime = estimatedDeliveryTimeText;
        update.estimatedDeliveryTimeMinutes = parseEstimatedDeliveryMinutes(estimatedDeliveryTimeText) ?? undefined;
    }

    const openingMinutes = body.openingTime !== undefined ? timeToMinutes(update.openingTime) : null;
    const closingMinutes = body.closingTime !== undefined ? timeToMinutes(update.closingTime) : null;
    if (openingMinutes !== null && closingMinutes !== null) {
        if (openingMinutes === closingMinutes) {
            throw new ValidationError('Opening time and closing time cannot be same');
        }
        if (closingMinutes < openingMinutes) {
            throw new ValidationError('Closing time cannot be less than opening time');
        }
    }

    if (body.menuImages !== undefined) {
        if (!Array.isArray(body.menuImages)) {
            throw new ValidationError('menuImages must be an array');
        }
        const urls = body.menuImages
            .map((m) => toUrl(m))
            .filter(Boolean)
            .slice(0, 20);
        update.menuImages = urls;
    }

    if (body.coverImages !== undefined) {
        if (!Array.isArray(body.coverImages)) {
            throw new ValidationError('coverImages must be an array');
        }
        const urls = body.coverImages
            .map((m) => toUrl(m))
            .filter(Boolean)
            .slice(0, 20);
        update.coverImages = urls;
    }

    if (body.profileImage !== undefined) {
        update.profileImage = toUrl(body.profileImage) || '';
    }

    if (body.panNumber !== undefined) {
        update.panNumber = String(body.panNumber || '').trim().toUpperCase();
    }
    if (body.nameOnPan !== undefined) {
        update.nameOnPan = String(body.nameOnPan || '').trim();
    }
    if (body.panImage !== undefined) {
        update.panImage = toUrl(body.panImage) || '';
    }
    if (body.gstRegistered !== undefined) {
        if (typeof body.gstRegistered === 'boolean') {
            update.gstRegistered = body.gstRegistered;
        } else if (typeof body.gstRegistered === 'string') {
            const normalized = body.gstRegistered.trim().toLowerCase();
            if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
                update.gstRegistered = true;
            } else if (normalized === 'false' || normalized === '0' || normalized === 'no') {
                update.gstRegistered = false;
            } else {
                throw new ValidationError('gstRegistered must be a boolean');
            }
        } else {
            throw new ValidationError('gstRegistered must be a boolean');
        }
    }
    if (body.gstNumber !== undefined) {
        update.gstNumber = String(body.gstNumber || '').trim().toUpperCase();
    }
    if (body.gstLegalName !== undefined) {
        update.gstLegalName = String(body.gstLegalName || '').trim();
    }
    if (body.gstAddress !== undefined) {
        update.gstAddress = String(body.gstAddress || '').trim();
    }
    if (body.gstImage !== undefined) {
        update.gstImage = toUrl(body.gstImage) || '';
    }
    if (body.fssaiNumber !== undefined) {
        update.fssaiNumber = String(body.fssaiNumber || '').trim();
    }
    if (body.fssaiExpiry !== undefined) {
        const rawExpiry = String(body.fssaiExpiry || '').trim();
        if (!rawExpiry) {
            update.fssaiExpiry = null;
        } else {
            const parsedExpiry = new Date(rawExpiry);
            if (Number.isNaN(parsedExpiry.getTime())) {
                throw new ValidationError('FSSAI expiry date is invalid');
            }
            update.fssaiExpiry = parsedExpiry;
        }
    }
    if (body.fssaiImage !== undefined) {
        update.fssaiImage = toUrl(body.fssaiImage) || '';
    }

    if (!Object.keys(update).length) {
        return getCurrentRestaurantProfile(restaurantId);
    }

    // Only move profile to pending review when sensitive business/KYC fields are changed.
    // Operational updates like location/zone/timings should stay visible to users immediately.
    const reviewRequiredFields = new Set([
        'restaurantName',
        'restaurantNameNormalized',
        'ownerName',
        'ownerEmail',
        'ownerPhone',
        'ownerPhoneDigits',
        'ownerPhoneLast10',
        'primaryContactNumber',
        'panNumber',
        'nameOnPan',
        'panImage',
        'gstRegistered',
        'gstNumber',
        'gstLegalName',
        'gstAddress',
        'gstImage',
        'fssaiNumber',
        'fssaiExpiry',
        'fssaiImage',
        'accountHolderName',
        'accountNumber',
        'ifscCode',
        'accountType',
        'upiId',
        'upiQrImage',
        'profileImage',
        'coverImages',
        'menuImages'
    ]);

    const requiresReview = Object.keys(update).some((field) => reviewRequiredFields.has(field));
    const isLocationChangeRequest =
        update.locationUpdateStatus === 'pending' && update.pendingLatitude !== undefined;

    try {
        const doc = await prisma.foodRestaurant.update({
            where: { id: String(restaurantId) },
            // A review-triggering edit clears the previous decision in the same
            // statement, so the restaurant can never sit in `pending` still
            // carrying the approvedAt from its last approval.
            data: requiresReview ? { ...update, ...BACK_TO_REVIEW } : update,
            select: PROFILE_SELECT,
        });

        if (requiresReview && currentRestaurant.status !== 'pending') {
            void notifyAdminsAboutRestaurantProfileReview(
                restaurantId,
                update.restaurantName || currentRestaurant.restaurantName || doc?.restaurantName,
            );
        }

        if (isLocationChangeRequest) {
            void notifyAdminsAboutRestaurantLocationUpdate(
                restaurantId,
                currentRestaurant.restaurantName || doc?.restaurantName,
            );
        }

        return toRestaurantProfile(toRestaurant(doc));
    } catch (err) {
        if (err?.code === 'P2002') {
            throw new ValidationError('A restaurant with this name and phone already exists');
        }
        throw err;
    }
};

/**
 * Editing a photo puts the restaurant back in the admin review queue, and the
 * previous decision has to go with it — otherwise it sits in `pending` still
 * carrying an approvedAt, and the admin screen shows it as both.
 */
const BACK_TO_REVIEW = {
    status: 'pending',
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: '',
};

/** Merge new urls into an existing list, keeping order and dropping repeats. */
const mergeImageUrls = (existing = [], added = [], cap = 20) => {
    const urls = (existing || []).map((image) => toUrl(image)).filter(Boolean);
    for (const url of added) {
        if (!urls.includes(url)) urls.push(url);
    }
    return urls.slice(0, cap);
};

export const uploadRestaurantProfileImage = async (restaurantId, file) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    if (!file?.buffer) throw new ValidationError('Image file is required');
    const id = String(restaurantId);

    const current = await prisma.foodRestaurant.findUnique({
        where: { id },
        select: { restaurantName: true, status: true },
    });
    if (!current) throw new ValidationError('Restaurant not found');

    const url = await uploadImageBuffer(file.buffer, 'food/restaurants/profile');
    await prisma.foodRestaurant.update({
        where: { id },
        data: { profileImage: url, ...BACK_TO_REVIEW },
    });

    // Only tell the admins if this actually re-opened a settled decision.
    if (current.status !== 'pending') {
        void notifyAdminsAboutRestaurantProfileReview(id, current.restaurantName || '');
    }

    return { profileImage: { url } };
};

export const uploadRestaurantMenuImage = async (file) => {
    if (!file?.buffer) throw new ValidationError('Image file is required');
    const url = await uploadImageBuffer(file.buffer, 'food/restaurants/menu');
    return { menuImage: { url, publicId: null } };
};

export const uploadRestaurantCoverImages = async (restaurantId, files = []) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const id = String(restaurantId);

    const validFiles = (Array.isArray(files) ? files : []).filter((file) => file?.buffer);
    if (validFiles.length === 0) {
        throw new ValidationError('At least one valid image file is required');
    }

    const current = await prisma.foodRestaurant.findUnique({
        where: { id },
        select: { restaurantName: true, status: true, profileImage: true, coverImages: true },
    });
    if (!current) throw new ValidationError('Restaurant not found');

    const uploadedUrls = await Promise.all(
        validFiles.slice(0, 20).map((file) => uploadImageBuffer(file.buffer, 'food/restaurants/cover'))
    );

    const data = {
        coverImages: mergeImageUrls(current.coverImages, uploadedUrls),
        ...BACK_TO_REVIEW,
    };
    // A restaurant with no profile picture gets its first cover as one, so the
    // listing card is never blank.
    if (!toUrl(current.profileImage) && uploadedUrls[0]) {
        data.profileImage = uploadedUrls[0];
    }

    await prisma.foodRestaurant.update({ where: { id }, data });

    if (current.status !== 'pending') {
        void notifyAdminsAboutRestaurantProfileReview(id, current.restaurantName || '');
    }

    return {
        coverImages: uploadedUrls.map((url) => ({ url, publicId: null })),
        profileImage: data.profileImage ? { url: data.profileImage } : undefined,
    };
};

export const uploadRestaurantMenuImages = async (restaurantId, files = []) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const id = String(restaurantId);

    const validFiles = (Array.isArray(files) ? files : []).filter((file) => file?.buffer);
    if (validFiles.length === 0) {
        throw new ValidationError('At least one valid image file is required');
    }

    const current = await prisma.foodRestaurant.findUnique({
        where: { id },
        select: { restaurantName: true, status: true, menuImages: true },
    });
    if (!current) throw new ValidationError('Restaurant not found');

    const uploadedUrls = await Promise.all(
        validFiles.slice(0, 20).map((file) => uploadImageBuffer(file.buffer, 'food/restaurants/menu'))
    );

    await prisma.foodRestaurant.update({
        where: { id },
        data: { menuImages: mergeImageUrls(current.menuImages, uploadedUrls), ...BACK_TO_REVIEW },
    });

    if (current.status !== 'pending') {
        void notifyAdminsAboutRestaurantProfileReview(id, current.restaurantName || '');
    }

    return { menuImages: uploadedUrls.map((url) => ({ url, publicId: null })) };
};

/** Restaurant columns the public listing card renders. */
const PUBLIC_CARD_SELECT = {
    id: true, restaurantName: true, area: true, city: true, cuisines: true,
    profileImage: true, coverImages: true, menuImages: true,
    estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
    offer: true, featuredDish: true, featuredPrice: true,
    rating: true, totalRatings: true, isAcceptingOrders: true, status: true,
    pureVegRestaurant: true, createdAt: true,
    openingTime: true, closingTime: true, openDays: true,
    latitude: true, longitude: true, formattedAddress: true,
    addressLine1: true, addressLine2: true, state: true, pincode: true, landmark: true,
};

/** Up to ten recommended dishes per restaurant, in one query for the whole page. */
const attachRecommendedItems = async (restaurants) => {
    const ids = restaurants.map((r) => r.id).filter(Boolean);
    if (!ids.length) return restaurants.map((r) => ({ ...r, recommendedItems: [] }));

    const items = await prisma.foodItem.findMany({
        where: { restaurantId: { in: ids }, isRecommended: true, approvalStatus: 'approved' },
        select: { id: true, restaurantId: true, name: true, price: true, image: true },
        orderBy: { createdAt: 'desc' },
    });

    const byRestaurant = new Map();
    for (const item of items) {
        const list = byRestaurant.get(item.restaurantId) || [];
        if (list.length < 10) {
            // price is Decimal, so it would otherwise reach the client as a string.
            list.push({ id: item.id, name: item.name, price: Number(item.price), image: item.image });
            byRestaurant.set(item.restaurantId, list);
        }
    }

    return restaurants.map((r) => ({ ...r, recommendedItems: byRestaurant.get(r.id) || [] }));
};

/** The card shape the user app reads. */
const toPublicCard = (r) => ({
    ...toRestaurant(r),
    restaurantId: r.id,
    id: r.id,
    // The app reads `name`, and checks `profileImage.url`.
    name: r.restaurantName || '',
    rating: normalizeRatingValue(r.rating),
    totalRatings: normalizeTotalRatingsValue(r.totalRatings),
    profileImage: r.profileImage ? { url: r.profileImage } : null,
    coverImages: Array.isArray(r.coverImages) ? r.coverImages : [],
    menuImages: Array.isArray(r.menuImages) ? r.menuImages : [],
    openingTime: r.openingTime || null,
    closingTime: r.closingTime || null,
    openDays: Array.isArray(r.openDays) ? r.openDays : [],
});

export const listApprovedRestaurants = async (query = {}) => {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 100, 1), 1000);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const AND = [];
    const contains = (value) => ({
        contains: String(value).trim().slice(0, 80),
        mode: 'insensitive',
    });

    if (query.city && String(query.city).trim()) AND.push({ city: contains(query.city) });
    if (query.area && String(query.area).trim()) AND.push({ area: contains(query.area) });

    if (query.cuisine && String(query.cuisine).trim()) {
        const cuisineIds = await restaurantIdsMatchingCuisine(normalizeCuisine(query.cuisine));
        // No match means no results, not "ignore the filter".
        if (!cuisineIds.length) return { restaurants: [], total: 0, page, limit };
        AND.push({ id: { in: cuisineIds } });
    }

    if (query.hasOffers === 'true') {
        const activeOfferFilter = buildActivePublicOfferFilter();
        const [globalOffer, selectedOffers] = await Promise.all([
            prisma.foodOffer.findFirst({
                where: { ...activeOfferFilter, restaurantScope: 'all' },
                select: { id: true },
            }),
            prisma.foodOffer.findMany({
                where: { ...activeOfferFilter, restaurantScope: 'selected' },
                select: { restaurantId: true, restaurantIds: true },
            }),
        ]);

        // A live all-restaurants offer means everyone qualifies, so the filter
        // adds nothing and is skipped entirely.
        if (!globalOffer) {
            const eligibleIds = [
                ...new Set(
                    selectedOffers
                        .flatMap((offer) => [...(offer.restaurantIds || []), offer.restaurantId])
                        .map((id) => String(id || ''))
                        .filter(isId)
                ),
            ];

            AND.push({
                OR: [
                    // A restaurant's own banner text counts as an offer, as before.
                    { offer: { not: null, notIn: [''] } },
                    ...(eligibleIds.length ? [{ id: { in: eligibleIds } }] : []),
                ],
            });
        }
    }

    const minRating = toFiniteNumber(query.minRating);
    if (minRating !== null) AND.push({ rating: { gte: Math.max(0, Math.min(5, minRating)) } });

    const maxDeliveryTime = toFiniteNumber(query.maxDeliveryTime);
    if (maxDeliveryTime !== null) {
        AND.push({ estimatedDeliveryTimeMinutes: { lte: Math.max(0, Math.round(maxDeliveryTime)) } });
    }

    const maxPrice = toFiniteNumber(query.maxPrice);
    if (maxPrice !== null) AND.push({ featuredPrice: { lte: Math.max(0, maxPrice) } });

    if (query.topRated === 'true') AND.push({ rating: { gte: 4.5 } });
    if (query.trusted === 'true') AND.push({ totalRatings: { gte: 100 } });

    if (query.search && String(query.search).trim()) {
        const raw = String(query.search).trim().slice(0, 80);
        if (raw.length >= 2) {
            const cuisineIds = await restaurantIdsMatchingCuisine(raw);
            AND.push({
                OR: [
                    { restaurantName: contains(raw) },
                    { area: contains(raw) },
                    { city: contains(raw) },
                    ...(cuisineIds.length ? [{ id: { in: cuisineIds } }] : []),
                ],
            });
        }
    }

    // A zone filter is strict: only restaurants mapped to that zone.
    const zoneIdRaw = String(query.zoneId || '').trim();
    if (isId(zoneIdRaw)) AND.push({ zoneId: zoneIdRaw });

    const where = { status: 'approved', ...(AND.length ? { AND } : {}) };

    const lat = toFiniteNumber(query.lat);
    const lng = toFiniteNumber(query.lng);
    // radiusKm is preferred; maxDistance is the legacy frontend param.
    const radiusKm = toFiniteNumber(query.radiusKm) ?? toFiniteNumber(query.maxDistance);
    const sortBy = parseSortBy(query.sortBy);

    // Geo is used only when actually asked for, so a restaurant with no
    // coordinates yet is not silently dropped from the default listing.
    const wantsGeo = radiusKm !== null || sortBy === 'nearest';

    const finish = async (rows, total) => {
        const withRecommended = await attachRecommendedItems(rows);
        const withOffers = await attachPublicOffersToRestaurants(withRecommended);
        const withTimings = await attachOutletTimingsToRestaurants(withOffers);
        return {
            restaurants: withTimings.map((r) => normalizePublicRestaurantGeo(r, lat, lng)),
            total,
            page,
            limit,
        };
    };

    if (lat !== null && lng !== null && wantsGeo) {
        // $geoNear became an indexed ST_DWithin. Postgres cannot order by a
        // distance this query did not compute, so the neighbourhood is resolved
        // first and the remaining filters applied to it.
        const near = await restaurantsNearPoint(lat, lng, radiusKm);
        if (!near.length) return { restaurants: [], total: 0, page, limit };

        const distanceById = new Map(near.map((row) => [row.id, row.distanceInKm]));

        // ponytail: the radius set is fetched whole and paginated in memory,
        // because ordering by distance and by rating together cannot be pushed
        // down. Bounded by the radius and a 2,000-row cap; if one radius ever
        // holds more than that, this wants a materialised distance column.
        const rows = await prisma.foodRestaurant.findMany({
            where: { ...where, id: { in: [...distanceById.keys()] } },
            select: PUBLIC_CARD_SELECT,
        });

        const byDistance = (a, b) =>
            (distanceById.get(a.id) ?? Infinity) - (distanceById.get(b.id) ?? Infinity);

        const sorters = {
            rating: (a, b) => b.rating - a.rating || byDistance(a, b),
            'rating-high': (a, b) => b.rating - a.rating || byDistance(a, b),
            'rating-low': (a, b) => a.rating - b.rating || byDistance(a, b),
            'price-low': (a, b) =>
                Number(a.featuredPrice) - Number(b.featuredPrice) || byDistance(a, b),
            'price-high': (a, b) =>
                Number(b.featuredPrice) - Number(a.featuredPrice) || byDistance(a, b),
            newest: (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
            deliveryTime: (a, b) =>
                (a.estimatedDeliveryTimeMinutes ?? Infinity) -
                    (b.estimatedDeliveryTimeMinutes ?? Infinity) || byDistance(a, b),
        };

        const sorted = rows
            .map((r) => ({ ...toPublicCard(r), distanceInKm: distanceById.get(r.id) ?? null }))
            .sort(sorters[sortBy] || byDistance);

        return finish(sorted.slice(skip, skip + limit), sorted.length);
    }

    // Non-geo path: the database sorts and paginates.
    const orderBy =
        {
            rating: [{ rating: 'desc' }, { createdAt: 'desc' }],
            'rating-high': [{ rating: 'desc' }, { createdAt: 'desc' }],
            'rating-low': [{ rating: 'asc' }, { createdAt: 'desc' }],
            'price-low': [{ featuredPrice: 'asc' }, { createdAt: 'desc' }],
            'price-high': [{ featuredPrice: 'desc' }, { createdAt: 'desc' }],
            deliveryTime: [{ estimatedDeliveryTimeMinutes: 'asc' }, { createdAt: 'desc' }],
        }[sortBy] || [{ createdAt: 'desc' }];

    const [rows, total] = await Promise.all([
        prisma.foodRestaurant.findMany({
            where,
            select: PUBLIC_CARD_SELECT,
            orderBy,
            skip,
            take: limit,
        }),
        prisma.foodRestaurant.count({ where }),
    ]);

    return finish(rows.map(toPublicCard), total);
};

export const getApprovedRestaurantByIdOrSlug = async (idOrSlug) => {
    const value = String(idOrSlug || '').trim();
    if (!value) return null;

    // Either an id or a slug; the slug matches on the normalised name column,
    // which is indexed, rather than lowercasing the name at query time.
    const where = isId(value)
        ? { id: value, status: 'approved' }
        : { restaurantNameNormalized: normalizeName(value), status: 'approved' };

    if (!isId(value) && !where.restaurantNameNormalized) return null;

    const doc = await prisma.foodRestaurant.findFirst({ where });
    if (!doc) return null;

    const [withTimings] = await attachOutletTimingsToRestaurants([
        normalizePublicRestaurantGeo(
            stripPendingLocationFromPublicRestaurant({
                ...toRestaurant(doc),
                rating: normalizeRatingValue(doc.rating),
                totalRatings: normalizeTotalRatingsValue(doc.totalRatings),
            }),
        ),
    ]);
    return withTimings;
};

export const listPublicOffers = async (query = {}) => {
    const { subtotal, restaurantId, userId } = query;
    const now = new Date();
    const filter = buildActivePublicOfferFilter(now);

    // Global coupons, or ones naming this restaurant.
    if (isId(restaurantId)) {
        filter.AND.push({
            OR: [
                { restaurantScope: 'all' },
                {
                    restaurantScope: 'selected',
                    OR: [
                        { restaurantIds: { has: String(restaurantId) } },
                        { restaurantId: String(restaurantId) },
                    ],
                },
            ],
        });
    }

    // A returning customer does not see first-order-only coupons.
    if (isId(userId)) {
        const orderCount = await prisma.foodOrder.count({ where: { userId: String(userId) } });
        if (orderCount > 0) {
            // The enum's Prisma name is first_time; 'first-time' is its @map.
            filter.AND.push({ customerScope: { not: 'first_time' }, isFirstOrderOnly: false });
        }
    }

    if (subtotal !== undefined && subtotal !== null && subtotal !== '' && !isNaN(Number(subtotal))) {
        const numericSubtotal = Number(subtotal);
        if (numericSubtotal > 0) {
            filter.AND.push({ OR: [{ minOrderValue: null }, { minOrderValue: { lte: numericSubtotal } }] });
        }
    }

    const list = await prisma.foodOffer.findMany({
        where: filter,
        orderBy: { createdAt: 'desc' },
    });

    // restaurantIds is a plain array column, so the second .populate() has no
    // relation to walk. Every named restaurant across every offer is fetched
    // once here instead.
    const namedIds = [
        ...new Set(
            list
                .flatMap((offer) => [...(offer.restaurantIds || []), offer.restaurantId])
                .map((id) => String(id || ''))
                .filter(isId)
        ),
    ];
    const namedRestaurants = namedIds.length
        ? await prisma.foodRestaurant.findMany({
            where: { id: { in: namedIds } },
            select: {
                id: true, restaurantName: true, restaurantNameNormalized: true,
                profileImage: true, estimatedDeliveryTime: true, rating: true,
            },
        })
        : [];
    const restaurantById = new Map(namedRestaurants.map((r) => [r.id, r]));

    let allOffers = list.map((o) => {
        const selectedIds = (o.restaurantIds || []).length
            ? o.restaurantIds.map(String)
            : o.restaurantId ? [String(o.restaurantId)] : [];
        const selectedRestaurants = selectedIds.map((id) => restaurantById.get(id)).filter(Boolean);

        // Prefer the restaurant the caller asked about, so its own name and
        // rating appear on the card rather than an arbitrary other outlet's.
        const restaurant =
            selectedRestaurants.find((item) => item.id === String(restaurantId || '')) ||
            selectedRestaurants[0] ||
            null;

        const restaurantName =
            o.restaurantScope === 'selected'
                ? restaurant?.restaurantName || 'Selected Restaurants'
                : 'All Restaurants';

        const discountValue = Number(o.discountValue) || 0;
        const title =
            o.discountType === 'percentage' ? `${discountValue}% OFF` : `Flat ₹${discountValue} OFF`;

        return {
            id: o.id,
            offerId: o.id,
            couponCode: o.couponCode,
            title,
            discountType: o.discountType,
            discountValue,
            maxDiscount: o.maxDiscount === null ? null : Number(o.maxDiscount),
            perUserLimit: o.perUserLimit ?? null,
            customerScope: o.customerScope,
            isFirstOrderOnly: !!o.isFirstOrderOnly,
            restaurantScope: o.restaurantScope,
            restaurantId:
                restaurant?.id || (o.restaurantScope === 'selected' ? o.restaurantId : null),
            restaurantIds: selectedIds,
            restaurantName,
            restaurantSlug: restaurant?.restaurantNameNormalized || undefined,
            restaurantImage: restaurant?.profileImage || null,
            deliveryTime: restaurant?.estimatedDeliveryTime || null,
            restaurantRating: Number(restaurant?.rating) || 0,
            endDate: o.endDate || null,
            showInCart: o.showInCart !== false,
            minOrderValue: Number(o.minOrderValue) || 0,
        };
    });

    // Drop coupons this user has already used up.
    if (isId(userId)) {
        const usages = await prisma.foodOfferUsage.findMany({
            where: { userId: String(userId) },
            select: { offerId: true, count: true },
        });
        const usageMap = new Map(usages.map((u) => [u.offerId, Number(u.count || 0)]));

        allOffers = allOffers.filter((o) => {
            const perUserLimit = Number(o.perUserLimit || 0);
            if (perUserLimit <= 0) return true;
            return (usageMap.get(o.id) || 0) < perUserLimit;
        });
    }

    return { allOffers, groupedByOffer: {} };
};

export const getRestaurantComplaints = async (restaurantId, query = {}) => {
    const { getRestaurantComplaints: getComplaintsInternal } = await import('../../admin/services/admin.service.js');
    return getComplaintsInternal({ ...query, restaurantId });
};


/**
 * Create a new offer for a restaurant.
 */
export async function createRestaurantOffer(restaurantId, body) {
    try {
        return await prisma.foodOffer.create({
            data: {
                couponCode: body.couponCode,
                discountType: body.discountType,
                discountValue: body.discountValue,
                customerScope: body.customerScope || 'all',
                restaurantScope: 'selected',
                restaurantId: String(restaurantId),
                minOrderValue: body.minOrderValue ?? 0,
                maxDiscount: body.maxDiscount ?? null,
                usageLimit: body.usageLimit ?? null,
                perUserLimit: body.perUserLimit ?? null,
                startDate: body.startDate ? new Date(body.startDate) : null,
                endDate: body.endDate ? new Date(body.endDate) : null,
                isFirstOrderOnly: body.isFirstOrderOnly ?? false,
                // An offer created already expired starts inactive rather than
                // appearing live for the instant before a job catches it.
                status:
                    body.endDate && new Date(body.endDate).getTime() <= Date.now()
                        ? 'inactive'
                        : 'active',
                showInCart: true,
                createdByRole: 'RESTAURANT',
                // A restaurant-funded offer: the platform contributes nothing.
                adminBearPercentage: 0,
                restaurantBearPercentage: 100,
            },
        });
    } catch (error) {
        // couponCode is unique in the database. Checking first and then
        // inserting let two restaurants claim the same code concurrently.
        if (error?.code === 'P2002') throw new ValidationError('Coupon code already exists');
        throw error;
    }
}

/**
 * List offers for a specific restaurant.
 */
export async function listRestaurantOffers(restaurantId) {
    const list = await prisma.foodOffer.findMany({
        where: { restaurantId: String(restaurantId), restaurantScope: 'selected' },
        orderBy: { createdAt: 'desc' },
    });

    return list.map((offer) => ({ ...offer, id: offer.id, offerId: offer.id }));
}

/**
 * Delete a restaurant offer.
 */
export async function deleteRestaurantOffer(restaurantId, offerId) {
    if (!isId(offerId)) throw new NotFoundError('Offer not found or not owned by you');

    // The ownership clause is part of the delete, not a lookup before it, so a
    // restaurant cannot delete another's offer by racing the check.
    const { count } = await prisma.foodOffer.deleteMany({
        where: {
            id: String(offerId),
            restaurantId: String(restaurantId),
            createdByRole: 'RESTAURANT',
        },
    });
    if (count === 0) throw new NotFoundError('Offer not found or not owned by you');
    return true;
}

/**
 * Toggle status of a restaurant offer.
 */
export async function updateRestaurantOfferStatus(restaurantId, offerId, status) {
    const allowedStatus = ['active', 'paused', 'inactive'];
    if (!allowedStatus.includes(status)) throw new ValidationError('Invalid status');
    if (!isId(offerId)) throw new NotFoundError('Offer not found or not owned by you');

    const where = {
        id: String(offerId),
        restaurantId: String(restaurantId),
        createdByRole: 'RESTAURANT',
    };

    const { count } = await prisma.foodOffer.updateMany({ where, data: { status } });
    if (count === 0) throw new NotFoundError('Offer not found or not owned by you');

    return prisma.foodOffer.findUnique({ where: { id: String(offerId) } });
}

/**
 * Permanently delete a restaurant and everything it owns.
 *
 * Mongo deleted the restaurant and left its orders, transactions, invoices and
 * support tickets pointing at an id that no longer existed. Those are the
 * platform's books, not the restaurant's, so they are checked for rather than
 * destroyed: a restaurant that has ever traded cannot be erased.
 *
 * What the restaurant genuinely owns — its dishes, addons, timings, banners —
 * goes with it, most of it through ON DELETE CASCADE.
 */
export const deleteCurrentRestaurantAccount = async (restaurantId) => {
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant id');
    const id = String(restaurantId);

    const restaurant = await prisma.foodRestaurant.findUnique({ where: { id } });
    if (!restaurant) throw new NotFoundError('Restaurant not found');

    const [orders, transactions, invoices] = await Promise.all([
        prisma.foodOrder.count({ where: { restaurantId: id } }),
        prisma.foodTransaction.count({ where: { restaurantId: id } }),
        prisma.foodSubscriptionInvoice.count({ where: { restaurantId: id } }),
    ]);

    if (orders || transactions || invoices) {
        throw new ValidationError(
            'This restaurant has order or billing history and cannot be deleted. Contact support to close the account instead.',
        );
    }

    await prisma.$transaction(async (tx) => {
        // Categories the restaurant created are its own; the FK is RESTRICT
        // because a global category must never vanish with one restaurant.
        await tx.foodCategory.deleteMany({ where: { restaurantId: id } });
        await tx.foodCategory.updateMany({
            where: { createdByRestaurantId: id },
            data: { createdByRestaurantId: null },
        });
        await tx.foodOffer.deleteMany({ where: { restaurantId: id } });
        await tx.foodSupportTicket.deleteMany({ where: { restaurantId: id } });
        await tx.foodRestaurantSupportTicket.deleteMany({ where: { restaurantId: id } });
        await tx.feedbackExperience.deleteMany({ where: { restaurantId: id } });
        await tx.foodRestaurantWithdrawal.deleteMany({ where: { restaurantId: id } });
        await tx.foodSubscriptionTransaction.deleteMany({ where: { restaurantId: id } });
        await tx.foodRestaurantSubscriptionHistory.deleteMany({ where: { restaurantId: id } });

        // Dishes, addons, outlet timings, banners, dining and gourmet entries
        // all cascade from this.
        await tx.foodRestaurant.delete({ where: { id } });
    });

    return { success: true };
};
