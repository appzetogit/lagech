import express from 'express';
import { uploadImage, uploadVideo } from '../controllers/upload.controller.js';
import { imageUpload, uploadRateLimiter, videoUpload } from '../middleware/upload.middleware.js';
import { authMiddleware } from '../../../core/auth/auth.middleware.js';
import { requireRoles } from '../../../core/roles/role.middleware.js';

const router = express.Router();

// POST /v1/uploads/image?folder=food/users/profile
// multipart field: file (required)
router.post(
    '/image',
    uploadRateLimiter,
    imageUpload.single('file'),
    uploadImage
);

// POST /v1/uploads/video?folder=food/reels -- signed-in admins and restaurants
// only: a video is large, and anyone being able to store them is a free host.
router.post(
    '/video',
    authMiddleware,
    requireRoles('ADMIN', 'RESTAURANT'),
    uploadRateLimiter,
    videoUpload.single('file'),
    uploadVideo
);

export default router;
