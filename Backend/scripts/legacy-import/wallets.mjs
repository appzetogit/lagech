/**
 * Wallet balances for the sync report: what each rider and restaurant holds
 * here before and after the sync, against what the old system's wallet said
 * at the baseline copy and says now. A sync moves balances only by the ledger
 * rows it imports, so "moved here" should match "moved in the old system";
 * where it does not, the gap is shown rather than closed.
 *
 * Here (as the app works them out):
 *   rider cash in hand   = delivered cash orders (less any wallet part) - completed deposits
 *   rider withdrawable   = delivered earnings + bonuses - approved and pending withdrawals
 *   restaurant balance   = getWalletSummaries(): totalEarnings - totalWithdrawn (not floored at 0)
 * Old (as the balances step reads them):
 *   rider cash in hand   = collected_cash
 *   rider withdrawable   = total_earning - total_withdrawn - pending_withdraw
 *   restaurant balance   = total_earning - total_withdrawn - pending_withdraw - collected_cash
 */
import { prisma } from '../../src/config/prisma.js';
import { getWalletSummaries } from '../../src/modules/food/restaurant/services/restaurantFinance.service.js';
import { loadIdMap } from './idMap.mjs';
import { storeOwners } from './steps/balances.mjs';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const sumBy = (rows, key, field) => new Map(rows.map((row) => [String(row[key]), Number(row._sum[field]) || 0]));

/** Every rider's and restaurant's balances here, by new id. */
export async function walletsHere() {
    const [partners, restaurants] = await Promise.all([
        prisma.foodDeliveryPartner.findMany({ select: { id: true, name: true } }),
        prisma.foodRestaurant.findMany({ select: { id: true, restaurantName: true } }),
    ]);
    const [cashOrders, earned, deposits, bonuses, taken] = await Promise.all([
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { orderStatus: 'delivered', paymentMethod: 'cash', dispatchDeliveryPartnerId: { not: null } },
            _sum: { total: true, walletAmount: true },
        }),
        prisma.foodOrder.groupBy({
            by: ['dispatchDeliveryPartnerId'],
            where: { orderStatus: 'delivered', dispatchDeliveryPartnerId: { not: null } },
            _sum: { riderEarning: true },
        }),
        prisma.foodDeliveryCashDeposit.groupBy({ by: ['deliveryPartnerId'], where: { status: 'Completed' }, _sum: { amount: true } }),
        prisma.deliveryBonusTransaction.groupBy({ by: ['deliveryPartnerId'], _sum: { amount: true } }),
        prisma.foodDeliveryWithdrawal.groupBy({
            by: ['deliveryPartnerId'], where: { status: { in: ['approved', 'pending'] } }, _sum: { amount: true },
        }),
    ]);
    const collected = new Map(cashOrders.map((row) => [String(row.dispatchDeliveryPartnerId),
        (Number(row._sum.total) || 0) - (Number(row._sum.walletAmount) || 0)]));
    const earnings = sumBy(earned, 'dispatchDeliveryPartnerId', 'riderEarning');
    const deposited = sumBy(deposits, 'deliveryPartnerId', 'amount');
    const bonus = sumBy(bonuses, 'deliveryPartnerId', 'amount');
    const withdrawn = sumBy(taken, 'deliveryPartnerId', 'amount');

    const riders = new Map(partners.map((p) => [p.id, {
        name: p.name,
        cash: money((collected.get(p.id) || 0) - (deposited.get(p.id) || 0)),
        pocket: money((earnings.get(p.id) || 0) + (bonus.get(p.id) || 0) - (withdrawn.get(p.id) || 0)),
    }]));

    const summaries = await getWalletSummaries(restaurants.map((r) => r.id));
    const stores = new Map(restaurants.map((r) => [r.id, {
        name: r.restaurantName,
        // Not floored at 0 as the app shows it, so a negative balance still shows movement.
        balance: money(Number(summaries.get(r.id)?.totalEarnings) - Number(summaries.get(r.id)?.totalWithdrawn)),
    }]));
    return { riders, restaurants: stores };
}

/** The old system's wallets in one copy of its database, by NEW id (through legacy.id_map). */
export async function walletsOld(mysql) {
    const riderMap = await loadIdMap('delivery_partner');
    const restaurantMap = await loadIdMap('restaurant');
    const [riderWallets] = await mysql.query('SELECT * FROM delivery_man_wallets');
    const [storeWallets] = await mysql.query('SELECT * FROM store_wallets');
    const storeByVendor = await storeOwners(mysql);

    const riders = new Map();
    for (const w of riderWallets) {
        const id = riderMap.get(String(w.delivery_man_id));
        if (!id) continue;
        riders.set(id, {
            cash: money(w.collected_cash),
            pocket: money(Number(w.total_earning) - Number(w.total_withdrawn) - Number(w.pending_withdraw)),
        });
    }
    // Daily payouts the old system has scheduled but not yet paid. Its balance
    // already leaves them out (pending_withdraw); here they are not ledger rows
    // until the old system completes them and a later sync brings them in.
    const [pendingPayouts] = await mysql.query(`
        SELECT store_id, SUM(disbursement_amount) AS amount FROM disbursement_details
         WHERE status = 'pending' AND store_id IS NOT NULL GROUP BY store_id`);
    const pendingByStore = new Map(pendingPayouts.map((row) => [String(row.store_id), money(row.amount)]));

    const restaurants = new Map();
    for (const w of storeWallets) {
        const storeId = storeByVendor.get(String(w.vendor_id)) || '';
        const id = restaurantMap.get(storeId);
        if (!id) continue;
        restaurants.set(id, {
            balance: money((Number(w.total_earning) - Number(w.total_withdrawn)
                - Number(w.pending_withdraw) - Number(w.collected_cash))),
            pendingPayouts: pendingByStore.get(storeId) || 0,
        });
    }
    return { riders, restaurants };
}

/**
 * Rows of the wallet table: one per rider/restaurant and measure whose
 * balance moved here or in the old system, worst gap first.
 */
export function walletRows({ before, after, oldBase, oldNow }) {
    const rows = [];
    const add = (kind, measure, ids, pick, names, pendingOf = () => 0) => {
        for (const id of ids) {
            const b = pick(before, id);
            const a = pick(after, id);
            const ob = pick(oldBase, id);
            const on = pick(oldNow, id);
            const movedHere = money((a ?? 0) - (b ?? 0));
            // A wallet that did not exist on one side (a new rider) started at 0 there.
            const movedOld = on === undefined && ob === undefined ? null : money((on ?? 0) - (ob ?? 0));
            if (b === undefined && a === undefined) continue;
            const gap = movedOld === null ? null : money(movedHere - movedOld);
            // Old payouts scheduled but not yet paid: their change explains
            // that much of the gap (the old balance already excludes them).
            const pendingMoved = money((pendingOf(oldNow, id) || 0) - (pendingOf(oldBase, id) || 0));
            rows.push({
                moved: movedHere !== 0 || Boolean(movedOld) || (b === undefined) !== (a === undefined),
                kind, measure, id, name: names(id),
                before: b ?? null, after: a ?? null, movedHere,
                oldBase: ob ?? null, oldNow: on ?? null, movedOld,
                gap,
                pendingMoved,
                unexplained: gap === null ? null : money(gap - pendingMoved),
                afterVsOld: on === undefined || a === undefined ? null : money(a - on),
            });
        }
    };
    const riderIds = new Set([...after.riders.keys(), ...oldNow.riders.keys()]);
    const storeIds = new Set([...after.restaurants.keys(), ...oldNow.restaurants.keys()]);
    const riderName = (id) => after.riders.get(id)?.name || id;
    const storeName = (id) => after.restaurants.get(id)?.name || id;
    add('rider', 'cash in hand', riderIds, (w, id) => w.riders.get(id)?.cash, riderName);
    add('rider', 'withdrawable', riderIds, (w, id) => w.riders.get(id)?.pocket, riderName);
    add('restaurant', 'balance', storeIds, (w, id) => w.restaurants.get(id)?.balance, storeName,
        (w, id) => w.restaurants.get(id)?.pendingPayouts);
    return rows.sort((x, y) => Math.abs(y.unexplained ?? y.movedHere) - Math.abs(x.unexplained ?? x.movedHere));
}

export function printWallets(allRows, { dryRun }) {
    const fmt = (v) => (v === null || v === undefined ? '—' : v.toFixed(2)).padStart(12);
    const header = () => console.log(`   ${'who'.padEnd(36)} ${'measure'.padEnd(13)}${['before', 'after', 'moved here', 'old base', 'old now', 'moved old', 'gap', 'old unpaid', 'unexplained', 'after−old'].map((h) => h.padStart(12)).join('')}`);
    const line = (r) => console.log(`   ${`${r.kind} ${r.name}`.slice(0, 36).padEnd(36)} ${r.measure.padEnd(13)}${[r.before, r.after, r.movedHere, r.oldBase, r.oldNow, r.movedOld, r.gap, r.pendingMoved, r.unexplained, r.afterVsOld].map(fmt).join('')}`);
    const rows = allRows.filter((r) => r.moved);
    console.log(`\n── wallets: here before → after${dryRun ? ' (would be)' : ''}, against the old system's wallet at the baseline copy → now ──`);
    console.log('   "moved here" should equal "moved old"; "gap" is the difference. "old unpaid" is the change in daily payouts the old');
    console.log('   system has scheduled but not paid (its balance already excludes them; here they arrive once paid), and "unexplained"');
    console.log('   is the gap without them. "after−old" is where the two systems disagree after the sync. Restaurant balances are');
    console.log('   not floored at 0 on either side (the app shows a negative one as 0). "—": no wallet on that side.');
    if (!rows.length) console.log('   no balance moved in either system');
    else header();
    const totals = {};
    for (const r of rows) {
        line(r);
        const key = `${r.kind} ${r.measure}`;
        totals[key] ??= { movedHere: 0, movedOld: 0, pending: 0, n: 0 };
        totals[key].movedHere += r.movedHere;
        totals[key].movedOld += r.movedOld || 0;
        totals[key].n += 1;
        totals[key].pending += r.pendingMoved || 0;
    }
    for (const [key, t] of Object.entries(totals)) {
        console.log(`   total ${key}: ${t.n} wallet(s), moved here ${money(t.movedHere).toFixed(2)}, moved old ${money(t.movedOld).toFixed(2)}, gap ${money(t.movedHere - t.movedOld).toFixed(2)}, of which old unpaid payouts ${money(t.pending).toFixed(2)}, unexplained ${money(t.movedHere - t.movedOld - t.pending).toFixed(2)}`);
    }
    const standing = allRows
        .filter((r) => !r.moved && r.afterVsOld)
        .sort((x, y) => Math.abs(y.afterVsOld) - Math.abs(x.afterVsOld));
    if (standing.length) {
        console.log(`\n   wallets the sync does not move but that already differ from the old system (${standing.length}; largest 15):`);
        header();
        standing.slice(0, 15).forEach(line);
    }
}
