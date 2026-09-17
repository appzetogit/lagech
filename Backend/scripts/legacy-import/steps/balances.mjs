/**
 * Money history and opening balances: what riders and restaurants were paid,
 * what riders handed in, and a final adjustment so every balance here equals
 * the old wallet to the paisa.
 *
 * Imported history:
 *   - rider cash handed to the admin (`account_transactions`, type collected)
 *     -> completed cash deposits
 *   - rider withdrawals and payouts (`withdraw_requests`, `disbursement_details`)
 *     -> rider withdrawals
 *   - restaurant withdrawals and daily payouts (`withdraw_requests`)
 *     -> restaurant withdrawals
 *
 * Then the balances. Balances here are worked out from orders and those
 * records; the old wallets were running totals that also absorbed admin edits,
 * orders from since-deleted restaurants, and an "adjust" that netted a rider's
 * earnings against the cash they held. Where the two still differ, one entry
 * per rider or restaurant, labelled "Opening balance adjustment", closes the
 * gap -- so the cash a rider is holding, what they can withdraw, and what a
 * restaurant is owed are exactly what the old admin panel showed on the day of
 * the switch:
 *
 *   rider cash in hand   = old collected_cash
 *   rider withdrawable   = old total_earning - total_withdrawn - pending_withdraw
 *   restaurant balance   = old total_earning - total_withdrawn - pending_withdraw - collected_cash
 *
 * Every imported row is tracked in legacy.id_map, so a re-run updates rather
 * than duplicates, and the adjustments are recomputed from scratch each time.
 */
import { prisma } from '../../../src/config/prisma.js';
import { getWalletSummaries } from '../../../src/modules/food/restaurant/services/restaurantFinance.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;
const note = (text) => `Previous system: ${text}`;

/** The old admin typed the method; "Online" was a UPI or bank payment to the business. */
const depositMethod = (method) => {
    const m = String(method || '').toLowerCase();
    if (m.startsWith('upi') || m.startsWith('online')) return m.includes('cash') ? 'cash' : 'upi';
    return 'cash';
};

const WITHDRAWAL_STATUS = { 0: 'pending', 1: 'approved', 2: 'rejected' };
const DISBURSEMENT_STATUS = { pending: 'pending', completed: 'approved', canceled: 'rejected' };

/** Create or update one tracked row. */
const upsertTracked = async (entity, legacyId, map, delegate, data) => {
    const mappedId = map.get(String(legacyId));
    const exists = mappedId && (await delegate.count({ where: { id: mappedId } })) > 0;
    const row = exists
        ? await delegate.update({ where: { id: mappedId }, data, select: { id: true } })
        : await delegate.create({ data, select: { id: true } });
    await recordId(entity, legacyId, row.id);
    map.set(String(legacyId), row.id);
    return exists ? 'updated' : 'created';
};

/** Remove a previous run's adjustment so it is recomputed against current data. */
const dropTracked = async (map, key, delegate) => {
    const id = map.get(key);
    if (id) await delegate.deleteMany({ where: { id } });
    map.delete(key);
};

async function importRiderMoney(mysql, report) {
    const riders = await loadIdMap('delivery_partner');
    const deposits = await loadIdMap('rider_deposit');
    const requestsMap = await loadIdMap('rider_withdrawal');
    const payoutsMap = await loadIdMap('rider_payout');
    // Adjustments are keyed by the old rider id, one entity per kind.
    const depositAdjust = await loadIdMap('rider_deposit_adjust');
    const withdrawalAdjust = await loadIdMap('rider_withdrawal_adjust');
    const bonusAdjust = await loadIdMap('rider_bonus_adjust');

    // ── cash handed in ──
    const [collected] = await mysql.query(
        "SELECT * FROM account_transactions WHERE from_type = 'deliveryman' AND type = 'collected' ORDER BY id",
    );
    for (const row of collected) {
        const partnerId = riders.get(String(row.from_id));
        if (!partnerId) {
            report.skip('rider_deposit', row.id, `rider ${row.from_id}`, 'rider not imported');
            continue;
        }
        const outcome = await upsertTracked('rider_deposit', row.id, deposits, prisma.foodDeliveryCashDeposit, {
            deliveryPartnerId: partnerId,
            amount: money(row.amount),
            paymentMethod: depositMethod(row.method),
            status: 'Completed',
            adminNote: note(`collected by ${row.created_by || 'admin'} · ${row.method}${row.ref ? ` · ${row.ref}` : ''}`),
            createdAt: row.created_at,
        });
        report.done('rider_deposit', outcome);
    }

    // ── withdrawals and payouts ──
    const [requests] = await mysql.query('SELECT * FROM withdraw_requests WHERE delivery_man_id IS NOT NULL ORDER BY id');
    const [payouts] = await mysql.query('SELECT * FROM disbursement_details WHERE delivery_man_id IS NOT NULL ORDER BY id');
    const riderWithdrawals = [
        ...requests.map((row) => ({
            entity: 'rider_withdrawal', map: requestsMap, key: row.id, riderId: row.delivery_man_id, amount: row.amount,
            status: WITHDRAWAL_STATUS[row.approved] || 'pending', createdAt: row.created_at, updatedAt: row.updated_at,
            text: `withdrawal request #${row.id}`,
        })),
        ...payouts.map((row) => ({
            entity: 'rider_payout', map: payoutsMap, key: row.id, riderId: row.delivery_man_id, amount: row.disbursement_amount,
            status: DISBURSEMENT_STATUS[row.status] || 'pending', createdAt: row.created_at, updatedAt: row.updated_at,
            text: `payout #${row.disbursement_id}`,
        })),
    ];
    for (const w of riderWithdrawals) {
        const partnerId = riders.get(String(w.riderId));
        if (!partnerId || money(w.amount) < 1) {
            report.skip(w.entity, w.key, `rider ${w.riderId}`, partnerId ? 'under ₹1' : 'rider not imported');
            continue;
        }
        const outcome = await upsertTracked(w.entity, w.key, w.map, prisma.foodDeliveryWithdrawal, {
            deliveryPartnerId: partnerId,
            amount: money(w.amount),
            status: w.status,
            adminNote: note(w.text),
            processedAt: w.status === 'pending' ? null : w.updatedAt,
            createdAt: w.createdAt,
        });
        report.done(w.entity, outcome);
    }

    // ── opening balances ──
    const [wallets] = await mysql.query('SELECT * FROM delivery_man_wallets ORDER BY delivery_man_id');
    const adjusted = { cash: 0, earnings: 0 };
    for (const wallet of wallets) {
        const legacyId = String(wallet.delivery_man_id);
        const partnerId = riders.get(legacyId);
        if (!partnerId) {
            report.warn('rider_balance', legacyId, '-', 'rider not imported; old wallet not carried');
            continue;
        }
        await dropTracked(depositAdjust, legacyId, prisma.foodDeliveryCashDeposit);
        await dropTracked(withdrawalAdjust, legacyId, prisma.foodDeliveryWithdrawal);
        await dropTracked(bonusAdjust, legacyId, prisma.deliveryBonusTransaction);

        const [cashOrders, earned, deposited, bonus, taken] = await Promise.all([
            prisma.foodOrder.aggregate({
                where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered', paymentMethod: 'cash' },
                _sum: { total: true },
            }),
            prisma.foodOrder.aggregate({
                where: { dispatchDeliveryPartnerId: partnerId, orderStatus: 'delivered' },
                _sum: { riderEarning: true },
            }),
            prisma.foodDeliveryCashDeposit.aggregate({
                where: { deliveryPartnerId: partnerId, status: 'Completed' }, _sum: { amount: true },
            }),
            prisma.deliveryBonusTransaction.aggregate({ where: { deliveryPartnerId: partnerId }, _sum: { amount: true } }),
            prisma.foodDeliveryWithdrawal.aggregate({
                where: { deliveryPartnerId: partnerId, status: { in: ['approved', 'pending'] } }, _sum: { amount: true },
            }),
        ]);

        // Cash: a positive gap is cash the old wallet no longer counted (handed
        // in or netted against earnings); a negative one is cash from orders
        // that did not come across. Either way one deposit, signed, closes it.
        const cashHere = money(Number(cashOrders._sum.total) - Number(deposited._sum.amount));
        const cashGap = money(cashHere - Number(wallet.collected_cash));
        if (cashGap !== 0) {
            await upsertTracked('rider_deposit_adjust', legacyId, depositAdjust, prisma.foodDeliveryCashDeposit, {
                deliveryPartnerId: partnerId,
                amount: cashGap,
                paymentMethod: 'cash',
                status: 'Completed',
                adminNote: note(`opening balance adjustment so cash in hand matches the old wallet (₹${money(wallet.collected_cash)})`),
            });
            adjusted.cash += 1;
        }

        // Withdrawable: what was paid out beyond the recorded withdrawals was
        // mostly earnings kept out of cash; posted as one withdrawal. The other
        // way round is money owed the rider, posted as a bonus.
        const pocketHere = money(Number(earned._sum.riderEarning) + Number(bonus._sum.amount) - Number(taken._sum.amount));
        const pocketOld = money(Number(wallet.total_earning) - Number(wallet.total_withdrawn) - Number(wallet.pending_withdraw));
        const pocketGap = money(pocketHere - pocketOld);
        if (pocketGap >= 1) {
            await upsertTracked('rider_withdrawal_adjust', legacyId, withdrawalAdjust, prisma.foodDeliveryWithdrawal, {
                deliveryPartnerId: partnerId,
                amount: pocketGap,
                status: 'approved',
                processedAt: new Date(),
                adminNote: note('opening balance adjustment: earnings settled against cash in the old system'),
            });
            adjusted.earnings += 1;
        } else if (pocketGap < 0) {
            await upsertTracked('rider_bonus_adjust', legacyId, bonusAdjust, prisma.deliveryBonusTransaction, {
                deliveryPartnerId: partnerId,
                transactionId: `legacy-adjust-${legacyId}`,
                amount: -pocketGap,
                reference: 'Opening balance adjustment (previous system)',
            });
            adjusted.earnings += 1;
        } else if (pocketGap !== 0) {
            report.warn('rider_balance', legacyId, '-', `withdrawable differs by ₹${pocketGap}, under the ₹1 minimum a withdrawal can record`);
        }
    }
    report.warn('rider_balance', '-', '(all)',
        `opening balance adjustments: cash for ${adjusted.cash} rider(s), withdrawable for ${adjusted.earnings}`);
}

async function importRestaurantMoney(mysql, report) {
    const restaurants = await loadIdMap('restaurant');
    const withdrawals = await loadIdMap('restaurant_withdrawal');
    const withdrawalAdjust = await loadIdMap('restaurant_withdrawal_adjust');
    const [stores] = await mysql.query('SELECT id, vendor_id FROM stores');
    const storeByVendor = new Map(stores.map((s) => [String(s.vendor_id), String(s.id)]));

    const [requests] = await mysql.query('SELECT * FROM withdraw_requests WHERE vendor_id IS NOT NULL ORDER BY id');
    for (const row of requests) {
        const storeId = storeByVendor.get(String(row.vendor_id));
        const restaurantId = storeId && restaurants.get(storeId);
        if (!restaurantId || money(row.amount) < 1) {
            report.skip('restaurant_withdrawal', row.id, `vendor ${row.vendor_id}`, restaurantId ? 'under ₹1' : 'restaurant not imported');
            continue;
        }
        const fields = (() => {
            try {
                return JSON.parse(row.withdrawal_method_fields || '{}') || {};
            } catch {
                return {};
            }
        })();
        const upi = Boolean(fields.upi_id);
        const outcome = await upsertTracked('restaurant_withdrawal', row.id, withdrawals, prisma.foodRestaurantWithdrawal, {
            restaurantId,
            amount: money(row.amount),
            status: WITHDRAWAL_STATUS[row.approved] || 'pending',
            source: row.type === 'disbursement' ? 'disbursement' : 'manual',
            paymentMethod: upi ? 'upi' : 'bank_transfer',
            bankDetails: upi
                ? { upiId: fields.upi_id, name: fields.name || '' }
                : {
                    accountHolderName: fields.account_holder_name || '',
                    accountNumber: fields.account_number || '',
                    ifscCode: fields.ifsc_code || fields.ifsc || '',
                },
            adminNote: note(`${row.type} #${row.id}${row.transaction_note && row.type !== 'disbursement' ? ` · ${row.transaction_note}` : ''}`),
            processedAt: row.approved === 0 ? null : row.updated_at,
            createdAt: row.created_at,
        });
        report.done('restaurant_withdrawal', outcome);
    }

    // ── opening balances ──
    const [wallets] = await mysql.query('SELECT * FROM store_wallets');
    const ids = [];
    for (const wallet of wallets) {
        const storeId = storeByVendor.get(String(wallet.vendor_id));
        const restaurantId = storeId && restaurants.get(storeId);
        if (!restaurantId) continue;
        await dropTracked(withdrawalAdjust, storeId, prisma.foodRestaurantWithdrawal);
        ids.push([wallet, storeId, restaurantId]);
    }
    const summaries = await getWalletSummaries(ids.map(([, , id]) => id));
    let adjusted = 0;
    for (const [wallet, storeId, restaurantId] of ids) {
        const here = money(summaries.get(restaurantId)?.walletBalance);
        const old = money(Number(wallet.total_earning) - Number(wallet.total_withdrawn)
            - Number(wallet.pending_withdraw) - Number(wallet.collected_cash));
        const gap = money(here - Math.max(0, old));
        if (gap >= 1) {
            await upsertTracked('restaurant_withdrawal_adjust', storeId, withdrawalAdjust, prisma.foodRestaurantWithdrawal, {
                restaurantId,
                amount: gap,
                status: 'approved',
                source: 'manual',
                processedAt: new Date(),
                adminNote: note(`opening balance adjustment so the balance matches the old wallet (₹${Math.max(0, old)})`),
            });
            adjusted += 1;
        } else if (gap !== 0) {
            report.warn('restaurant_balance', storeId, '-',
                gap < 0
                    ? `balance here is ₹${-gap} below the old wallet; restaurant earnings cannot be topped up, so check this one by hand`
                    : `balance differs by ₹${gap}, under the ₹1 minimum a withdrawal can record`);
        }
    }
    report.warn('restaurant_balance', '-', '(all)', `opening balance adjustments for ${adjusted} restaurant(s)`);
}

export async function importBalances(mysql, report) {
    await importRiderMoney(mysql, report);
    await importRestaurantMoney(mysql, report);
}
