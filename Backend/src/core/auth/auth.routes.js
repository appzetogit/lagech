import express from 'express';
import {
    requestUserOtpController,
    verifyUserOtpController,
    adminLoginController,
    refreshTokenController,
    requestRestaurantOtpController,
    verifyRestaurantOtpController,
    requestDeliveryOtpController,
    verifyDeliveryOtpController,
    logoutController,
    getMeController,
    updateAdminProfileController,
    changeAdminPasswordController,
    requestAdminForgotPasswordOtpController,
    resetAdminPasswordWithOtpController
} from './auth.controller.js';
import { authMiddleware, requireAdmin } from './auth.middleware.js';
import {
    authRateLimiter,
    authVerifyRateLimiter,
    authIpCeilingRateLimiter,
} from '../../middleware/rateLimit.js';

const router = express.Router();

// router.use(authRateLimiter); // Removed global application to avoid rate-limiting /me or /refresh-token too strictly

// Order matters: the coarse per-IP ceiling runs BEFORE the per-IP+phone limiter,
// so phone-cycling enumeration is stopped by the ceiling rather than minting a
// fresh per-phone bucket on every attempt.
// request-otp: successes count (each one sends a billable SMS).
const requestOtpLimiters = [authIpCeilingRateLimiter, authRateLimiter];
// verify / login: only FAILED attempts count, so a legitimate login is free.
const verifyLimiters = [authIpCeilingRateLimiter, authVerifyRateLimiter];

// User OTP login
router.post('/user/request-otp', ...requestOtpLimiters, requestUserOtpController);
router.post('/user/verify-otp', ...verifyLimiters, verifyUserOtpController);

// Restaurant OTP login
router.post('/restaurant/request-otp', ...requestOtpLimiters, requestRestaurantOtpController);
router.post('/restaurant/verify-otp', ...verifyLimiters, verifyRestaurantOtpController);

// Delivery partner OTP login
router.post('/delivery/request-otp', ...requestOtpLimiters, requestDeliveryOtpController);
router.post('/delivery/verify-otp', ...verifyLimiters, verifyDeliveryOtpController);

// Admin login
router.post('/admin/login', ...verifyLimiters, adminLoginController);

// Admin forgot password (no auth required)
router.post('/admin/forgot-password/request-otp', ...requestOtpLimiters, requestAdminForgotPasswordOtpController);
router.post('/admin/forgot-password/reset', ...verifyLimiters, resetAdminPasswordWithOtpController);

// Refresh token
router.post('/refresh-token', refreshTokenController);

// Logout (invalidates refresh token)
router.post('/logout', logoutController);

// Authenticated user profile (requires Bearer token)
router.get('/me', authMiddleware, getMeController);

// Admin-only: profile update & change password (Bearer + ADMIN role)
router.patch('/admin/profile', authMiddleware, requireAdmin, updateAdminProfileController);
router.post('/admin/change-password', authMiddleware, requireAdmin, changeAdminPasswordController);

export default router;

