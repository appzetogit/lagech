/**
 * Restaurants: `stores` + `vendors` + `store_schedule` -> food_restaurants,
 * food_restaurant_outlet_timings, food_restaurant_commissions.
 *
 * Created through createRestaurantByAdmin (and updateRestaurantById on a
 * re-run), so the phone-uniqueness check, the location columns and the PostGIS
 * trigger all behave as they do for a restaurant added in the admin panel. What
 * that service does not carry -- the real approval state, the owner's open
 * toggle, day-by-day hours, commission, images, derived search fields -- is
 * written afterwards.
 *
 * Owners need no new credentials: restaurant login is an OTP to the owner's
 * phone, and the old phone numbers are unique across all 52 stores.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import {
    deriveRestaurantFields,
    fromRestaurantLocation,
} from '../../../src/modules/food/restaurant/restaurant.mapper.js';
import {
    createRestaurantByAdmin,
    updateRestaurantById,
} from '../../../src/modules/food/admin/services/adminRestaurantWrite.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const ENTITY = 'restaurant';

/** store_schedule.day is 0..6 from Sunday, the same order the new model uses. */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * The old platform-wide commission. A store with no commission of its own paid
 * this; the new system charges 0% when a restaurant has no commission row, so
 * leaving the row out would silently stop every migrated restaurant earning the
 * platform anything.
 */
const readDefaultCommission = async (mysql) => {
    const [[row]] = await mysql.query("SELECT value FROM business_settings WHERE `key` = 'admin_commission'");
    const value = Number(row?.value);
    return Number.isFinite(value) ? value : null;
};

/** '10:00:00' -> '10:00'. */
const hhmm = (time) => String(time || '').slice(0, 5);

/**
 * One opening and closing time per day, which is all the new model holds.
 *
 * A day split into two shifts (lunch and dinner) becomes earliest open to latest
 * close -- so the restaurant can take orders across its break -- and is reported,
 * because the owner may want to go offline for that gap. A day with no slot is
 * closed; a store with no schedule at all was closed every day in the old
 * system too, and stays so.
 */
const buildTimings = (slots, report, row) => {
    const byDay = new Map();
    for (const slot of slots) {
        const list = byDay.get(slot.day) || [];
        list.push(slot);
        byDay.set(slot.day, list);
    }

    let splitDays = 0;
    const timings = DAY_NAMES.map((day, index) => {
        const daySlots = byDay.get(index) || [];
        if (!daySlots.length) return { day, isOpen: false, openingTime: '', closingTime: '' };
        if (daySlots.length > 1) splitDays += 1;
        const opens = daySlots.map((slot) => hhmm(slot.opening_time)).sort();
        const closes = daySlots.map((slot) => hhmm(slot.closing_time)).sort();
        return { day, isOpen: true, openingTime: opens[0], closingTime: closes[closes.length - 1] };
    });

    if (splitDays) {
        report.warn(ENTITY, row.id, row.name,
            `had split shifts on ${splitDays} day(s); imported as earliest open to latest close`);
    }
    if (!slots.length && row.vendor_status === 1 && row.store_status === 1) {
        report.warn(ENTITY, row.id, row.name, 'approved but had no opening hours; imported closed every day');
    }
    return timings;
};

/**
 * Old approval lived on the vendor (NULL pending, 0 rejected, 1 approved) with a
 * separate admin on/off switch on the store. An admin switching a store off maps
 * to what the new panel's own switch does: rejected, "Disabled by admin".
 */
const approvalFor = (row) => {
    if (row.vendor_status === null || row.vendor_status === undefined) {
        return { status: 'pending', approvedAt: null, rejectedAt: null, rejectionReason: null };
    }
    if (row.vendor_status === 0) {
        return {
            status: 'rejected',
            approvedAt: null,
            rejectedAt: row.updated_at || new Date(),
            rejectionReason: String(row.rejection_note || '').trim() || 'Rejected',
        };
    }
    if (row.store_status === 0) {
        return {
            status: 'rejected',
            approvedAt: null,
            rejectedAt: row.updated_at || new Date(),
            rejectionReason: 'Disabled by admin',
        };
    }
    return { status: 'approved', approvedAt: row.created_at || new Date(), rejectedAt: null, rejectionReason: null };
};

/**
 * An image copied from the old storage, or '' when there is none. One old
 * upload was recorded with a trailing dot ("x.") but saved as "x"; both are
 * tried. A file that is missing is reported, not linked.
 */
const imageFrom = (dir, file, report, row, label) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return '';
    const root = config.uploadStorageRoot || 'uploads';
    for (const candidate of [name, name.replace(/\.$/, '')]) {
        if (candidate && fs.existsSync(path.join(root, dir, candidate))) {
            return buildPublicUrl(`${dir}/${candidate}`);
        }
    }
    report.warn(ENTITY, row.id, row.name, `${label} ${name} not found in ${dir}; imported without it`);
    return '';
};

const ownerNameOf = (row) => {
    const first = String(row.f_name || '').trim();
    const last = String(row.l_name || '').trim();
    // Several owners typed their full name into both fields.
    return (first === last ? first : `${first} ${last}`).trim() || String(row.name).trim();
};

export async function importRestaurants(mysql, report) {
    const zoneMap = await loadIdMap('zone');
    const idMap = await loadIdMap(ENTITY);
    const defaultCommission = await readDefaultCommission(mysql);

    const [[foodModule]] = await mysql.query(
        "SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1"
    );
    const [rows] = await mysql.query(`
        SELECT s.*, v.f_name, v.l_name, v.phone AS owner_phone, v.email AS owner_email,
               v.status AS vendor_status, v.rejection_note, s.status AS store_status
        FROM stores s
        JOIN vendors v ON v.id = s.vendor_id
        WHERE s.module_id = ?
        ORDER BY s.id`, [foodModule.id]);
    const [allSlots] = await mysql.query(
        'SELECT store_id, day, opening_time, closing_time FROM store_schedule ORDER BY store_id, day, opening_time'
    );
    const slotsByStore = new Map();
    for (const slot of allSlots) {
        const key = String(slot.store_id);
        slotsByStore.set(key, [...(slotsByStore.get(key) || []), slot]);
    }

    for (const row of rows) {
        const zoneId = zoneMap.get(String(row.zone_id));
        if (!zoneId) {
            report.skip(ENTITY, row.id, row.name, `zone ${row.zone_id} was not imported`);
            continue;
        }

        const timings = buildTimings(slotsByStore.get(String(row.id)) || [], report, row);
        const openDays = timings.filter((t) => t.isOpen);
        const address = String(row.address || '').trim();

        const body = {
            restaurantName: String(row.name).trim(),
            ownerName: ownerNameOf(row),
            // Lowercased as updateRestaurantById would, so create and re-run agree.
            ownerEmail: String(row.owner_email || row.email || '').trim().toLowerCase(),
            ownerPhone: String(row.owner_phone || row.phone || '').trim(),
            primaryContactNumber: String(row.phone || row.owner_phone || '').trim(),
            pureVegRestaurant: row.veg === 1 && row.non_veg === 0,
            location: {
                latitude: Number(row.latitude),
                longitude: Number(row.longitude),
                formattedAddress: address,
                addressLine1: address,
            },
            zoneId,
            // The simple fields mirror the week; the per-day timings are exact.
            openingTime: openDays.length ? openDays.map((t) => t.openingTime).sort()[0] : undefined,
            closingTime: openDays.length ? openDays.map((t) => t.closingTime).sort().pop() : undefined,
            openDays: openDays.map((t) => t.day),
            estimatedDeliveryTime: String(row.delivery_time || '').trim(),
        };

        const existingId = idMap.get(String(row.id));
        const exists = existingId
            && (await prisma.foodRestaurant.count({ where: { id: existingId } })) > 0;

        let restaurant;
        try {
            restaurant = exists
                ? await updateRestaurantById(existingId, body)
                : await createRestaurantByAdmin(body);
        } catch (error) {
            report.skip(ENTITY, row.id, row.name, error.message);
            continue;
        }
        const restaurantId = String(restaurant?.id || restaurant?._id || existingId);

        const logo = imageFrom('legacy/store', row.logo, report, row, 'logo');
        const cover = imageFrom('legacy/store/cover', row.cover_photo, report, row, 'cover');

        await prisma.$transaction([
            prisma.foodRestaurant.update({
                where: { id: restaurantId },
                data: {
                    // updateRestaurantById does not take a location or zone, so
                    // on a re-run a restaurant that has moved would keep its old
                    // pin. Written here instead; the trigger still derives the
                    // PostGIS point from latitude/longitude.
                    ...fromRestaurantLocation(body.location),
                    zoneId,
                    ...approvalFor(row),
                    // The owner's open/closed switch; separate from approval.
                    isAcceptingOrders: row.active === 1,
                    // Neither create nor update derives these, and the customer
                    // app finds a restaurant page by the normalised name.
                    ...deriveRestaurantFields({
                        restaurantName: body.restaurantName,
                        ownerPhone: body.ownerPhone,
                        estimatedDeliveryTime: body.estimatedDeliveryTime,
                    }),
                    profileImage: logo,
                    coverImage: cover,
                    coverImages: cover ? [cover] : [],
                    ...(row.created_at ? { createdAt: row.created_at } : {}),
                },
            }),
            prisma.foodRestaurantOutletTimings.upsert({
                where: { restaurantId },
                create: { restaurantId, timings },
                update: { timings },
            }),
        ]);

        const ownCommission = row.comission === null || row.comission === undefined ? null : Number(row.comission);
        const commissionValue = ownCommission ?? defaultCommission;
        if (commissionValue === null) {
            report.warn(ENTITY, row.id, row.name, 'no commission of its own and no platform default found');
        } else {
            const data = {
                commissionType: 'percentage',
                commissionValue,
                notes: ownCommission === null
                    ? `Imported: previous platform default (${commissionValue}%)`
                    : `Imported: restaurant's own rate (${commissionValue}%)`,
                status: true,
            };
            await prisma.foodRestaurantCommission.upsert({
                where: { restaurantId },
                create: { restaurantId, ...data },
                update: data,
            });
        }

        await recordId(ENTITY, row.id, restaurantId);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }

    await importDeletedRestaurants(mysql, report, { idMap, zoneMap, foodModuleId: foodModule.id, defaultCommission });
}

/**
 * Restaurants the old admin deleted, whose orders, dishes and payouts are still
 * in the data. The store and owner rows are gone, but the old system kept each
 * store's name and address in `translations`; where those survive, the
 * restaurant comes back as a rejected placeholder, so its order history and
 * payouts have somewhere to belong. It cannot be logged into (no owner phone)
 * and is never listed to customers. A deleted store with no surviving name is
 * left out, as before.
 */
async function importDeletedRestaurants(mysql, report, { idMap, zoneMap, foodModuleId, defaultCommission }) {
    const [rows] = await mysql.query(`
        SELECT ref.id,
               MAX(CASE WHEN t.\`key\` = 'name' THEN t.value END) AS name,
               MAX(CASE WHEN t.\`key\` = 'address' THEN t.value END) AS address,
               (SELECT o.zone_id FROM orders o WHERE o.store_id = ref.id ORDER BY o.id DESC LIMIT 1) AS zone_id,
               (SELECT MIN(o.created_at) FROM orders o WHERE o.store_id = ref.id) AS first_order_at
        FROM (
            SELECT store_id AS id FROM orders WHERE module_id = ?
            UNION SELECT store_id FROM items WHERE module_id = ?
        ) ref
        JOIN translations t
          ON t.translationable_type = 'App\\\\Models\\\\Store' AND t.translationable_id = ref.id
        WHERE ref.id NOT IN (SELECT id FROM stores)
        GROUP BY ref.id`, [foodModuleId, foodModuleId]);

    for (const row of rows) {
        const name = String(row.name || '').trim();
        if (!name) continue;
        const address = String(row.address || '').trim();
        const zoneId = zoneMap.get(String(row.zone_id)) || null;

        const data = {
            restaurantName: name,
            ownerName: 'Unknown (deleted in the previous system)',
            addressLine1: address || null,
            formattedAddress: address || null,
            zoneId,
            status: 'rejected',
            rejectedAt: new Date(),
            rejectionReason: 'Deleted in the previous system; kept for its order history and payouts',
            isAcceptingOrders: false,
            ...deriveRestaurantFields({ restaurantName: name, ownerPhone: '', estimatedDeliveryTime: '' }),
            ...(row.first_order_at ? { createdAt: row.first_order_at } : {}),
        };

        const existingId = idMap.get(String(row.id));
        const exists = existingId && (await prisma.foodRestaurant.count({ where: { id: existingId } })) > 0;
        const restaurant = exists
            ? await prisma.foodRestaurant.update({ where: { id: existingId }, data, select: { id: true } })
            : await prisma.foodRestaurant.create({ data, select: { id: true } });

        if (defaultCommission !== null) {
            const commission = {
                commissionType: 'percentage',
                commissionValue: defaultCommission,
                notes: `Imported: previous platform default (${defaultCommission}%)`,
                status: true,
            };
            await prisma.foodRestaurantCommission.upsert({
                where: { restaurantId: restaurant.id },
                create: { restaurantId: restaurant.id, ...commission },
                update: commission,
            });
        }

        await recordId(ENTITY, row.id, restaurant.id);
        idMap.set(String(row.id), restaurant.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
        report.warn(ENTITY, row.id, name,
            'deleted in the old system; imported as a rejected placeholder from its surviving name and address, for order history and payouts');
    }
}
