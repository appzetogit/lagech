import test from 'node:test';
import assert from 'node:assert/strict';

import {
    computeWalletBonus,
    pickWalletBonus,
    pointsForOrder,
    walletAmountForPoints,
    conversionProblem,
    createdAtRange,
    istMonthStart,
    walletSourceOf,
    normalizeEmail,
    toCsv,
} from './customerRewards.util.js';

const now = new Date('2026-10-05T10:00:00Z');
const running = { isActive: true, startDate: '2026-10-01T00:00:00Z', endDate: '2026-10-31T00:00:00Z' };

test('a percentage bonus is a share of the top-up, capped, and needs the minimum', () => {
    const rule = { ...running, bonusType: 'percentage', bonusAmount: 10, minimumAddAmount: 500, maximumBonus: 75 };
    assert.equal(computeWalletBonus(rule, 499), 0, 'below the minimum earns nothing');
    assert.equal(computeWalletBonus(rule, 500), 50);
    assert.equal(computeWalletBonus(rule, 2000), 75, 'capped');
    assert.equal(computeWalletBonus({ ...rule, maximumBonus: 0 }, 2000), 200, '0 means uncapped');
    assert.equal(computeWalletBonus({ ...rule, bonusAmount: 3.33, minimumAddAmount: 0, maximumBonus: 0 }, 101), 3.36);
});

test('a fixed bonus pays its amount whatever the top-up, once the minimum is met', () => {
    const rule = { ...running, bonusType: 'amount', bonusAmount: 40, minimumAddAmount: 300, maximumBonus: 10 };
    assert.equal(computeWalletBonus(rule, 299.99), 0);
    assert.equal(computeWalletBonus(rule, 300), 40, 'the cap is for percentage bonuses only');
});

test('only running, switched-on rules apply, and the best one wins', () => {
    const small = { ...running, id: 'a', bonusType: 'amount', bonusAmount: 20, minimumAddAmount: 0 };
    const big = { ...running, id: 'b', bonusType: 'percentage', bonusAmount: 10, minimumAddAmount: 0 };
    const off = { ...big, id: 'c', isActive: false, bonusAmount: 50 };
    const expired = { ...big, id: 'd', endDate: '2026-10-04T00:00:00Z', bonusAmount: 50 };
    const future = { ...big, id: 'e', startDate: '2026-10-06T00:00:00Z', bonusAmount: 50 };

    assert.equal(pickWalletBonus([small, big, off, expired, future], 100, now).rule.id, 'a', '₹20 beats 10% of 100');
    assert.equal(pickWalletBonus([small, big, off, expired, future], 1000, now).rule.id, 'b', '10% of 1000 beats ₹20');
    assert.equal(pickWalletBonus([off, expired, future], 1000, now), null);
    assert.equal(pickWalletBonus([], 1000, now), null);
});

test('points are earned per ₹100 of the order, whole points only, and only when switched on', () => {
    const settings = { isEnabled: true, pointsPerHundred: 5, pointsPerRupee: 10, minimumConvertPoints: 100 };
    assert.equal(pointsForOrder(settings, 0), 0);
    assert.equal(pointsForOrder(settings, 99), 4, '4.95 rounds down');
    assert.equal(pointsForOrder(settings, 100), 5);
    assert.equal(pointsForOrder(settings, 1234.5), 61);
    assert.equal(pointsForOrder({ ...settings, isEnabled: false }, 1000), 0);
    assert.equal(pointsForOrder({ ...settings, pointsPerHundred: 0.5 }, 1000), 5);
});

test('points convert into wallet rupees at the set rate, rounded down to paise', () => {
    const settings = { isEnabled: true, pointsPerHundred: 5, pointsPerRupee: 3, minimumConvertPoints: 10 };
    assert.equal(walletAmountForPoints(settings, 30), 10);
    assert.equal(walletAmountForPoints(settings, 10), 3.33);
    assert.equal(walletAmountForPoints({ ...settings, pointsPerRupee: 0 }, 100), 0);
});

test('a conversion is refused for the reasons a customer can fix', () => {
    const settings = { isEnabled: true, pointsPerHundred: 5, pointsPerRupee: 10, minimumConvertPoints: 100 };
    assert.equal(conversionProblem(settings, 100, 150), null);
    assert.match(conversionProblem(settings, 99, 150), /at least 100/);
    assert.match(conversionProblem(settings, 200, 150), /do not have/);
    assert.match(conversionProblem(settings, 10.5, 150), /whole number/);
    assert.match(conversionProblem(settings, -5, 150), /whole number/);
    assert.match(conversionProblem({ ...settings, isEnabled: false }, 100, 150), /switched off/);
    assert.match(conversionProblem({ ...settings, pointsPerRupee: 0 }, 100, 150), /not set up/);
    assert.match(conversionProblem({ ...settings, pointsPerRupee: 1000, minimumConvertPoints: 0 }, 5, 150), /0\.01/);
});

test('report dates are whole days in Indian time', () => {
    const range = createdAtRange('2026-10-01', '2026-10-05');
    assert.equal(range.gte.toISOString(), '2026-09-30T18:30:00.000Z');
    assert.equal(range.lte.toISOString(), '2026-10-05T18:29:59.999Z');
    assert.deepEqual(createdAtRange('', 'nonsense'), undefined);
    assert.deepEqual(Object.keys(createdAtRange('2026-10-01', '')), ['gte']);
    // 1 Oct 00:10 IST is still September in UTC.
    assert.equal(istMonthStart(new Date('2026-09-30T18:40:00Z')).toISOString(), '2026-09-30T18:30:00.000Z');
});

test('every wallet writer is reported under a named source', () => {
    assert.equal(walletSourceOf({ category: 'adjustment', metadata: { source: 'admin_add_fund' } }), 'add_fund');
    assert.equal(walletSourceOf({ category: 'wallet_topup', metadata: { source: 'wallet_bonus' } }), 'bonus');
    assert.equal(walletSourceOf({ category: 'wallet_topup', metadata: { source: 'cashback' } }), 'cashback');
    assert.equal(walletSourceOf({ category: 'wallet_topup', metadata: { source: 'wallet_topup' } }), 'top_up');
    assert.equal(walletSourceOf({ category: 'adjustment', metadata: { source: 'loyalty_conversion' } }), 'loyalty_point');
    assert.equal(walletSourceOf({ category: 'order_refund', metadata: null }), 'refund');
    assert.equal(walletSourceOf({ category: 'order_payment', metadata: { method: 'wallet' } }), 'order_payment');
    assert.equal(walletSourceOf({ category: 'referral_reward' }), 'referral');
    assert.equal(walletSourceOf({ category: 'adjustment' }), 'other');
});

test('emails are trimmed and lower-cased, and junk is refused', () => {
    assert.equal(normalizeEmail('  Asha@Example.COM '), 'asha@example.com');
    assert.equal(normalizeEmail('not-an-email'), null);
    assert.equal(normalizeEmail('a@b'), null);
    assert.equal(normalizeEmail(''), null);
    assert.equal(normalizeEmail(`${'a'.repeat(250)}@b.com`), null);
});

test('CSV cells are quoted when needed and cannot run as formulas', () => {
    const csv = toCsv(['Email', 'Note'], [['a@b.com', 'x, "y"'], ['=HYPERLINK("bad")', null]]);
    assert.equal(csv, 'Email,Note\r\na@b.com,"x, ""y"""\r\n"\'=HYPERLINK(""bad"")",\r\n');
});
