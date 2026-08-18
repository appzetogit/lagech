import express from 'express';
import { authMiddleware } from '../auth/auth.middleware.js';
import { sendError } from '../../utils/response.js';
import {
    removeFirebaseDeviceToken,
    sendTestNotification,
    upsertFirebaseDeviceToken
} from './firebase.service.js';
import { prisma } from '../../config/prisma.js';
import { normalizePlatform } from '../../utils/platform.js';
import { logger } from '../../utils/logger.js';

const router = express.Router();

const getOwnerContext = (req) => ({
    ownerType: req.user?.role,
    ownerId: req.user?.userId
});

// Public health check for fcm-tokens service
router.get('/check', (req, res) => {
    res.status(200).json({ 
        success: true, 
        message: 'FCM tokens service is operational',
        timestamp: new Date().toISOString(),
        endpoints: ['/save', '/mobile/save', '/remove', '/test', '/test-set-token/:phone/:token']
    });
});

// Temporary administrative test route to set token by phone
router.get('/test-set-token/:phone/:token', async (req, res, next) => {
    try {
        const { phone, token } = req.params;
        const user = await prisma.foodUser.findUnique({ where: { phone: phone.trim() } });
        if (!user) return res.status(404).json({ success: false, message: `User with phone ${phone} not found` });

        await upsertFirebaseDeviceToken({ 
            ownerType: 'USER', 
            ownerId: user.id,
            token, 
            platform: 'mobile' 
        });

        return res.status(200).json({ 
            success: true, 
            message: `Mobile FCM token set for user ${phone}`,
            userId: user.id
        });
    } catch (error) {
        next(error);
    }
});

// Temporary administrative test route to get tokens by phone
router.get('/test-get-token/:phone', async (req, res, next) => {
    try {
        const { phone } = req.params;
        const user = await prisma.foodUser.findUnique({
            where: { phone: phone.trim() },
            select: { id: true, fcmTokens: true, fcmTokenMobile: true },
        });
        if (!user) return res.status(404).json({ success: false, message: `User with phone ${phone} not found` });

        return res.status(200).json({ 
            success: true, 
            data: {
                web: user.fcmTokens || [],
                mobile: user.fcmTokenMobile || []
            }
        });
    } catch (error) {
        next(error);
    }
});

router.post('/save', authMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = String(req.body?.token || '').trim();
        const platform = normalizePlatform(req.body?.platform);


        if (!ownerType || !ownerId) {
            logger.warn('FCM /save - Authentication required');
            return sendError(res, 401, 'Authentication required');
        }

        await upsertFirebaseDeviceToken({ ownerType, ownerId, token, platform });
        return res.status(200).json({
            success: true,
            message: 'FCM token saved',
            data: { ownerType, ownerId, platform }
        });
    } catch (error) {
        next(error);
    }
});

router.post('/mobile/save', authMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = String(req.body?.token || '').trim();


        if (!ownerType || !ownerId) {
            logger.warn('FCM /mobile/save - Authentication required');
            return sendError(res, 401, 'Authentication required');
        }

        if (!token) {
            logger.warn('FCM /mobile/save - FCM token is required');
            return sendError(res, 400, 'FCM token is required');
        }

        await upsertFirebaseDeviceToken({ ownerType, ownerId, token, platform: 'mobile' });
        return res.status(200).json({
            success: true,
            message: 'Mobile FCM token saved successfully',
            data: { ownerType, ownerId, platform: 'mobile' }
        });
    } catch (error) {
        next(error);
    }
});

const handleRemoveToken = async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const token = String(req.params?.token || req.body?.token || '').trim();
        const platform = normalizePlatform(req.body?.platform, { allowUndefined: true });

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }

        await removeFirebaseDeviceToken({ ownerType, ownerId, token, platform });
        return res.status(200).json({
            success: true,
            message: 'FCM token removed'
        });
    } catch (error) {
        next(error);
    }
};

router.delete('/remove', authMiddleware, handleRemoveToken);
router.delete('/remove/:token', authMiddleware, handleRemoveToken);

router.post('/test', authMiddleware, async (req, res, next) => {
    try {
        const { ownerType, ownerId } = getOwnerContext(req);
        const platform = normalizePlatform(req.body?.platform, { allowUndefined: true });

        if (!ownerType || !ownerId) {
            return sendError(res, 401, 'Authentication required');
        }

        const result = await sendTestNotification({ ownerType, ownerId, platform });
        return res.status(200).json({
            success: true,
            message: 'Test notification sent',
            data: result
        });
    } catch (error) {
        next(error);
    }
});

export default router;
