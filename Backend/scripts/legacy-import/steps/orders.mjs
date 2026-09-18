/**
 * Orders: `orders` + `order_details` + `order_transactions` + `reviews` +
 * `d_m_reviews` -> food_orders, food_order_items, food_order_status_history,
 * food_transactions, food_order_item_ratings.
 *
 * History, not live business: every order is imported in a final state, and
 * nothing is sent through the order services -- those notify restaurants,
 * dispatch riders and charge wallets, all of which happened years ago (or
 * never should).
 *
 * The money comes from the old ledger, not from recomputing it. The old
 * `order_transactions` row says what the restaurant was owed, what the platform
 * kept and what the rider earned on each delivered order, and those are the
 * numbers the old wallets were built from:
 *
 *   restaurantShare = store_amount
 *   platform keeps  = admin_commission (food commission + its cut of delivery,
 *                     less what it spent on the order)
 *   rider earned    = original_delivery_charge + tips -- the rider's share of
 *                     delivery. Not delivery_charge less the platform's cut:
 *                     on a free-delivery order the customer was charged 0 and
 *                     the platform paid the rider, which that formula made 0.
 *   discount split  = the old `expenses` rows, which record how much of each
 *                     discount the platform bore and how much the restaurant
 *
 * Totals follow what the customer was charged: food at the unit price the old
 * app stored (base plus any option, before discount) times quantity, less the
 * restaurant discount, plus delivery. 22 orders an admin edited after they
 * were placed do not add up that way; their final amount is kept and the
 * difference shown as discount.
 *
 * Order numbers keep the old number: #104732 becomes FOD-104732, which the
 * order lookup already accepts and which no new order number can collide
 * with (those have ten digits).
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { parseFormattedAddress } from './customers.mjs';

const ENTITY = 'order';
const FOOD_MODULE_TYPE = 'food';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const last10 = (phone) => String(phone || '').replace(/\D/g, '').slice(-10);

const parseJson = (raw, fallback) => {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch {
        return fallback;
    }
};

const PAYMENT_METHODS = {
    cash_on_delivery: 'cash',
    razor_pay: 'razorpay',
    digital_payment: 'razorpay',
    // Paid to the business directly (UPI to the owner, for instance): not
    // cash a rider collected, so it must not count toward anyone's cash in hand.
    offline_payment: 'razorpay',
};

const LABELS = { home: 'Home', office: 'Office', others: 'Other', other: 'Other' };

const CANCELLED_BY = {
    customer: { status: 'cancelled_by_user', role: 'USER' },
    admin_for_customer: { status: 'cancelled_by_admin', role: 'ADMIN' },
    admin: { status: 'cancelled_by_admin', role: 'ADMIN' },
    vendor: { status: 'cancelled_by_restaurant', role: 'RESTAURANT' },
    store: { status: 'cancelled_by_restaurant', role: 'RESTAURANT' },
    deliveryman: { status: 'cancelled_by_admin', role: 'DELIVERY_PARTNER' },
};

/** The old app's step timestamps, in order, as history rows. */
const STEPS = [
    ['pending', 'created', 'USER'],
    ['confirmed', 'confirmed', 'RESTAURANT'],
    ['accepted', 'accepted by rider', 'DELIVERY_PARTNER'],
    ['processing', 'preparing', 'RESTAURANT'],
    ['handover', 'ready_for_pickup', 'RESTAURANT'],
    ['picked_up', 'picked_up', 'DELIVERY_PARTNER'],
    ['delivered', 'delivered', 'DELIVERY_PARTNER'],
];

export async function importOrders(mysql, report) {
    const maps = {
        user: await loadIdMap('user'),
        restaurant: await loadIdMap('restaurant'),
        rider: await loadIdMap('delivery_partner'),
        food: await loadIdMap('food'),
        zone: await loadIdMap('zone'),
        order: await loadIdMap(ENTITY),
    };

    const [[foodModule]] = await mysql.query(
        'SELECT id FROM modules WHERE module_type = ? ORDER BY status DESC, id LIMIT 1', [FOOD_MODULE_TYPE],
    );
    const [orders] = await mysql.query('SELECT * FROM orders ORDER BY id');
    const [details] = await mysql.query('SELECT * FROM order_details ORDER BY id');
    const [ledger] = await mysql.query('SELECT * FROM order_transactions');
    const [itemReviews] = await mysql.query('SELECT * FROM reviews ORDER BY id');
    const [riderReviews] = await mysql.query('SELECT * FROM d_m_reviews ORDER BY id');
    const [users] = await mysql.query('SELECT id, f_name, l_name, phone FROM users');
    const [discountRows] = await mysql.query(`
        SELECT order_id,
               SUM(CASE WHEN created_by = 'admin' THEN amount ELSE 0 END) AS admin,
               SUM(CASE WHEN created_by <> 'admin' THEN amount ELSE 0 END) AS restaurant
          FROM expenses WHERE type = 'discount_on_product' GROUP BY order_id`);
    const discountSplit = new Map(discountRows.map((row) => [String(row.order_id), row]));

    const group = (rows, key) => {
        const map = new Map();
        for (const row of rows) {
            const k = String(row[key]);
            map.set(k, [...(map.get(k) || []), row]);
        }
        return map;
    };
    const detailsByOrder = group(details, 'order_id');
    const ledgerByOrder = new Map(ledger.map((row) => [String(row.order_id), row]));
    const reviewsByOrder = group(itemReviews, 'order_id');
    const riderReviewByOrder = new Map(riderReviews.map((row) => [String(row.order_id), row]));
    const userById = new Map(users.map((u) => [String(u.id), u]));

    const zoneNames = new Map((await prisma.foodZone.findMany({ select: { id: true, name: true } }))
        .map((zone) => [zone.id, zone.name]));
    const foodNames = new Map((await prisma.foodItem.findMany({ select: { id: true, image: true } }))
        .map((food) => [food.id, food.image]));

    const notes = {
        edited: 0, openAtCutover: [], paidCancelled: [], deletedItems: 0, hiddenReviews: 0,
        takeaway: 0, noCity: 0,
    };

    for (const row of orders) {
        const label = `#${row.id}`;
        if (Number(row.module_id) !== Number(foodModule.id)) {
            report.skip(ENTITY, row.id, label, `a ${row.order_type} order from another module`);
            continue;
        }
        const userId = maps.user.get(String(row.user_id));
        const restaurantId = maps.restaurant.get(String(row.store_id));
        if (!userId) {
            report.skip(ENTITY, row.id, label, `customer ${row.user_id} no longer exists in the old data`);
            continue;
        }
        if (!restaurantId) {
            report.skip(ENTITY, row.id, label, `restaurant ${row.store_id} no longer exists in the old data`);
            continue;
        }
        const lines = detailsByOrder.get(String(row.id)) || [];
        if (!lines.length) {
            report.skip(ENTITY, row.id, label, 'has no items');
            continue;
        }

        // ── status ──
        const delivered = row.order_status === 'delivered';
        const cancelled = row.order_status === 'canceled';
        let orderStatus;
        let cancelRole = null;
        if (delivered) {
            orderStatus = 'delivered';
        } else if (cancelled) {
            const by = CANCELLED_BY[row.canceled_by] || CANCELLED_BY.admin;
            orderStatus = by.status;
            cancelRole = by.role;
        } else {
            // Still open when the old system stopped. Importing it open would
            // hand it to dispatch and the expiry watchdog as if it were new.
            orderStatus = 'cancelled_by_admin';
            cancelRole = 'SYSTEM';
            notes.openAtCutover.push(`#${row.id} (${row.order_status})`);
        }

        // ── money ──
        const subtotal = money(lines.reduce(
            (sum, line) => sum + Number(line.price) * Number(line.quantity) + Number(line.total_add_on_price || 0), 0,
        ));
        const takeaway = row.order_type === 'take_away';
        if (takeaway) notes.takeaway += 1;
        const deliveryFee = money(row.delivery_charge);
        const tax = money(row.total_tax_amount);
        const total = money(row.order_amount);
        let discount = money(Number(row.store_discount_amount || 0) + Number(row.coupon_discount_amount || 0));
        const expected = money(subtotal - discount + deliveryFee + tax);
        if (Math.abs(expected - total) >= 0.01) {
            discount = money(Math.max(0, subtotal + deliveryFee + tax - total));
            notes.edited += 1;
        }

        const txn = ledgerByOrder.get(String(row.id));
        const riderEarning = delivered && txn && row.delivery_man_id
            ? money(Number(txn.original_delivery_charge) + Number(txn.dm_tips || 0))
            : 0;
        const restaurantShare = delivered && txn ? money(txn.store_amount) : 0;
        // What the restaurant gave up on the food: its discounted food total
        // less what it was paid. Taken this way, not from admin_commission,
        // because that figure already has the platform's own spending on the
        // order netted out of it.
        const restaurantCommission = delivered && txn ? money(Math.max(0, subtotal - discount - restaurantShare)) : 0;
        const platformProfit = delivered && txn ? money(txn.admin_commission) : 0;
        const split = discountSplit.get(String(row.id));
        const adminDiscountShare = delivered && split ? money(split.admin) : 0;
        const restaurantDiscountShare = delivered ? (split ? money(split.restaurant) : discount) : 0;

        // ── payment ──
        const paymentMethod = PAYMENT_METHODS[row.payment_method] || 'cash';
        const paid = row.payment_status === 'paid';
        const paymentStatus = paid ? 'paid' : paymentMethod === 'cash' ? 'cod_pending' : 'created';
        if (cancelled && paid) notes.paidCancelled.push(`#${row.id} ${row.payment_method} ₹${total}`);

        // ── address ──
        const address = parseJson(row.delivery_address, {}) || {};
        const street = String(address.address || '').trim() || (takeaway ? 'Takeaway (collected from the restaurant)' : '');
        let { city, state, zipCode } = parseFormattedAddress(street);
        const lat = Number(address.latitude);
        const lng = Number(address.longitude);
        const hasPin = Number.isFinite(lat) && Number.isFinite(lng) && !(lat === 0 && lng === 0);
        const zoneId = maps.zone.get(String(row.zone_id)) || null;
        if (!city) city = (zoneId && zoneNames.get(zoneId)) || '';
        if (!city) notes.noCity += 1;
        const customer = userById.get(String(row.user_id));
        const customerName = String(address.contact_person_name || `${customer?.f_name || ''} ${customer?.l_name || ''}`).trim();

        const riderId = row.delivery_man_id ? maps.rider.get(String(row.delivery_man_id)) || null : null;
        const at = (column) => (row[column] ? new Date(row[column]) : null);

        const data = {
            order_id: `FOD-${row.id}`,
            orderId: `FOD-${row.id}`,
            userId,
            restaurantId,
            zoneId,
            customerName,
            customerPhone: last10(address.contact_person_number || customer?.phone),
            addrLabel: LABELS[String(address.address_type || '').toLowerCase()] || 'Other',
            addrName: customerName,
            addrFullName: customerName,
            addrStreet: street,
            addrAdditionalDetails: [
                address.house && `House: ${address.house}`,
                address.road && `Road: ${address.road}`,
                address.floor && `Floor: ${address.floor}`,
            ].filter(Boolean).join(', '),
            addrCity: city,
            addrState: state,
            addrZipCode: zipCode,
            addrPhone: last10(address.contact_person_number),
            addrLat: hasPin ? lat : null,
            addrLng: hasPin ? lng : null,

            subtotal,
            tax,
            deliveryFee,
            restaurantCommission,
            discount,
            couponCode: row.coupon_code || null,
            total,
            distanceKm: Number(row.distance) > 0 ? money(row.distance) : null,

            paymentMethod,
            paymentStatus,
            paymentAmountDue: paid ? 0 : total,
            razorpayPaymentId: paymentMethod === 'razorpay' && row.transaction_reference ? String(row.transaction_reference) : null,

            orderStatus,
            dispatchStatus: riderId ? (delivered ? 'accepted' : 'cancelled') : 'unassigned',
            dispatchDeliveryPartnerId: riderId,
            dispatchAssignedAt: at('accepted'),
            dispatchAcceptedAt: at('accepted'),
            deliveryPhase: delivered ? 'delivered' : 'en_route_to_pickup',
            deliveryStatus: delivered ? 'delivered' : '',
            pickedUpAt: at('picked_up'),
            deliveredAt: delivered ? at('delivered') || at('updated_at') : null,

            note: [
                String(row.order_note || '').trim(),
                takeaway && 'Takeaway order',
                !delivered && !cancelled && 'Still open when the previous system was switched off',
            ].filter(Boolean).join(' · '),
            deliveryInstructions: String(row.delivery_instruction || '').trim(),
            sendCutlery: row.cutlery !== 0,
            scheduledAt: row.scheduled === 1 ? at('schedule_at') : null,

            riderEarning,
            platformProfit,

            createdAt: at('created_at') || new Date(),
        };

        // ── ratings on the order ──
        const reviews = (reviewsByOrder.get(String(row.id)) || []).filter((review) => {
            if (review.status === 1) return true;
            notes.hiddenReviews += 1;
            return false;
        });
        if (reviews.length) {
            data.restaurantRating = Math.round(reviews.reduce((s, r) => s + Number(r.rating), 0) / reviews.length);
            data.restaurantRatingComment = reviews.map((r) => String(r.comment || '').trim()).filter(Boolean).join(' · ');
            data.restaurantRatedAt = reviews[0].created_at;
        }
        const riderReview = riderReviewByOrder.get(String(row.id));
        if (riderReview && riderId) {
            data.partnerRating = Number(riderReview.rating);
            data.partnerRatingComment = String(riderReview.comment || '').trim();
            data.partnerRatedAt = riderReview.created_at;
        }

        // ── items ──
        const items = lines.map((line) => {
            const snapshot = parseJson(line.item_details, {}) || {};
            const foodId = maps.food.get(String(line.item_id));
            if (!foodId) notes.deletedItems += 1;
            const options = (parseJson(line.variation, []) || [])
                .flatMap((group) => (group?.values || []).map((value) => value?.label))
                .filter(Boolean);
            return {
                // A dish deleted in the old system keeps its name here, under an
                // id that cannot be confused with a real one.
                itemId: foodId || `legacy-item-${line.item_id}`,
                name: String(snapshot.name || `Item #${line.item_id}`),
                variantName: options.join(', '),
                price: money(line.price),
                quantity: Number(line.quantity) || 1,
                isVeg: snapshot.veg === 1 || snapshot.veg === '1',
                image: (foodId && foodNames.get(foodId)) || '',
            };
        });

        // ── history ──
        const history = STEPS
            .filter(([column]) => row[column])
            .map(([column, to, role]) => ({ at: new Date(row[column]), to, byRole: role, note: 'Imported from the previous system' }));
        if (!delivered) {
            history.push({
                at: at('canceled') || at('updated_at') || data.createdAt,
                to: orderStatus,
                byRole: cancelRole,
                note: String(row.cancellation_reason || row.cancellation_note || '').trim()
                    || (cancelRole === 'SYSTEM' ? 'Still open when the previous system was switched off' : 'Cancelled'),
            });
        }
        history.sort((a, b) => a.at - b.at);
        let previous = null;
        for (const step of history) {
            step.from = previous;
            previous = step.to;
        }

        const itemRatings = reviews.map((review) => ({
            itemId: maps.food.get(String(review.item_id)) || `legacy-item-${review.item_id}`,
            name: items.find((item) => item.itemId === maps.food.get(String(review.item_id)))?.name || '',
            rating: Number(review.rating),
            comment: String(review.comment || '').trim(),
            ratedAt: review.created_at || data.createdAt,
        }));

        const transaction = {
            userId,
            restaurantId,
            deliveryPartnerId: riderId,
            paymentMethod,
            status: delivered ? 'captured' : paid ? 'captured' : 'failed',
            subtotal,
            tax,
            deliveryFee,
            restaurantCommission,
            discount,
            total,
            paymentStatusLabel: paymentStatus,
            amountDue: paid ? 0 : total,
            gatewayProvider: paymentMethod === 'cash' ? 'cash' : 'razorpay',
            razorpayPaymentId: data.razorpayPaymentId,
            totalCustomerPaid: delivered || paid ? total : 0,
            restaurantShare,
            commissionAmount: restaurantCommission,
            riderShare: riderEarning,
            platformNetProfit: platformProfit,
            taxAmount: tax,
            adminDiscountShare,
            restaurantDiscountShare,
            discountAdminBearPercentage: discount > 0 ? money((adminDiscountShare / discount) * 100) : 0,
            discountRestaurantBearPercentage: discount > 0 ? money((restaurantDiscountShare / discount) * 100) : 0,
            createdAt: data.createdAt,
        };

        const mappedId = maps.order.get(String(row.id));
        const exists = mappedId && (await prisma.foodOrder.count({ where: { id: mappedId } })) > 0;

        const orderId = await prisma.$transaction(async (tx) => {
            const order = exists
                ? await tx.foodOrder.update({ where: { id: mappedId }, data, select: { id: true } })
                : await tx.foodOrder.create({ data, select: { id: true } });
            // Children are replaced wholesale: the old data is the source of truth.
            await tx.orderItem.deleteMany({ where: { orderId: order.id } });
            await tx.orderStatusHistory.deleteMany({ where: { orderId: order.id } });
            await tx.orderItemRating.deleteMany({ where: { orderId: order.id } });
            await tx.orderItem.createMany({ data: items.map((item) => ({ ...item, orderId: order.id })) });
            await tx.orderStatusHistory.createMany({ data: history.map((h) => ({ ...h, orderId: order.id })) });
            if (itemRatings.length) {
                await tx.orderItemRating.createMany({ data: itemRatings.map((r) => ({ ...r, orderId: order.id })) });
            }
            const saved = await tx.foodTransaction.upsert({
                where: { orderId: order.id },
                create: { ...transaction, orderId: order.id },
                update: transaction,
                select: { id: true },
            });
            await tx.foodOrder.update({ where: { id: order.id }, data: { transactionId: saved.id } });
            return order.id;
        });

        await recordId(ENTITY, row.id, orderId);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }

    if (notes.edited) {
        report.warn(ENTITY, '-', '(all)', `${notes.edited} order(s) were edited after being placed; their final amount is kept, the difference shown as discount`);
    }
    if (notes.openAtCutover.length) {
        report.warn(ENTITY, '-', '(all)', `still open in the old system, imported as cancelled: ${notes.openAtCutover.join(', ')}`);
    }
    if (notes.paidCancelled.length) {
        report.warn(ENTITY, '-', '(all)', `paid online but cancelled, with no refund recorded in the old system: ${notes.paidCancelled.join(', ')}`);
    }
    if (notes.deletedItems) {
        report.warn(ENTITY, '-', '(all)', `${notes.deletedItems} order line(s) are for dishes since deleted; kept by name`);
    }
    if (notes.hiddenReviews) {
        report.warn(ENTITY, '-', '(all)', `${notes.hiddenReviews} review(s) an admin had hidden were not imported`);
    }
    if (notes.takeaway) {
        report.warn(ENTITY, '-', '(all)', `${notes.takeaway} takeaway order(s) imported as orders without a rider, noted "Takeaway order"`);
    }
    if (notes.noCity) {
        report.warn(ENTITY, '-', '(all)', `${notes.noCity} order address(es) have no city`);
    }
}
