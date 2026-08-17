import { sendResponse } from '../../../../utils/response.js';
import {
    getActiveCashbackSettings,
    upsertCashbackSettings,
} from '../../user/services/cashback.service.js';

export async function getCashbackSettingsController(_req, res, next) {
    try {
        const cashbackSettings = await getActiveCashbackSettings();
        return sendResponse(res, 200, 'Cashback settings fetched', { cashbackSettings });
    } catch (e) { next(e); }
}

export async function upsertCashbackSettingsController(req, res, next) {
    try {
        const cashbackSettings = await upsertCashbackSettings(req.body || {});
        return sendResponse(res, 200, 'Cashback settings saved', { cashbackSettings });
    } catch (e) { next(e); }
}
