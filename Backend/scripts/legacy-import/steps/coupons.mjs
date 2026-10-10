/**
 * Coupons: `coupons` (food module) -> food_offers.
 *
 * Old columns, as they are in the backup: title, code, start_date,
 * expire_date (DATE), min_purchase, max_discount, discount, discount_type
 * ('percent' | 'amount' | '' for free delivery), coupon_type (default |
 * store_wise | zone_wise | free_delivery | first_order), `limit` (limit for
 * the same user), status, data (JSON: store ids for store_wise, zone ids for
 * zone_wise), total_uses, customer_id (JSON: ["all"] or customer ids),
 * created_by ('admin' | 'vendor'), store_id (a vendor's own coupon), module_id.
 *
 * Mapping:
 *   - store, zone and customer ids go through legacy.id_map; an id that was
 *     not imported is dropped with a warning. A store/zone coupon left with
 *     none, or a customer-restricted coupon left with no customers, is
 *     imported switched off rather than falling open to everyone.
 *   - a vendor's coupon (store_id set) is store wise for that restaurant and
 *     restaurant-funded, as the restaurant panel creates them here.
 *   - dates are whole days in India (00:00 IST start, 23:59 IST expiry).
 *   - max_discount 0 means no cap; `limit` NULL/0 means no per-customer limit.
 *   - codes are upper-cased, as checkout matches them. A code already used by
 *     a different coupon on this system is skipped.
 *
 * total_uses is not copied: Total Uses is counted from orders. Imported orders
 * that carry the code are linked to the coupon here (food_orders.couponId), so
 * they count. Run after `orders` to link them; re-running links any missed.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, mappedThisRun, recordId } from '../idMap.mjs';
import { istDayEnd, istDayStart } from '../../../src/modules/food/shared/customerRewards.util.js';

const ENTITY = 'coupon';
const TYPES = new Set(['default', 'store_wise', 'zone_wise', 'free_delivery', 'first_order']);

const parseJson = (value, fallback) => {
    if (value && typeof value === 'object') return value;
    try {
        return JSON.parse(value || '') ?? fallback;
    } catch {
        return fallback;
    }
};
const asList = (value) => {
    const parsed = parseJson(value, []);
    return (Array.isArray(parsed) ? parsed : [parsed]).map((v) => String(v ?? '').trim()).filter(Boolean);
};
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;

/**
 * One old row -> food_offers columns, plus warnings. Exported for the test.
 *
 * @param {object} row  the MySQL row, with start_day / expire_day as 'YYYY-MM-DD'
 * @param {{ restaurants: Map, zones: Map, users: Map }} maps legacy id -> new id
 */
export function mapLegacyCoupon(row, maps) {
    const warnings = [];
    const code = String(row.code || '').trim().toUpperCase();
    if (!code) return { skip: 'no code' };
    if (code.length > 64) return { skip: 'code longer than 64 characters' };

    let couponType = String(row.coupon_type || 'default').trim();
    if (!TYPES.has(couponType)) return { skip: `unknown coupon type "${row.coupon_type}"` };

    const vendor = String(row.created_by || '').toLowerCase() === 'vendor' || Boolean(row.store_id);
    let switchedOff = false;

    // Restaurants: the vendor's own store, or the store_wise list.
    let legacyStores = couponType === 'store_wise' ? asList(row.data) : [];
    if (row.store_id) legacyStores = [String(row.store_id), ...legacyStores];
    const restaurantIds = [...new Set(legacyStores.map((id) => maps.restaurants.get(id)).filter(Boolean))];
    const missingStores = legacyStores.filter((id) => !maps.restaurants.get(id));
    if (missingStores.length) warnings.push(`restaurant(s) ${missingStores.join(', ')} not imported`);
    if (legacyStores.length) {
        // A vendor coupon of type default is, here, store wise for its store.
        if (couponType === 'default') couponType = 'store_wise';
        if (!restaurantIds.length) {
            switchedOff = true;
            warnings.push('none of its restaurants were imported; imported switched off');
        }
    }

    const legacyZones = couponType === 'zone_wise' ? asList(row.data) : [];
    const zoneIds = [...new Set(legacyZones.map((id) => maps.zones.get(id)).filter(Boolean))];
    if (legacyZones.length > zoneIds.length) {
        warnings.push(`zone(s) ${legacyZones.filter((id) => !maps.zones.get(id)).join(', ')} not imported`);
    }
    if (couponType === 'zone_wise' && !zoneIds.length) {
        switchedOff = true;
        warnings.push('none of its zones were imported; imported switched off');
    }

    const legacyCustomers = asList(row.customer_id);
    const everyone = !legacyCustomers.length || legacyCustomers.some((v) => v.toLowerCase() === 'all');
    const customerIds = everyone ? [] : [...new Set(legacyCustomers.map((id) => maps.users.get(id)).filter(Boolean))];
    if (!everyone && customerIds.length < legacyCustomers.length) {
        warnings.push(`customer(s) ${legacyCustomers.filter((id) => !maps.users.get(id)).join(', ')} not imported`);
    }
    if (!everyone && !customerIds.length) {
        switchedOff = true;
        warnings.push('none of its customers were imported; imported switched off');
    }

    const freeDelivery = couponType === 'free_delivery';
    const percent = String(row.discount_type || '').toLowerCase() === 'percent';
    const discountType = freeDelivery || !percent ? 'flat_price' : 'percentage';
    const maxDiscount = discountType === 'percentage' && Number(row.max_discount) > 0 ? money(row.max_discount) : null;
    const perUserLimit = Number(row.limit) > 0 ? Math.trunc(Number(row.limit)) : null;
    const restaurantFunded = vendor && !freeDelivery;

    return {
        warnings,
        data: {
            couponCode: code,
            title: String(row.title || '').trim().slice(0, 191),
            couponType,
            discountType,
            discountValue: freeDelivery ? 0 : money(row.discount),
            maxDiscount,
            minOrderValue: money(row.min_purchase),
            customerScope: everyone ? 'all' : 'specific',
            customerIds,
            restaurantScope: couponType === 'store_wise' ? 'selected' : 'all',
            restaurantId: couponType === 'store_wise' ? restaurantIds[0] || null : null,
            restaurantIds: couponType === 'store_wise' ? restaurantIds : [],
            zoneIds: couponType === 'zone_wise' ? zoneIds : [],
            isFirstOrderOnly: couponType === 'first_order',
            perUserLimit,
            usageLimit: null,
            startDate: istDayStart(row.start_day),
            endDate: istDayEnd(row.expire_day),
            status: Number(row.status) === 1 && !switchedOff ? 'active' : 'inactive',
            showInCart: true,
            createdByRole: vendor ? 'RESTAURANT' : 'ADMIN',
            adminBearPercentage: restaurantFunded ? 0 : 100,
            restaurantBearPercentage: restaurantFunded ? 100 : 0,
            ...(row.created_at ? { createdAt: row.created_at } : {}),
        },
    };
}

const COUPON_SQL = `SELECT c.*, DATE_FORMAT(c.start_date, '%Y-%m-%d') AS start_day, DATE_FORMAT(c.expire_date, '%Y-%m-%d') AS expire_day
           FROM coupons c WHERE c.module_id = ? ORDER BY c.id`;
const COUPON_COLUMNS = [
    'title', 'code', 'start_day', 'expire_day', 'min_purchase', 'max_discount', 'discount', 'discount_type',
    'coupon_type', 'limit', 'status', 'data', 'customer_id', 'store_id',
];

export async function importCoupons(mysql, report, ctx = {}) {
    const idMap = await loadIdMap(ENTITY);
    const maps = {
        restaurants: await loadIdMap('restaurant'),
        zones: await loadIdMap('zone'),
        users: await loadIdMap('user'),
    };

    const [[foodModule]] = await mysql.query("SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1");
    const [rows] = await mysql.query(COUPON_SQL, [foodModule.id]);

    // Sync: coupons are the new admin's now. Only orders this run imported are
    // linked to a coupon -- an order placed here with a rejected code must
    // not start counting as a use.
    const baseline = ctx.sync ? await ctx.baselineRows(COUPON_SQL, [foodModule.id]) : null;
    const newOrders = ctx.sync ? [...mappedThisRun('order').values()] : null;
    const linkOrders = async (couponId, code, legacyId) => {
        if (newOrders && !newOrders.length) return;
        const { count: linked } = await prisma.foodOrder.updateMany({
            where: {
                couponId: null,
                couponCode: { equals: code, mode: 'insensitive' },
                ...(newOrders ? { id: { in: newOrders } } : {}),
            },
            data: { couponId },
        });
        if (linked) console.log(`  coupon #${legacyId} ${code}: linked ${linked} imported order(s) that used it`);
    };

    for (const row of rows) {
        const name = row.title || row.code || '(untitled)';
        if (ctx.sync && idMap.has(String(row.id))) {
            ctx.leaveAlone(report, ENTITY, row, baseline, COUPON_COLUMNS);
            const id = idMap.get(String(row.id));
            const coupon = await prisma.foodOffer.findUnique({ where: { id }, select: { id: true, couponCode: true } });
            if (coupon) await linkOrders(coupon.id, coupon.couponCode, row.id);
            continue;
        }
        const mapped = mapLegacyCoupon(row, maps);
        if (mapped.skip) {
            report.skip(ENTITY, row.id, name, mapped.skip);
            continue;
        }
        for (const message of mapped.warnings) report.warn(ENTITY, row.id, name, message);

        const mappedId = idMap.get(String(row.id));
        const exists = mappedId && (await prisma.foodOffer.count({ where: { id: mappedId } })) > 0;
        const clash = await prisma.foodOffer.findUnique({ where: { couponCode: mapped.data.couponCode }, select: { id: true } });
        if (clash && clash.id !== mappedId) {
            report.skip(ENTITY, row.id, name, `code ${mapped.data.couponCode} is already used by another coupon here`);
            continue;
        }

        const saved = exists
            ? await prisma.foodOffer.update({ where: { id: mappedId }, data: mapped.data, select: { id: true } })
            : await prisma.foodOffer.create({ data: mapped.data, select: { id: true } });
        await recordId(ENTITY, row.id, saved.id);

        // Imported orders that used this code count towards Total Uses.
        await linkOrders(saved.id, mapped.data.couponCode, row.id);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }
}
