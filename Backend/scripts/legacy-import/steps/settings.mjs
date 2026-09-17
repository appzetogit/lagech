/**
 * Platform settings that decide how the imported business is run, taken from
 * the old `business_settings` rather than left at this system's defaults.
 *
 *   - Restaurant subscriptions. This system bills restaurants monthly unless
 *     the feature is off, and locks their balance against the invoice. The old
 *     system ran every restaurant on commission; left on, the first scheduler
 *     run after the switch invoices all of them and blocks their payouts.
 *   - The rider cash limit (dm_max_cash_in_hand), and the minimum a rider may
 *     withdraw is left as configured.
 *
 * Only settings the old system actually had are touched.
 */
import { prisma } from '../../../src/config/prisma.js';

export async function importSettings(mysql, report) {
    const [rows] = await mysql.query(
        "SELECT `key`, value FROM business_settings WHERE `key` IN ('dm_max_cash_in_hand', 'cash_in_hand_overflow_delivery_man')",
    );
    const setting = new Map(rows.map((row) => [row.key, row.value]));

    const [models] = await mysql.query('SELECT store_business_model AS model, COUNT(*) AS n FROM stores GROUP BY store_business_model');
    const onlyCommission = models.length > 0 && models.every((m) => m.model === 'commission');
    if (onlyCommission) {
        await prisma.foodFeatureSetting.updateMany({
            where: { key: 'restaurant_subscription' },
            data: { isEnabled: false },
        });
        report.warn('settings', '-', 'restaurant_subscription',
            'turned off: every restaurant in the old system was on commission, none on a subscription');
    } else {
        report.warn('settings', '-', 'restaurant_subscription',
            `left as it is: the old system had ${models.map((m) => `${m.n} on ${m.model}`).join(', ')}`);
    }
    report.done('settings', 'updated');

    const limit = Number(setting.get('dm_max_cash_in_hand'));
    const enforced = setting.get('cash_in_hand_overflow_delivery_man') === '1';
    if (Number.isFinite(limit) && limit > 0 && enforced) {
        const current = await prisma.foodDeliveryCashLimit.findFirst({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
        if (current) {
            await prisma.foodDeliveryCashLimit.update({ where: { id: current.id }, data: { deliveryCashLimit: limit } });
        } else {
            await prisma.foodDeliveryCashLimit.create({ data: { deliveryCashLimit: limit, isActive: true } });
        }
        report.done('settings', 'updated');
    } else {
        report.warn('settings', '-', 'cash limit', 'the old system did not enforce a rider cash limit; left as it is');
    }
}
