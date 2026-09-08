import { sendResponse } from '../../../../utils/response.js';
import * as chatService from '../services/chat.service.js';
import { saveImageFile } from '../../../../services/storage.service.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const me = (req) => ({ role: req.user?.role, id: req.user?.userId });

/**
 * Store one image and hand back where it went.
 *
 * Uploading and sending are separate on purpose: the picture is on the server
 * before the message exists, so a slow upload does not hold the composer, and a
 * failed one loses nothing but itself. The message then carries the path.
 *
 * saveImageFile does the checking -- it refuses anything that is not a JPEG,
 * PNG, WebP or GIF, and re-encodes what it accepts, so a file that merely calls
 * itself an image does not survive the round trip.
 */
export async function uploadAttachmentController(req, res, next) {
    try {
        if (!req.file) throw new ValidationError('No file was uploaded');
        const saved = await saveImageFile(req.file, 'chat');
        return sendResponse(res, 201, 'Attachment uploaded', {
            attachment: {
                url: saved.url,
                path: saved.path,
                mimeType: saved.mimeType,
                size: saved.size,
                name: String(req.file.originalname || '').slice(0, 120),
            },
        });
    } catch (err) {
        next(err);
    }
}

export async function sendMessageController(req, res, next) {
    try {
        const message = await chatService.sendMessage(me(req), req.body || {});
        return sendResponse(res, 201, 'Message sent', { message });
    } catch (err) {
        next(err);
    }
}

export async function listConversationsController(req, res, next) {
    try {
        // ?orderId=<id> narrows to that order's threads. Omit it for everything.
        const data = await chatService.listConversations(me(req), {
            orderId: req.query.orderId
        });
        return sendResponse(res, 200, 'Conversations fetched', data);
    } catch (err) {
        next(err);
    }
}

export async function createConversationController(req, res, next) {
    try {
        const data = await chatService.createConversation(me(req), req.body || {});
        return sendResponse(res, 201, 'Conversation created', data);
    } catch (err) {
        next(err);
    }
}

export async function updateConversationStatusController(req, res, next) {
    try {
        const data = await chatService.updateConversationStatus(
            me(req),
            req.params.conversationId,
            req.body?.status
        );
        return sendResponse(res, 200, 'Conversation updated', data);
    } catch (err) {
        next(err);
    }
}

export async function assignConversationController(req, res, next) {
    try {
        // Only to the caller or to nobody -- see assignConversation.
        const toSelf = req.body?.assign !== false;
        const data = await chatService.assignConversation(
            me(req),
            req.params.conversationId,
            toSelf,
        );
        return sendResponse(res, 200, toSelf ? 'Conversation assigned' : 'Conversation released', data);
    } catch (err) {
        next(err);
    }
}

export async function unreadCountController(req, res, next) {
    try {
        const data = await chatService.unreadCount(me(req));
        return sendResponse(res, 200, 'Unread count fetched', data);
    } catch (err) {
        next(err);
    }
}

export async function getHistoryController(req, res, next) {
    try {
        const data = await chatService.getHistory(me(req), {
            conversationId: req.query.conversationId,
            page: req.query.page,
            limit: req.query.limit
        });
        return sendResponse(res, 200, 'Messages fetched', data);
    } catch (err) {
        next(err);
    }
}

export async function markReadController(req, res, next) {
    try {
        const data = await chatService.markRead(me(req), req.params.conversationId);
        return sendResponse(res, 200, 'Marked as read', data);
    } catch (err) {
        next(err);
    }
}
