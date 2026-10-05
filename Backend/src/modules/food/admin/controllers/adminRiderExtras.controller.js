import { sendResponse } from '../../../../utils/response.js';
import * as svc from '../services/adminRiderExtras.service.js';

const adminIdOf = (req) => req.user?.userId || null;

// ── Add Delivery Man ──
export async function createRider(req, res, next) {
    try {
        const rider = await svc.createRiderByAdmin(req.body || {}, adminIdOf(req));
        return sendResponse(res, 201, 'Delivery man added', { rider });
    } catch (e) { return next(e); }
}

// ── Vehicle categories ──
export async function listVehicleCategories(req, res, next) {
    try {
        return sendResponse(res, 200, 'Vehicle categories fetched', await svc.listVehicleCategories(req.query));
    } catch (e) { return next(e); }
}

export async function createVehicleCategory(req, res, next) {
    try {
        return sendResponse(res, 201, 'Vehicle category added', await svc.createVehicleCategory(req.body || {}));
    } catch (e) { return next(e); }
}

export async function updateVehicleCategory(req, res, next) {
    try {
        return sendResponse(res, 200, 'Vehicle category updated', await svc.updateVehicleCategory(req.params.id, req.body || {}));
    } catch (e) { return next(e); }
}

export async function deleteVehicleCategory(req, res, next) {
    try {
        return sendResponse(res, 200, 'Vehicle category deleted', await svc.deleteVehicleCategory(req.params.id));
    } catch (e) { return next(e); }
}

// ── Delivery Man Disbursement ──
export async function listDisbursements(req, res, next) {
    try {
        return sendResponse(res, 200, 'Disbursements fetched', await svc.listRiderDisbursements(req.query));
    } catch (e) { return next(e); }
}

export async function generateDisbursement(req, res, next) {
    try {
        const data = await svc.generateRiderDisbursement(req.body || {}, adminIdOf(req));
        const message = data.created ? `${data.batch.title} created` : data.reason;
        return sendResponse(res, data.created ? 201 : 200, message, data);
    } catch (e) { return next(e); }
}

export async function getDisbursement(req, res, next) {
    try {
        return sendResponse(res, 200, 'Disbursement fetched', await svc.getRiderDisbursement(req.params.batchId, req.query));
    } catch (e) { return next(e); }
}

export async function decideDisbursementPayouts(req, res, next) {
    try {
        const data = await svc.decideRiderPayouts(req.params.batchId, req.body || {}, adminIdOf(req));
        return sendResponse(res, 200, 'Payouts updated', data);
    } catch (e) { return next(e); }
}

// ── Delivery Man Payments ──
export async function listPayments(req, res, next) {
    try {
        return sendResponse(res, 200, 'Payments fetched', await svc.listRiderPayments(req.query));
    } catch (e) { return next(e); }
}

export async function listPayableRiders(req, res, next) {
    try {
        return sendResponse(res, 200, 'Delivery men fetched', await svc.listPayableRiders(req.query));
    } catch (e) { return next(e); }
}

export async function recordPayment(req, res, next) {
    try {
        const data = await svc.recordRiderPayment(req.body || {}, adminIdOf(req));
        return sendResponse(res, 201, 'Payment recorded', data);
    } catch (e) { return next(e); }
}

// ── Deliveryman Earning Report ──
export async function getEarningReport(req, res, next) {
    try {
        return sendResponse(res, 200, 'Deliveryman earning report fetched', await svc.getDeliverymanEarningReport(req.query));
    } catch (e) { return next(e); }
}
