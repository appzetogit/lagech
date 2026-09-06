import {
    clearLandingZoneSettings,
    getLandingSettings,
    getLandingZoneSettings,
    updateLandingSettings,
    updateLandingZoneSettings,
} from '../services/landingSettings.service.js';
import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';

export const getAdminLandingSettingsController = async (req, res, next) => {
    try {
        const settings = await getLandingSettings();
        return sendResponse(res, 200, 'Landing settings fetched successfully', settings);
    } catch (error) {
        next(error);
    }
};

export const updateAdminLandingSettingsController = async (req, res, next) => {
    try {
        const payload = req.body || {};
        if (typeof payload !== 'object') {
            throw new ValidationError('Invalid settings payload');
        }
        const updated = await updateLandingSettings(payload);
        return sendResponse(res, 200, 'Landing settings updated successfully', updated);
    } catch (error) {
        next(error);
    }
};

/**
 * One zone's own rail settings, plus the global ones for comparison.
 *
 * Both are returned so the screen can show what a zone would inherit if it
 * had no overrides -- otherwise "inherits the default" is a claim the admin
 * cannot check.
 */
export const getAdminLandingZoneSettingsController = async (req, res, next) => {
    try {
        const [zone, global] = await Promise.all([
            getLandingZoneSettings(req.params.zoneId),
            getLandingSettings(),
        ]);

        return sendResponse(res, 200, 'Zone landing settings fetched', {
            zoneId: req.params.zoneId,
            overrides: zone,
            inheritsWhenUnset: {
                recommendedRestaurantIds: global.recommendedRestaurantIds,
                recommendedOrderMode: global.recommendedOrderMode,
            },
        });
    } catch (error) {
        next(error);
    }
};

export const updateAdminLandingZoneSettingsController = async (req, res, next) => {
    try {
        const payload = req.body || {};
        if (typeof payload !== 'object') {
            throw new ValidationError('Invalid settings payload');
        }
        const updated = await updateLandingZoneSettings(req.params.zoneId, payload);
        return sendResponse(res, 200, 'Zone landing settings updated', updated);
    } catch (error) {
        next(error);
    }
};

export const clearAdminLandingZoneSettingsController = async (req, res, next) => {
    try {
        const result = await clearLandingZoneSettings(req.params.zoneId);
        return sendResponse(res, 200, 'Zone now inherits the default settings', result);
    } catch (error) {
        next(error);
    }
};
