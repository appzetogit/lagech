/**
 * Columns and per-row checks for the admin bulk import/export of categories,
 * add-ons and restaurants.
 *
 * Pure: no database, so every rule here is unit-tested directly. A row either
 * comes back as `{ value }` ready for the service to write, or as `{ errors }`
 * naming every problem in it, so one upload tells the admin everything that
 * needs fixing instead of one mistake at a time.
 *
 * Headers are matched by text, ignoring case, spacing and the "*" that marks a
 * required column, so a re-saved sheet with tidied headers still imports.
 */
import { headerKey } from '../../shared/sheet.util.js';

const ID = /^[a-f0-9]{24}$/i;
const TIME = /^([01]?\d|2[0-3]):([0-5]\d)$/;
const PHONE = /^\+?[\d\s-]{10,16}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const YES = new Set(['yes', 'y', 'true', '1', 'active', 'on']);
const NO = new Set(['no', 'n', 'false', '0', 'inactive', 'off']);

/** "Yes"/"No" (and true/false, 1/0); blank gives the fallback. */
export function parseYesNo(raw, fallback, label, errors) {
    const value = String(raw ?? '').trim().toLowerCase();
    if (!value) return fallback;
    if (YES.has(value)) return true;
    if (NO.has(value)) return false;
    errors.push(`${label} must be Yes or No`);
    return fallback;
}

const read = (data, header) => String(data[headerKey(header)] ?? '').trim();

const mediaUrl = (raw, label, errors) => {
    if (!raw) return '';
    if (!/^(https?:\/\/|\/uploads\/)/i.test(raw)) {
        errors.push(`${label} must be a web address (https://...) or an uploaded file path`);
        return '';
    }
    return raw;
};

const number = (raw, label, errors, { min = 0, integer = false, required = false } = {}) => {
    if (raw === '') {
        if (required) errors.push(`${label} is required`);
        return null;
    }
    const n = Number(String(raw).replace(/,/g, ''));
    if (!Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) {
        errors.push(`${label} must be ${integer ? 'a whole number' : 'a number'}${min === 0 ? ' of 0 or more' : ''}`);
        return null;
    }
    return n;
};

const optionalId = (raw, label, errors) => {
    if (!raw) return null;
    if (!ID.test(raw)) {
        errors.push(`${label} is not a valid id (leave it blank to add a new row)`);
        return null;
    }
    return raw.toLowerCase();
};

const result = (value, errors) => (errors.length ? { errors } : { value });

// ─── categories ──────────────────────────────────────────────────────────────

export const CATEGORY_COLUMNS = [
    'Id', 'Name*', 'Parent Category', 'Food Type (Veg/Non-Veg/Both)', 'Zone', 'Image URL', 'Sort Order', 'Active (Yes/No)',
];

export const CATEGORY_NOTES = [
    ['Id', 'Leave blank to add a new category. Keep the id from an export to update that category.'],
    ['Name*', 'Category name, up to 200 characters.'],
    ['Parent Category', 'Name of an existing top-level category to make this a sub-category. Blank = top-level.'],
    ['Food Type', 'Veg, Non-Veg or Both. Blank = Both (or the parent\'s type).'],
    ['Zone', 'Zone name to show the category only there. Blank = every zone. A sub-category always takes its parent\'s zone.'],
    ['Image URL', 'Optional https:// link or uploaded file path.'],
    ['Sort Order', 'Whole number; lower shows first. Blank = 0.'],
    ['Active', 'Yes or No. Blank = Yes.'],
];

const FOOD_TYPE_SCOPES = { veg: 'Veg', 'non-veg': 'Non-Veg', nonveg: 'Non-Veg', 'non veg': 'Non-Veg', both: 'Both' };

export function validateCategoryRow(data) {
    const errors = [];
    const id = optionalId(read(data, 'Id'), 'Id', errors);
    const name = read(data, 'Name');
    if (!name) errors.push('Name is required');
    else if (name.length > 200) errors.push('Name must be 200 characters or fewer');

    const scopeRaw = read(data, 'Food Type (Veg/Non-Veg/Both)').toLowerCase();
    let foodTypeScope;
    if (scopeRaw) {
        foodTypeScope = FOOD_TYPE_SCOPES[scopeRaw];
        if (!foodTypeScope) errors.push('Food Type must be Veg, Non-Veg or Both');
    }
    const sortOrder = number(read(data, 'Sort Order'), 'Sort Order', errors, { integer: true, min: -100000 });
    const isActive = parseYesNo(read(data, 'Active (Yes/No)'), true, 'Active', errors);
    return result({
        id,
        name,
        parentName: read(data, 'Parent Category'),
        zoneName: read(data, 'Zone'),
        image: mediaUrl(read(data, 'Image URL'), 'Image URL', errors),
        ...(foodTypeScope ? { foodTypeScope } : {}),
        sortOrder: sortOrder ?? 0,
        isActive,
    }, errors);
}

const SCOPE_LABEL = { Veg: 'Veg', NonVeg: 'Non-Veg', 'Non-Veg': 'Non-Veg', Both: 'Both' };

export const categoryExportRow = (c) => [
    c.id,
    c.name,
    c.parent?.name || '',
    SCOPE_LABEL[c.foodTypeScope] || 'Both',
    c.zone?.name || c.zone?.zoneName || '',
    c.image || '',
    c.sortOrder ?? 0,
    c.isActive === false ? 'No' : 'Yes',
];

// ─── add-ons ─────────────────────────────────────────────────────────────────

export const ADDON_COLUMNS = [
    'Id', 'Restaurant Id*', 'Restaurant Name', 'Name*', 'Price*', 'Food Type (Veg/Non-Veg)', 'Description',
    'Group Name', 'Addon Category', 'Image URL', 'Available (Yes/No)',
];

export const ADDON_NOTES = [
    ['Id', 'Leave blank to add a new add-on. Keep the id from an export to update that add-on.'],
    ['Restaurant Id*', 'The restaurant\'s id, as shown in a restaurant export.'],
    ['Restaurant Name', 'For reading only; ignored on import.'],
    ['Name*', 'Add-on name, unique within the restaurant.'],
    ['Price*', 'Price in rupees, 0 or more.'],
    ['Food Type', 'Veg or Non-Veg. Blank = Veg.'],
    ['Group Name', 'Optional heading the add-on is shown under in the app ("Extra toppings").'],
    ['Addon Category', 'Name of an existing addon category. Blank = none.'],
    ['Image URL', 'Optional https:// link or uploaded file path.'],
    ['Available', 'Yes or No. Blank = Yes.'],
];

export function validateAddonRow(data) {
    const errors = [];
    const id = optionalId(read(data, 'Id'), 'Id', errors);
    const restaurantId = read(data, 'Restaurant Id');
    if (!restaurantId) errors.push('Restaurant Id is required');
    else if (!ID.test(restaurantId)) errors.push('Restaurant Id is not a valid id');
    const name = read(data, 'Name');
    if (!name) errors.push('Name is required');
    else if (name.length > 120) errors.push('Name must be 120 characters or fewer');
    const price = number(read(data, 'Price'), 'Price', errors, { required: true });
    const typeRaw = read(data, 'Food Type (Veg/Non-Veg)').toLowerCase().replace(/\s+/g, '-');
    let foodType = 'veg';
    if (typeRaw) {
        if (typeRaw === 'veg') foodType = 'veg';
        else if (typeRaw === 'non-veg' || typeRaw === 'nonveg') foodType = 'non-veg';
        else errors.push('Food Type must be Veg or Non-Veg');
    }
    const description = read(data, 'Description');
    if (description.length > 500) errors.push('Description must be 500 characters or fewer');
    const isAvailable = parseYesNo(read(data, 'Available (Yes/No)'), true, 'Available', errors);
    return result({
        id,
        restaurantId: restaurantId.toLowerCase(),
        name,
        price: price ?? 0,
        foodType,
        description,
        groupName: read(data, 'Group Name').slice(0, 80),
        categoryName: read(data, 'Addon Category'),
        image: mediaUrl(read(data, 'Image URL'), 'Image URL', errors),
        isAvailable,
    }, errors);
}

export const addonExportRow = (a) => {
    const content = a.published || a.draft || {};
    return [
        a.id,
        a.restaurantId,
        a.restaurant?.restaurantName || '',
        content.name || '',
        Number(content.price) || 0,
        content.foodType === 'non-veg' ? 'Non-Veg' : 'Veg',
        content.description || '',
        a.groupName || '',
        a.category?.name || '',
        content.image || '',
        a.isAvailable === false ? 'No' : 'Yes',
    ];
};

// ─── restaurants ─────────────────────────────────────────────────────────────

export const RESTAURANT_COLUMNS = [
    'Restaurant Name*', 'Owner Name*', 'Owner Phone*', 'Owner Email', 'Primary Contact Number', 'Zone',
    'Address', 'Area', 'City', 'State', 'Pincode', 'Latitude', 'Longitude', 'Cuisines',
    'Opening Time (HH:MM)', 'Closing Time (HH:MM)', 'Pure Veg (Yes/No)', 'Estimated Delivery Time',
    'FSSAI Number', 'GST Number', 'PAN Number', 'Logo Image URL', 'Cover Image URL',
];

/** Export adds what an import does not take: the id, status and dates. */
export const RESTAURANT_EXPORT_COLUMNS = ['Id', ...RESTAURANT_COLUMNS, 'Status', 'Accepting Orders', 'Rating', 'Created At'];

export const RESTAURANT_NOTES = [
    ['Restaurant Name*', 'As customers will see it.'],
    ['Owner Name*', 'Owner or manager.'],
    ['Owner Phone*', '10-digit mobile number; the owner signs in with it. A number already used by another restaurant is rejected.'],
    ['Zone', 'Zone name (or id). Blank = no zone yet; the restaurant will not show to customers until it has one.'],
    ['Latitude / Longitude', 'Decimal degrees, both or neither.'],
    ['Cuisines', 'Comma-separated, e.g. North Indian, Chinese.'],
    ['Opening / Closing Time', '24-hour HH:MM. Blank = 09:00 to 22:00.'],
    ['Pure Veg', 'Yes or No. Blank = No.'],
    ['Image URLs', 'Optional https:// links or uploaded file paths.'],
    ['', 'Every imported restaurant is created approved, exactly as if added from Add New Restaurant.'],
];

export function validateRestaurantRow(data) {
    const errors = [];
    const restaurantName = read(data, 'Restaurant Name');
    const ownerName = read(data, 'Owner Name');
    const ownerPhone = read(data, 'Owner Phone');
    if (!restaurantName) errors.push('Restaurant Name is required');
    if (!ownerName) errors.push('Owner Name is required');
    if (!ownerPhone) errors.push('Owner Phone is required');
    else if (!PHONE.test(ownerPhone) || ownerPhone.replace(/\D/g, '').length < 10) {
        errors.push('Owner Phone must be a phone number of at least 10 digits');
    }
    const primaryContactNumber = read(data, 'Primary Contact Number');
    if (primaryContactNumber && !PHONE.test(primaryContactNumber)) errors.push('Primary Contact Number is not a phone number');
    const ownerEmail = read(data, 'Owner Email').toLowerCase();
    if (ownerEmail && !EMAIL.test(ownerEmail)) errors.push('Owner Email is not an email address');

    const latitude = number(read(data, 'Latitude'), 'Latitude', errors, { min: -90 });
    const longitude = number(read(data, 'Longitude'), 'Longitude', errors, { min: -180 });
    if (latitude !== null && latitude > 90) errors.push('Latitude must be between -90 and 90');
    if (longitude !== null && longitude > 180) errors.push('Longitude must be between -180 and 180');
    if ((latitude === null) !== (longitude === null) && !errors.some((e) => /itude/.test(e))) {
        errors.push('Give both Latitude and Longitude, or neither');
    }

    const openingTime = read(data, 'Opening Time (HH:MM)');
    const closingTime = read(data, 'Closing Time (HH:MM)');
    if (openingTime && !TIME.test(openingTime)) errors.push('Opening Time must be HH:MM (24-hour)');
    if (closingTime && !TIME.test(closingTime)) errors.push('Closing Time must be HH:MM (24-hour)');

    const pureVegRestaurant = parseYesNo(read(data, 'Pure Veg (Yes/No)'), false, 'Pure Veg', errors);
    const address = read(data, 'Address');

    return result({
        restaurantName,
        ownerName,
        ownerPhone,
        ownerEmail,
        primaryContactNumber,
        zone: read(data, 'Zone'),
        location: {
            ...(latitude !== null && longitude !== null ? { latitude, longitude } : {}),
            formattedAddress: address,
            addressLine1: address,
            area: read(data, 'Area'),
            city: read(data, 'City'),
            state: read(data, 'State'),
            pincode: read(data, 'Pincode'),
        },
        cuisines: read(data, 'Cuisines').split(',').map((c) => c.trim()).filter(Boolean).slice(0, 50),
        ...(openingTime ? { openingTime } : {}),
        ...(closingTime ? { closingTime } : {}),
        pureVegRestaurant,
        estimatedDeliveryTime: read(data, 'Estimated Delivery Time'),
        fssaiNumber: read(data, 'FSSAI Number'),
        gstNumber: read(data, 'GST Number'),
        gstRegistered: Boolean(read(data, 'GST Number')),
        panNumber: read(data, 'PAN Number'),
        profileImage: mediaUrl(read(data, 'Logo Image URL'), 'Logo Image URL', errors),
        coverImage: mediaUrl(read(data, 'Cover Image URL'), 'Cover Image URL', errors),
    }, errors);
}

/** Phone digits as compared for duplicates: the last ten. */
export const phoneKey = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

export const restaurantExportRow = (r) => [
    r.id,
    r.restaurantName || '',
    r.ownerName || '',
    r.ownerPhone || '',
    r.ownerEmail || '',
    r.primaryContactNumber || '',
    r.zone?.name || r.zone?.zoneName || '',
    r.formattedAddress || r.addressLine1 || '',
    r.area || '',
    r.city || '',
    r.state || '',
    r.pincode || '',
    r.latitude ?? '',
    r.longitude ?? '',
    (r.cuisines || []).join(', '),
    r.openingTime || '',
    r.closingTime || '',
    r.pureVegRestaurant ? 'Yes' : 'No',
    r.estimatedDeliveryTime || '',
    r.fssaiNumber || '',
    r.gstNumber || '',
    r.panNumber || '',
    r.profileImage || '',
    r.coverImage || '',
    r.status || '',
    r.isAcceptingOrders === false ? 'No' : 'Yes',
    Number(r.rating) || 0,
    r.createdAt ? new Date(r.createdAt).toISOString() : '',
];
