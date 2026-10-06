import express from 'express';
import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { sendResponse, sendError } from '../../../../utils/response.js';
import * as service from '../services/adminThirdParty.service.js';

/**
 * 3rd Party settings (SMS, mail, maps, reCAPTCHA, social logins, storage,
 * payment), mounted at /system-settings/third-party from
 * adminSystemExtras.routes.js. That prefix is already checked against the
 * system_settings permission by admin.routes.js; on top of that only a super
 * admin may read or change these, since they hold the platform's credentials.
 */
const router = express.Router();

export async function requireSuperAdmin(req, res, next) {
    try {
        if (!req.user?.userId || req.user?.role !== 'ADMIN' || !isId(req.user.userId)) {
            return sendError(res, 401, 'Not authenticated');
        }
        const admin = req.adminAccess || await prisma.foodAdmin.findUnique({
            where: { id: String(req.user.userId) },
            select: { adminType: true, isActive: true, isDeleted: true },
        });
        if (!admin || admin.isDeleted || admin.isActive === false) return sendError(res, 403, 'Admin account is inactive');
        if (admin.adminType && admin.adminType !== 'super_admin') {
            return sendError(res, 403, 'Only a super admin can manage 3rd party settings');
        }
        return next();
    } catch {
        return sendError(res, 500, 'Permission check failed');
    }
}

const handle = (message, run) => async (req, res, next) => {
    try {
        // Masked or not, these responses describe credentials: keep them out of caches.
        res.setHeader('Cache-Control', 'no-store');
        return sendResponse(res, 200, message, await run(req));
    } catch (error) {
        return next(error);
    }
};

const adminId = (req) => req.user?.userId || null;

router.use(requireSuperAdmin);

router.get('/', handle('3rd party settings', () => service.getAllThirdPartyAreas()));
router.get('/audit', handle('3rd party settings history', (req) => service.listThirdPartyAudit(req.query || {})));
router.post('/import', handle('Server settings imported', (req) =>
    service.importAllThirdPartyAreas({ overwrite: req.body?.overwrite === true }, adminId(req))));
router.post('/sms/test', handle('Test SMS', (req) => service.sendThirdPartyTestSms(req.body || {}, adminId(req))));
router.post('/mail/test', handle('Test email', (req) => service.sendThirdPartyTestEmail(req.body || {}, adminId(req))));
router.get('/:area', handle('3rd party settings', (req) => service.getThirdPartyArea(req.params.area)));
router.put('/:area', handle('3rd party settings saved', (req) =>
    service.saveThirdPartyArea(req.params.area, { values: req.body?.values, clear: req.body?.clear }, adminId(req))));
router.post('/:area/import', handle('Server settings imported', (req) =>
    service.importThirdPartyArea(req.params.area, { overwrite: req.body?.overwrite === true }, adminId(req))));

export default router;
