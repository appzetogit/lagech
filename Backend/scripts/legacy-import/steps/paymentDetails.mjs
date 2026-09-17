/**
 * Where restaurants and riders are paid: `disbursement_withdrawal_methods`
 * -> the bank and UPI fields on food_restaurants and food_delivery_partners.
 *
 * The old app kept these apart from the store and rider, one row per method,
 * one of them marked default. Without them the daily payout run lists every
 * restaurant as "no bank account or UPI id on file".
 *
 * Only blank fields are filled: a restaurant or rider who has entered their
 * details on this system since keeps what they entered.
 */
import { prisma } from '../../../src/config/prisma.js';
import { loadIdMap } from '../idMap.mjs';

const clean = (value) => String(value ?? '').trim();

/** Bank and UPI details from one owner's method rows, and which is the default. */
const detailsFrom = (rows) => {
    const bank = {};
    const upi = {};
    let preferred = null;
    // Oldest first, so a later row for the same kind replaces an earlier one.
    for (const row of rows) {
        let fields = {};
        try {
            fields = JSON.parse(row.method_fields || '{}') || {};
        } catch {
            fields = {};
        }
        const isUpi = Boolean(fields.upi_id) || /upi/i.test(row.method_name || '');
        if (isUpi) {
            if (clean(fields.upi_id)) upi.upiId = clean(fields.upi_id);
        } else {
            if (clean(fields.account_number)) bank.accountNumber = clean(fields.account_number).replace(/\s|-/g, '');
            // The old form's key was misspelt "ifsc_cod".
            const ifsc = clean(fields.ifsc_cod || fields.ifsc_code || fields.ifsc).toUpperCase();
            if (ifsc) bank.ifscCode = ifsc;
            if (clean(fields.account_holder_name)) bank.accountHolderName = clean(fields.account_holder_name);
        }
        if (row.is_default === 1) preferred = isUpi ? 'upi' : 'bank';
    }
    return { bank, upi, preferred };
};

/** Only the keys whose current value is blank. */
const blanksOnly = (current, wanted) => Object.fromEntries(
    Object.entries(wanted).filter(([key, value]) => value && !clean(current?.[key])),
);

export async function importPaymentDetails(mysql, report) {
    const restaurants = await loadIdMap('restaurant');
    const riders = await loadIdMap('delivery_partner');
    const [rows] = await mysql.query('SELECT * FROM disbursement_withdrawal_methods ORDER BY id');

    const byOwner = new Map();
    for (const row of rows) {
        const key = row.store_id ? `store:${row.store_id}` : `rider:${row.delivery_man_id}`;
        byOwner.set(key, [...(byOwner.get(key) || []), row]);
    }

    for (const [key, ownerRows] of byOwner) {
        const [kind, legacyId] = key.split(':');
        const { bank, upi, preferred } = detailsFrom(ownerRows);

        if (kind === 'store') {
            const id = restaurants.get(legacyId);
            if (!id) {
                report.skip('payment_details', legacyId, key, 'restaurant not imported');
                continue;
            }
            const current = await prisma.foodRestaurant.findUnique({
                where: { id },
                select: { accountNumber: true, ifscCode: true, accountHolderName: true, upiId: true, payoutMethod: true },
            });
            const data = blanksOnly(current, { ...bank, ...upi, payoutMethod: preferred });
            if (Object.keys(data).length) await prisma.foodRestaurant.update({ where: { id }, data });
            if (bank.accountNumber && !bank.ifscCode) {
                report.warn('payment_details', legacyId, key, 'bank account has no IFSC; it cannot be paid by bank until one is added');
            }
            report.done('payment_details', Object.keys(data).length ? 'updated' : 'created');
        } else {
            const id = riders.get(legacyId);
            if (!id) {
                report.skip('payment_details', legacyId, key, 'rider not imported');
                continue;
            }
            const current = await prisma.foodDeliveryPartner.findUnique({
                where: { id },
                select: { bankAccountNumber: true, bankIfscCode: true, bankAccountHolderName: true, upiId: true },
            });
            const data = blanksOnly(current, {
                bankAccountNumber: bank.accountNumber,
                bankIfscCode: bank.ifscCode,
                bankAccountHolderName: bank.accountHolderName,
                upiId: upi.upiId,
            });
            if (Object.keys(data).length) await prisma.foodDeliveryPartner.update({ where: { id }, data });
            report.done('payment_details', Object.keys(data).length ? 'updated' : 'created');
        }
    }
}
