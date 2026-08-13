import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { invalidateCache } from '../../../../middleware/cache.js';
import { getRestaurantLocalTimeParts } from '../../../../utils/timezone.js';

const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const normalizeDay = (value) => {
    const v = String(value || '').trim();
    if (!v) return null;
    const exact = DAY_NAMES.find((d) => d.toLowerCase() === v.toLowerCase());
    if (exact) return exact;
    const abbr = v.slice(0, 3).toLowerCase();
    const match = DAY_NAMES.find((d) => d.toLowerCase().startsWith(abbr));
    return match || null;
};

const normalizeTime = (value, fallback) => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    // Accept "HH:mm" or "H:mm"
    const m = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return fallback;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h < 0 || h > 23 || min < 0 || min > 59) return fallback;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
};

const defaultTimings = () =>
    DAY_NAMES.map((day) => ({
        day,
        isOpen: true,
        openingTime: '09:00',
        closingTime: '22:00'
    }));

const toClientShape = (doc) => {
    const timings = Array.isArray(doc?.timings) ? doc.timings : [];
    const map = {};
    for (const day of DAY_NAMES) {
        const found = timings.find((t) => normalizeDay(t?.day) === day);
        const isOpen = found ? found.isOpen !== false : true;
        map[day] = {
            isOpen,
            openingTime: isOpen ? normalizeTime(found?.openingTime, '09:00') : '',
            closingTime: isOpen ? normalizeTime(found?.closingTime, '22:00') : ''
        };
    }
    return map;
};

export async function getOutletTimingsForRestaurant(restaurantId) {
    if (!isId(restaurantId)) {
        throw new ValidationError('Invalid restaurant id');
    }
    const doc = await prisma.foodRestaurantOutletTimings.findUnique({
        where: { restaurantId: String(restaurantId) },
        select: { timings: true, updatedAt: true }
    });
    if (!doc) return { outletTimings: toClientShape({ timings: defaultTimings() }) };
    return { outletTimings: toClientShape(doc) };
}

export async function upsertOutletTimingsForRestaurant(restaurantId, outletTimings) {
    if (!isId(restaurantId)) {
        throw new ValidationError('Invalid restaurant id');
    }
    if (!outletTimings || typeof outletTimings !== 'object' || Array.isArray(outletTimings)) {
        throw new ValidationError('outletTimings must be an object keyed by day name');
    }

    const timings = DAY_NAMES.map((day) => {
        const src = outletTimings[day] && typeof outletTimings[day] === 'object' ? outletTimings[day] : {};
        const isOpen = src.isOpen !== false;
        return {
            day,
            isOpen,
            openingTime: isOpen ? normalizeTime(src.openingTime, '09:00') : '',
            closingTime: isOpen ? normalizeTime(src.closingTime, '22:00') : ''
        };
    });

    const id = String(restaurantId);
    const doc = await prisma.foodRestaurantOutletTimings.upsert({
        where: { restaurantId: id },
        create: { restaurantId: id, timings },
        update: { timings },
        select: { timings: true, updatedAt: true }
    });

    const { dayName: currentDayName } = getRestaurantLocalTimeParts(new Date());
    const todayData = timings.find(t => t.day === currentDayName) || timings.find(t => t.isOpen) || timings[0];

    if (todayData) {
        await prisma.foodRestaurant.update({
            where: { id },
            data: {
                openingTime: todayData.openingTime,
                closingTime: todayData.closingTime,
                openDays: timings.filter(t => t.isOpen).map(t => t.day)
            }
        });
    }

    // Invalidate public caches so changes reflect immediately for users
    void invalidateCache('restaurants:*');
    void invalidateCache('restaurant_detail:*');
    void invalidateCache('restaurant_timings:*');

    return { outletTimings: toClientShape(doc) };
}

export async function getOutletTimingsMapForRestaurants(restaurantIds = [], options = {}) {
    const ids = [
        ...new Set(
            (restaurantIds || [])
                .map((id) => String(id || '').trim())
                .filter(isId)
        )
    ];

    if (!ids.length) return new Map();

    const useDefaults = options?.useDefaults !== false;
    const defaultShape = toClientShape({ timings: defaultTimings() });
    const docs = await prisma.foodRestaurantOutletTimings.findMany({
        where: { restaurantId: { in: ids } },
        select: { restaurantId: true, timings: true }
    });

    const map = useDefaults ? new Map(ids.map((id) => [id, defaultShape])) : new Map();
    for (const doc of docs) {
        map.set(doc.restaurantId, toClientShape(doc));
    }
    return map;
}

export async function attachOutletTimingsToRestaurants(restaurants = [], options = {}) {
    if (!Array.isArray(restaurants) || restaurants.length === 0) return restaurants;

    const useDefaults = options?.useDefaults !== false;
    const map = await getOutletTimingsMapForRestaurants(
        restaurants.map((r) => r._id || r.id || r.restaurantId),
        { useDefaults },
    );

    return restaurants.map((r) => {
        const key = String(r._id || r.id || r.restaurantId || '');
        return {
            ...r,
            outletTimings: map.get(key) || null
        };
    });
}

