/**
 * Bounds on the fee boxes, checked before anything is sent.
 *
 * The inputs carry `min` and `max`, but those only steer the spinner arrows and
 * flag the field `:invalid` -- typing is unrestricted and nothing was reading
 * the result, so a GST rate of thirteen billion percent went straight to the
 * server. The server refuses it, but the admin then gets one toast for whatever
 * it complained about first and no idea which of four boxes to fix.
 *
 * These bounds mirror the server's. If you change one, change both.
 */

/** Far enough out that a real setting cannot reach it and a typo always does. */
export const MAX_AMOUNT = 100000;

export const FEE_FIELDS = [
    { key: "platformFee", label: "Platform Fee", max: MAX_AMOUNT, unit: "₹" },
    { key: "quickDeliveryFee", label: "Quick Delivery Extra", max: MAX_AMOUNT, unit: "₹" },
    { key: "gstRate", label: "GST Rate", max: 100, unit: "%" },
    { key: "deliveryFeeGstRate", label: "Delivery Fee GST Rate", max: 100, unit: "%" },
];

/**
 * @returns {string|null} what is wrong with this one value, or null
 */
export const checkFee = (raw, { label, max, unit }) => {
    const value = String(raw ?? "").trim();
    // Blank means "leave it alone", which is how the placeholder reads.
    if (value === "") return null;

    const n = Number(value);
    if (Number.isNaN(n)) return `${label} must be a number`;
    // A number input accepts exponent notation, and "102020202020e233" becomes
    // Infinity rather than something the range check would catch on its own.
    if (!Number.isFinite(n)) return `${label} must be a real number`;
    if (n < 0) return `${label} cannot be negative`;
    if (n > max) {
        return unit === "%"
            ? `${label} cannot be more than 100%`
            : `${label} cannot be more than ${max.toLocaleString("en-IN")}`;
    }
    return null;
};

/**
 * @returns {Record<string, string>} field key to message, empty when all is well
 */
export const validateFeeSettings = (settings = {}) => {
    const errors = {};
    for (const field of FEE_FIELDS) {
        const problem = checkFee(settings[field.key], field);
        if (problem) errors[field.key] = problem;
    }
    return errors;
};
