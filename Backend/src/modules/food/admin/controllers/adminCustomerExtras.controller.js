import { sendResponse } from '../../../../utils/response.js';
import * as extras from '../services/adminCustomerExtras.service.js';

const handle = (message, run) => async (req, res, next) => {
    try {
        return sendResponse(res, 200, message, await run(req));
    } catch (error) {
        return next(error);
    }
};

export const searchCustomers = handle('Customers fetched', async (req) => ({
    customers: await extras.searchCustomers(req.query || {}),
}));

export const addFund = handle('Fund added to the customer wallet', (req) =>
    extras.addFundToCustomer(req.user?.userId, req.body || {}));

export const listWalletTransactions = handle('Wallet transactions fetched', (req) =>
    extras.listCustomerWalletTransactions(req.query || {}));

export const listWalletBonuses = handle('Wallet bonuses fetched', async (req) => ({
    bonuses: await extras.listWalletBonuses(req.query || {}),
}));

export const createWalletBonus = handle('Bonus added', async (req) => ({
    bonus: await extras.createWalletBonus(req.body || {}),
}));

export const updateWalletBonus = handle('Bonus saved', async (req) => ({
    bonus: await extras.updateWalletBonus(req.params.id, req.body || {}),
}));

export const deleteWalletBonus = handle('Bonus deleted', (req) => extras.deleteWalletBonus(req.params.id));

export const getLoyaltySettings = handle('Loyalty settings fetched', async () => ({
    settings: await extras.getLoyaltySettings(),
}));

export const saveLoyaltySettings = handle('Loyalty settings saved', async (req) => ({
    settings: await extras.saveLoyaltySettings(req.body || {}),
}));

export const listLoyaltyTransactions = handle('Loyalty point transactions fetched', (req) =>
    extras.listLoyaltyPointTransactions(req.query || {}));

export const listSubscribers = handle('Subscribers fetched', (req) => extras.listNewsletterSubscribers(req.query || {}));

export const exportSubscribers = async (req, res, next) => {
    try {
        const csv = await extras.exportNewsletterSubscribersCsv(req.query || {});
        const day = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="subscribed-mail-list-${day}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        return res.status(200).send(`﻿${csv}`);
    } catch (error) {
        return next(error);
    }
};

export const deleteSubscriber = handle('Subscriber removed', (req) => extras.deleteNewsletterSubscriber(req.params.id));

export const getUserOverview = handle('User overview fetched', () => extras.getUserOverview());
