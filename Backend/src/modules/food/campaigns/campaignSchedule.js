/**
 * Campaign timing and pricing rules, kept free of the database so they are
 * tested directly.
 *
 * A campaign (basic or food) runs while it is switched on and the current
 * moment is between startsAt and endsAt. Both are full date-times, entered in
 * the admin's local time and stored as UTC instants, so "ends 23:59 on the
 * 31st" means exactly that wherever the server runs.
 */

/** 'off', 'scheduled', 'running' or 'expired'. */
export function campaignState(campaign, now = new Date()) {
    if (!campaign.isActive) return 'off';
    if (new Date(campaign.startsAt) > now) return 'scheduled';
    if (new Date(campaign.endsAt) < now) return 'expired';
    return 'running';
}

/** Problems with a start/end pair; empty when it is fine. */
export function scheduleErrors(startsAt, endsAt) {
    const errors = [];
    const start = startsAt instanceof Date ? startsAt : new Date(startsAt);
    const end = endsAt instanceof Date ? endsAt : new Date(endsAt);
    if (!startsAt || Number.isNaN(start.getTime())) errors.push('Start date and time are required');
    if (!endsAt || Number.isNaN(end.getTime())) errors.push('End date and time are required');
    if (!errors.length && end <= start) errors.push('The campaign must end after it starts');
    return errors;
}

/** Problems with a food campaign's price and discount; empty when fine. */
export function discountErrors(price, discountType, discount) {
    const errors = [];
    const p = Number(price);
    const d = Number(discount || 0);
    if (!Number.isFinite(p) || p <= 0) errors.push('Price must be more than 0');
    if (!['percent', 'amount'].includes(discountType)) errors.push('Discount type must be percent or amount');
    if (!Number.isFinite(d) || d < 0) errors.push('Discount cannot be negative');
    else if (discountType === 'percent' && d > 100) errors.push('A percentage discount cannot be more than 100');
    else if (discountType === 'amount' && Number.isFinite(p) && d > p) errors.push('The discount cannot be more than the price');
    return errors;
}

/** What the customer pays, rounded to the paisa and never below zero. */
export function campaignPrice(price, discountType, discount) {
    const p = Number(price) || 0;
    const d = Number(discount) || 0;
    const off = discountType === 'percent' ? (p * d) / 100 : d;
    return Math.max(0, Math.round((p - off) * 100) / 100);
}
