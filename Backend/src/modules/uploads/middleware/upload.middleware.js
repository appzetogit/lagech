import multer from 'multer';
import { config } from '../../../config/env.js';

const memoryStorage = multer.memoryStorage();

export const imageUpload = multer({
    storage: memoryStorage,
    limits: {
        fileSize: config.uploadMaxFileSizeBytes,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        const mimeType = String(file.mimetype || '').toLowerCase();
        if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif'].includes(mimeType)) {
            return cb(new Error('Only JPEG, PNG, WebP, and GIF images are allowed'));
        }
        return cb(null, true);
    }
});

/** Videos for reels and video ads: larger, and only a few types. */
export const videoUpload = multer({
    storage: memoryStorage,
    limits: {
        fileSize: Number(process.env.UPLOAD_MAX_VIDEO_SIZE_MB || 50) * 1024 * 1024,
        files: 1
    },
    fileFilter: (_req, file, cb) => {
        const mimeType = String(file.mimetype || '').toLowerCase();
        if (!['video/mp4', 'video/quicktime', 'video/webm'].includes(mimeType)) {
            return cb(new Error('Only MP4, MOV and WebM videos are allowed'));
        }
        return cb(null, true);
    }
});

export { uploadRateLimiter } from '../../../middleware/rateLimit.js';
