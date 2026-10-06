import { ValidationError } from '../../../../core/auth/errors.js';
import { validatePayoutValues } from '../../admin/services/payoutMethods.util.js';

/**
 * Offline payment at checkout: the customer picks one of the admin's offline
 * methods (System Settings -> Offline payment), pays outside the app, and
 * fills in that method's fields (a transaction id, say). The order waits in
 * pending_payment until the admin verifies the payment (-> paid, the order goes
 * to the restaurant exactly as a confirmed online payment does) or rejects it
 * (-> payment failed, order cancelled).
 *
 * Pure, so the rules are tested without a database.
 */

export const OFFLINE_STATUS = { PENDING: 'pending', VERIFIED: 'verified', REJECTED: 'rejected' };

/**
 * The record stored on the order (food_orders.offlinePayment): the method as
 * it was when the customer paid -- a later edit of the method must not change
 * what this order says was paid to -- and the customer's values.
 */
export function buildOfflinePaymentRecord(settings, input = {}, now = new Date()) {
    if (!settings?.enabled) throw new ValidationError('Offline payment is not available');
    const request = input && typeof input === 'object' ? input : {};
    const methodId = String(request.methodId ?? '').trim();
    if (!methodId) throw new ValidationError('Choose an offline payment method');
    const method = (settings.methods || []).find((candidate) => candidate.id === methodId && candidate.isActive);
    if (!method) throw new ValidationError('This offline payment method is not available. Please choose another.');

    const values = validatePayoutValues(method.fields, request.fields ?? request.values ?? {});
    return {
        status: OFFLINE_STATUS.PENDING,
        methodId: method.id,
        methodName: method.name,
        paymentInfo: method.paymentInfo,
        fields: method.fields
            .filter((field) => values[field.key])
            .map((field) => ({ key: field.key, label: field.label, value: values[field.key] })),
        customerNote: String(request.note ?? '').trim().slice(0, 300),
        submittedAt: now.toISOString(),
    };
}

/** The record after the admin's decision. */
export function decideOfflinePayment(record, decision, { adminId = null, note = '', now = new Date() } = {}) {
    const base = record && typeof record === 'object' ? record : {};
    const reason = String(note ?? '').trim().slice(0, 300);
    if (decision === OFFLINE_STATUS.REJECTED && !reason) throw new ValidationError('Say why the payment is rejected; the customer is told');
    return {
        ...base,
        status: decision,
        decidedAt: now.toISOString(),
        decidedBy: adminId ? String(adminId) : null,
        adminNote: reason,
    };
}
