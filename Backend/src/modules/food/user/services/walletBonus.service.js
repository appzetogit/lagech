import { prisma } from '../../../../config/prisma.js';
import { pickWalletBonus } from '../../shared/customerRewards.util.js';

/**
 * Wallet top-up bonus rules, customer side: which rules are running, and which
 * one a given top-up earns. The admin edits the rules
 * (admin/services/adminCustomerExtras.service.js); the credit itself happens in
 * verifyWalletTopupPayment, as its own ledger entry.
 */

export const serializeWalletBonus = (row, now = new Date()) => {
    const start = new Date(row.startDate).getTime();
    const end = new Date(row.endDate).getTime();
    const t = now.getTime();
    const state = !row.isActive ? 'off' : t < start ? 'scheduled' : t > end ? 'expired' : 'running';
    return {
        id: row.id,
        title: row.title,
        description: row.description,
        bonusType: row.bonusType,
        bonusAmount: Number(row.bonusAmount),
        minimumAddAmount: Number(row.minimumAddAmount),
        maximumBonus: Number(row.maximumBonus),
        startDate: row.startDate,
        endDate: row.endDate,
        isActive: row.isActive,
        state,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
    };
};

const runningWhere = (now) => ({ isActive: true, startDate: { lte: now }, endDate: { gte: now } });

/** Rules running now, for the customer app's "add money" screen. */
export const listRunningWalletBonuses = async (now = new Date()) => {
    const rows = await prisma.foodWalletBonus.findMany({ where: runningWhere(now), orderBy: { minimumAddAmount: 'asc' } });
    return rows.map((row) => serializeWalletBonus(row, now));
};

/**
 * The running rule that pays the most on a top-up of `addAmount` rupees, as
 * `{ rule, amount }`, or null.
 */
export const findWalletTopupBonus = async (addAmount, now = new Date()) => {
    const rows = await prisma.foodWalletBonus.findMany({ where: runningWhere(now) });
    return pickWalletBonus(rows, addAmount, now);
};
