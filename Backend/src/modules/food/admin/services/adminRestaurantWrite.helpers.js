import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Shared parsing for the admin restaurant write paths.
 *
 * These are pure, and both the create and the edit path need them, so they sit
 * beside the service that uses them rather than inside it.
 */

export const DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const parseBooleanLike = (value, fieldName) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes', 'y', 'on', 'active'].includes(normalized)) return true;
        if (['false', '0', 'no', 'n', 'off', 'inactive'].includes(normalized)) return false;
    }
    throw new ValidationError(`${fieldName} must be a boolean`);
};

export const toFiniteNumber = (value) => {
    if (value === null || value === undefined || value === '') return null;
    const num = typeof value === 'number' ? value : Number(String(value).trim());
    return Number.isFinite(num) ? num : null;
};

export const normalizeRestaurantTime = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return '';

    const toHHMM = (hour, minute) => {
        const h = Number(hour);
        const m = Number(minute);
        if (!Number.isFinite(h) || !Number.isFinite(m)) return '';
        if (h < 0 || h > 23 || m < 0 || m > 59) return '';
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    };

    const hhmm = raw.match(/^(\d{1,2}):(\d{2})$/);
    if (hhmm) return toHHMM(hhmm[1], hhmm[2]);

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

export const timeToMinutes = (value) => {
    const normalized = normalizeRestaurantTime(value);
    if (!normalized) return null;
    const [h, m] = normalized.split(':').map(Number);
    if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
    return h * 60 + m;
};

export const validateOpeningClosingTimes = (openingTime, closingTime) => {
    const open = timeToMinutes(openingTime);
    const close = timeToMinutes(closingTime);
    if (open === null || close === null) return;
    if (open === close) {
        throw new ValidationError('Opening time and closing time cannot be same');
    }
    if (close < open) {
        throw new ValidationError('Closing time cannot be less than opening time');
    }
};

export const normalizeDayName = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return null;
    const exact = DAY_NAMES.find((d) => d.toLowerCase() === raw.toLowerCase());
    if (exact) return exact;
    const abbr = raw.slice(0, 3).toLowerCase();
    return DAY_NAMES.find((d) => d.toLowerCase().startsWith(abbr)) || null;
};
