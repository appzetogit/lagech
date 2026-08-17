import { sendResponse } from '../../../../utils/response.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import * as settingsService from '../services/businessSettings.service.js';

export async function getBusinessSettings(req, res, next) {
    try {
        const settings = await settingsService.getBusinessSettings();
        return sendResponse(res, 200, 'Business settings fetched successfully', settings);
    } catch (error) {
        next(error);
    }
}

export async function getPowerScanningSettings(req, res, next) {
    try {
        const payload = await settingsService.getPowerScanningSettings();
        return sendResponse(res, 200, 'Power scanning settings fetched successfully', payload);
    } catch (error) {
        next(error);
    }
}

export async function updatePowerScanningSettings(req, res, next) {
    try {
        const payload = await settingsService.updatePowerScanningSettings(req.body || {});
        return sendResponse(res, 200, 'Power scanning settings updated successfully', payload);
    } catch (error) {
        next(error);
    }
}

export async function getOrderAcceptanceSettings(req, res, next) {
    try {
        const payload = await settingsService.getOrderAcceptanceSettings();
        return sendResponse(res, 200, 'Order acceptance settings fetched successfully', payload);
    } catch (error) {
        next(error);
    }
}

export async function updateOrderAcceptanceSettings(req, res, next) {
    try {
        const payload = await settingsService.updateOrderAcceptanceSettings(
            req.body?.orderAcceptanceTimeMinutes,
        );
        return sendResponse(res, 200, 'Order acceptance settings updated successfully', payload);
    } catch (error) {
        next(error);
    }
}

export async function updateBusinessSettings(req, res, next) {
    try {
        // The panel posts multipart, so the fields arrive as one JSON string
        // alongside the files.
        let data = {};
        try {
            data = req.body.data ? JSON.parse(req.body.data) : {};
        } catch {
            throw new ValidationError('Invalid settings payload');
        }

        const settings = await settingsService.updateBusinessSettings(data, req.files);
        return sendResponse(res, 200, 'Business settings updated successfully', settings);
    } catch (error) {
        next(error);
    }
}
