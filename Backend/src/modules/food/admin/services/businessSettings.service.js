import { prisma } from '../../../../config/prisma.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { uploadImageBufferDetailed } from '../../../../services/cloudinary.service.js';

/**
 * The platform's own identity: company details, the three apps' logos, their
 * theme, and how long a restaurant has to accept an order.
 *
 * One row, all flat columns with defaults. The Mongo version stored `phone`,
 * each logo and the whole `powerScanning` block as sub-documents, which is why
 * every read used to repair rows that were missing them; a column with a
 * default cannot be missing, so all of that is gone.
 */

const FONT_OPTIONS = [
    'Poppins', 'Outfit', 'Inter', 'Roboto', 'Montserrat',
    'Nunito', 'Open Sans', 'Lato', 'Manrope', 'Raleway',
    'Merriweather', 'Playfair Display', 'Ubuntu', 'Rubik', 'Work Sans',
];

/** The three apps, and the column prefix each one's theme lives under. */
const APPS = ['user', 'restaurant', 'delivery'];

/** Each upload field, and the columns plus Cloudinary folder it maps to. */
const IMAGE_FIELDS = {
    logo: { url: 'logoUrl', publicId: 'logoPublicId', folder: 'business/logos' },
    favicon: { url: 'faviconUrl', publicId: 'faviconPublicId', folder: 'business/favicons' },
    restaurantLogo: {
        url: 'restaurantLogoUrl', publicId: 'restaurantLogoPublicId',
        folder: 'business/restaurant/logos',
    },
    restaurantFavicon: {
        url: 'restaurantFaviconUrl', publicId: 'restaurantFaviconPublicId',
        folder: 'business/restaurant/favicons',
    },
    deliveryLogo: {
        url: 'deliveryLogoUrl', publicId: 'deliveryLogoPublicId',
        folder: 'business/delivery/logos',
    },
    deliveryFavicon: {
        url: 'deliveryFaviconUrl', publicId: 'deliveryFaviconPublicId',
        folder: 'business/delivery/favicons',
    },
};

const normalizeHexColor = (value, fallback) => {
    const raw = String(value || '').trim();
    if (!raw) return fallback;
    const normalized = raw.startsWith('#') ? raw : `#${raw}`;
    return /^#[0-9A-Fa-f]{6}$/.test(normalized) ? normalized.toUpperCase() : fallback;
};

const normalizeFontFamily = (value, fallback) => {
    const raw = String(value || '').trim();
    return FONT_OPTIONS.includes(raw) ? raw : fallback;
};

/** The apps read one nested block; the columns are flat. */
const toPowerScanning = (row) => Object.fromEntries(
    APPS.map((app) => [app, {
        themeColor: row[`${app}ThemeColor`],
        fontFamily: row[`${app}FontFamily`],
    }])
);

/** The panel still expects the sub-document shape Mongo used. */
const serialize = (row) => ({
    ...row,
    _id: row.id,
    phone: { countryCode: row.phoneCountryCode, number: row.phoneNumber },
    logo: { url: row.logoUrl, publicId: row.logoPublicId },
    favicon: { url: row.faviconUrl, publicId: row.faviconPublicId },
    restaurantLogo: { url: row.restaurantLogoUrl, publicId: row.restaurantLogoPublicId },
    restaurantFavicon: { url: row.restaurantFaviconUrl, publicId: row.restaurantFaviconPublicId },
    deliveryLogo: { url: row.deliveryLogoUrl, publicId: row.deliveryLogoPublicId },
    deliveryFavicon: { url: row.deliveryFaviconUrl, publicId: row.deliveryFaviconPublicId },
    powerScanning: toPowerScanning(row),
});

/** The settings row, created on first read. There is only ever one. */
const loadRow = async () =>
    (await prisma.foodBusinessSettings.findFirst()) ?? prisma.foodBusinessSettings.create({ data: {} });

export const getBusinessSettings = async () => serialize(await loadRow());

export const getPowerScanningSettings = async () => toPowerScanning(await loadRow());

export const updatePowerScanningSettings = async (payload = {}) => {
    const row = await loadRow();

    // Anything unrecognised keeps the colour or font already saved, so a partial
    // or malformed post cannot reset an app's branding.
    const data = {};
    for (const app of APPS) {
        data[`${app}ThemeColor`] = normalizeHexColor(payload?.[app]?.themeColor, row[`${app}ThemeColor`]);
        data[`${app}FontFamily`] = normalizeFontFamily(payload?.[app]?.fontFamily, row[`${app}FontFamily`]);
    }

    const updated = await prisma.foodBusinessSettings.update({ where: { id: row.id }, data });
    return toPowerScanning(updated);
};

const acceptancePayload = (minutes) => ({
    orderAcceptanceTimeMinutes: minutes,
    acceptanceWindowSeconds: minutes * 60,
});

export const getOrderAcceptanceSettings = async () =>
    acceptancePayload((await loadRow()).orderAcceptanceTimeMinutes);

export const updateOrderAcceptanceSettings = async (rawMinutes) => {
    const numeric = Number(rawMinutes);
    if (!Number.isFinite(numeric)) throw new ValidationError('Order acceptance time is required');

    const minutes = Math.round(numeric);
    if (minutes < 1 || minutes > 20) {
        throw new ValidationError('Order acceptance time must be between 1 and 20 minutes');
    }

    const row = await loadRow();
    await prisma.foodBusinessSettings.update({
        where: { id: row.id },
        data: { orderAcceptanceTimeMinutes: minutes },
    });
    return acceptancePayload(minutes);
};

const validate = ({ companyName, email, phoneNumber, address, state, pincode }) => {
    const name = String(companyName || '').trim();
    if (name.length < 2 || name.length > 50) {
        throw new ValidationError('Company name must be between 2 and 50 characters');
    }
    const mail = String(email || '').trim();
    if (!mail || mail.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) {
        throw new ValidationError('Invalid email address (max 100 characters)');
    }
    if (!/^\d{7,15}$/.test(String(phoneNumber || '').trim())) {
        throw new ValidationError('Invalid phone number (7-15 digits required)');
    }
    if (address && String(address).length > 250) {
        throw new ValidationError('Address is too long (max 250 characters)');
    }
    if (state && String(state).length > 50) {
        throw new ValidationError('State name is too long (max 50 characters)');
    }
    if (pincode && !/^\d{4,10}$/.test(String(pincode).trim())) {
        throw new ValidationError('Invalid pincode (4-10 digits required)');
    }
};

export const updateBusinessSettings = async (body = {}, files = null) => {
    validate(body);

    const data = {
        companyName: String(body.companyName).trim(),
        email: String(body.email).trim(),
        phoneNumber: String(body.phoneNumber).trim(),
    };
    if (body.phoneCountryCode) data.phoneCountryCode = String(body.phoneCountryCode).trim();
    if (body.address !== undefined) data.address = String(body.address || '');
    if (body.state !== undefined) data.state = String(body.state || '');
    if (body.pincode !== undefined) data.pincode = String(body.pincode || '');
    if (body.region) data.region = String(body.region);

    // Uploaded one at a time on purpose: six parallel uploads of the same
    // multipart request is a lot of outbound bandwidth for a settings save.
    for (const [field, columns] of Object.entries(IMAGE_FIELDS)) {
        const file = files?.[field]?.[0];
        if (!file?.buffer) continue;

        const result = await uploadImageBufferDetailed(file.buffer, columns.folder);
        data[columns.url] = result.secure_url;
        data[columns.publicId] = result.public_id;
    }

    const row = await loadRow();
    return serialize(await prisma.foodBusinessSettings.update({ where: { id: row.id }, data }));
};
