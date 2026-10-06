/**
 * Pure arithmetic and parsing for the customer wallet bonus, loyalty points,
 * the wallet report and the newsletter list. No database and no packages, so
 * the rules that decide how much money moves can be tested on their own.
 */

/** Round to paise. */
export const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** Rounded DOWN to paise: a payout never rounds up in the customer's favour by accident or ours. */
const floor2 = (value) => Math.floor((Number(value) || 0) * 100 + 1e-9) / 100;

export const BONUS_TYPES = ['percentage', 'amount'];

/**
 * What one bonus rule pays on a top-up of `addAmount` rupees. 0 when the
 * top-up is below the rule's minimum.
 */
export const computeWalletBonus = (rule, addAmount) => {
    const amount = Number(addAmount) || 0;
    if (!rule || amount <= 0) return 0;
    if (amount < (Number(rule.minimumAddAmount) || 0)) return 0;

    const value = Number(rule.bonusAmount) || 0;
    if (value <= 0) return 0;

    if (rule.bonusType === 'amount') return floor2(value);

    let bonus = (amount * value) / 100;
    const cap = Number(rule.maximumBonus) || 0;
    if (cap > 0) bonus = Math.min(bonus, cap);
    return floor2(bonus);
};

/** Is the rule switched on and running at `now`? */
export const isBonusRunning = (rule, now = new Date()) => {
    if (!rule || !rule.isActive) return false;
    const t = now.getTime();
    return new Date(rule.startDate).getTime() <= t && new Date(rule.endDate).getTime() >= t;
};

/**
 * Of the rules running now, the one that pays the most on this top-up.
 * Returns `{ rule, amount }` or null when nothing applies.
 */
export const pickWalletBonus = (rules = [], addAmount, now = new Date()) => {
    let best = null;
    for (const rule of rules) {
        if (!isBonusRunning(rule, now)) continue;
        const amount = computeWalletBonus(rule, addAmount);
        if (amount > 0 && (!best || amount > best.amount)) best = { rule, amount };
    }
    return best;
};

/** Whole points earned on a delivered order of `orderTotal` rupees. */
export const pointsForOrder = (settings, orderTotal) => {
    if (!settings?.isEnabled) return 0;
    const rate = Number(settings.pointsPerHundred) || 0;
    const total = Number(orderTotal) || 0;
    if (rate <= 0 || total <= 0) return 0;
    return Math.floor((total * rate) / 100 + 1e-9);
};

/** Wallet rupees that `points` convert into, rounded down to paise. */
export const walletAmountForPoints = (settings, points) => {
    const perRupee = Number(settings?.pointsPerRupee) || 0;
    const n = Number(points) || 0;
    if (perRupee <= 0 || n <= 0) return 0;
    return floor2(n / perRupee);
};

/**
 * Why `points` cannot be converted right now, or null when they can.
 * The balance check here is advisory -- the database guard is what holds.
 */
export const conversionProblem = (settings, points, balance) => {
    const n = Number(points);
    if (!settings?.isEnabled) return 'Loyalty points are switched off';
    if (!(Number(settings.pointsPerRupee) > 0)) return 'Point conversion is not set up';
    if (!Number.isInteger(n) || n <= 0) return 'Enter a whole number of points';
    const minimum = Number(settings.minimumConvertPoints) || 0;
    if (n < minimum) return `Convert at least ${minimum} points`;
    if (n > (Number(balance) || 0)) return 'You do not have that many points';
    if (walletAmountForPoints(settings, n) <= 0) return 'Too few points to make ₹0.01';
    return null;
};

// ─── Dates (the business runs on Indian time) ────────────────────────────────

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** 'YYYY-MM-DD' → that day's first instant in IST. Null for anything else. */
export const istDayStart = (value) => {
    const s = String(value || '').slice(0, 10);
    if (!DAY.test(s)) return null;
    const d = new Date(`${s}T00:00:00.000+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** 'YYYY-MM-DD' → that day's last instant in IST. Null for anything else. */
export const istDayEnd = (value) => {
    const s = String(value || '').slice(0, 10);
    if (!DAY.test(s)) return null;
    const d = new Date(`${s}T23:59:59.999+05:30`);
    return Number.isNaN(d.getTime()) ? null : d;
};

/** `{ from, to }` query strings → a Prisma `createdAt` filter, or undefined. */
export const createdAtRange = (from, to) => {
    const gte = istDayStart(from);
    const lte = istDayEnd(to);
    if (!gte && !lte) return undefined;
    return { ...(gte ? { gte } : {}), ...(lte ? { lte } : {}) };
};

/** The first instant of the current month in IST. */
export const istMonthStart = (now = new Date()) => {
    const ist = new Date(now.getTime() + 330 * 60000);
    const y = ist.getUTCFullYear();
    const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
    return new Date(`${y}-${m}-01T00:00:00.000+05:30`);
};

// ─── Wallet report sources ───────────────────────────────────────────────────

/**
 * Where a wallet ledger entry came from, as the report names it. The ledger's
 * category is coarse (a bonus and a top-up are both 'wallet_topup'), so the
 * metadata.source each writer stamps decides first.
 */
export const WALLET_SOURCES = {
    add_fund: { label: 'Added by admin', where: { metadata: { path: ['source'], equals: 'admin_add_fund' } } },
    top_up: { label: 'Top-up', where: { category: 'wallet_topup', metadata: { path: ['source'], equals: 'wallet_topup' } } },
    bonus: { label: 'Top-up bonus', where: { metadata: { path: ['source'], equals: 'wallet_bonus' } } },
    cashback: { label: 'Cashback', where: { metadata: { path: ['source'], equals: 'cashback' } } },
    loyalty_point: { label: 'Loyalty points', where: { metadata: { path: ['source'], equals: 'loyalty_conversion' } } },
    refund: { label: 'Refund', where: { category: 'order_refund' } },
    order_payment: { label: 'Order payment', where: { category: 'order_payment' } },
    referral: { label: 'Referral reward', where: { category: 'referral_reward' } },
};

export const walletSourceOf = (row) => {
    const source = row?.metadata && typeof row.metadata === 'object' ? row.metadata.source : null;
    if (source === 'admin_add_fund') return 'add_fund';
    if (source === 'wallet_bonus') return 'bonus';
    if (source === 'cashback') return 'cashback';
    if (source === 'loyalty_conversion') return 'loyalty_point';
    switch (row?.category) {
        case 'wallet_topup': return 'top_up';
        case 'order_refund': return 'refund';
        case 'order_payment': return 'order_payment';
        case 'referral_reward': return 'referral';
        default: return 'other';
    }
};

// ─── Newsletter ──────────────────────────────────────────────────────────────

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Trimmed, lower-cased email, or null when it is not one. */
export const normalizeEmail = (value) => {
    const email = String(value || '').trim().toLowerCase();
    if (!email || email.length > 255 || !EMAIL.test(email)) return null;
    return email;
};

/** One CSV cell, quoted when it needs to be, and defused against spreadsheet formulas. */
export const csvCell = (value) => {
    let s = value === null || value === undefined ? '' : String(value);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCsv = (header, rows) =>
    [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
