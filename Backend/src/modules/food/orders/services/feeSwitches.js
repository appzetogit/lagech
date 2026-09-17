/**
 * The admin's on/off switches for the optional charges.
 *
 * Each switch gates one rate: GST on items, GST on the delivery fee, and the
 * platform fee. A switched-off charge is priced at 0 while its rate stays
 * saved, so the admin can turn GST on and off without retyping it.
 *
 * Off unless switched on. The previous system charged none of these on any of
 * its orders, and a fee nobody meant to turn on is the worse surprise.
 */
export const FEE_SWITCHES = {
    gstEnabled: 'gstRate',
    deliveryFeeGstEnabled: 'deliveryFeeGstRate',
    platformFeeEnabled: 'platformFee',
};

/**
 * Whether a switch is on for a row. A zone row's null means "same as the
 * default", so it defers to `fallback` (the default row); the default row's
 * own null is off.
 */
export const isFeeSwitchOn = (row, key, fallback = null) => {
    const own = row?.[key];
    if (own === true || own === false) return own;
    return fallback?.[key] === true;
};

/**
 * `row` with every switched-off charge set to 0 and each switch resolved to a
 * plain boolean. Nothing else on the row changes.
 */
export const applyFeeSwitches = (row, fallback = null) => {
    if (!row) return row;
    const result = { ...row };
    for (const [key, field] of Object.entries(FEE_SWITCHES)) {
        const on = isFeeSwitchOn(row, key, fallback);
        result[key] = on;
        if (!on) result[field] = 0;
    }
    return result;
};
