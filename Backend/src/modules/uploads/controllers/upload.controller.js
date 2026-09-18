import { saveImageFile, saveVideoFile, sanitizeUploadFolder } from '../../../services/storage.service.js';
import { sendResponse } from '../../../utils/response.js';
import { ValidationError } from '../../../core/auth/errors.js';

const resolveFolder = (req) => {
    const fromQuery = req.query?.folder;
    const fromBody = req.body?.folder;
    const folder = typeof fromQuery === 'string' && fromQuery.trim()
        ? fromQuery
        : typeof fromBody === 'string'
            ? fromBody
            : '';

    return sanitizeUploadFolder(folder);
};

export const uploadImage = async (req, res, next) => {
    try {
        const folder = resolveFolder(req);

        if (!req.file) {
            throw new ValidationError('File is required');
        }

        const saved = await saveImageFile(req.file, folder);

        return sendResponse(res, 200, 'Image uploaded successfully', {
            url: saved.url,
            path: saved.path,
            filename: saved.filename,
            mimeType: saved.mimeType,
            size: saved.size
        });
    } catch (error) {
        return next(error);
    }
};

export const uploadVideo = async (req, res, next) => {
    try {
        if (!req.file) throw new ValidationError('File is required');
        const saved = await saveVideoFile(req.file, resolveFolder(req));
        return sendResponse(res, 200, 'Video uploaded successfully', saved);
    } catch (error) {
        return next(error);
    }
};
