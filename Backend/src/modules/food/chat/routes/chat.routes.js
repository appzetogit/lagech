import express from 'express';
import {
    sendMessageController,
    listConversationsController,
    createConversationController,
    updateConversationStatusController,
    getHistoryController,
    markReadController,
    uploadAttachmentController
} from '../controllers/chat.controller.js';
import { upload } from '../../../../middleware/upload.js';

const router = express.Router();

// Auth + role gating applied where mounted (routes/index.js).
// One image at a time. The message that follows carries the paths.
router.post('/attachments', upload.single('file'), uploadAttachmentController);
router.post('/messages', sendMessageController);
router.get('/messages', getHistoryController);
// ?orderId=<id> filters to one order's threads, newest first.
router.get('/conversations', listConversationsController);
router.post('/conversations', createConversationController);
router.patch('/conversations/:conversationId/status', updateConversationStatusController);
router.patch('/conversations/:conversationId/read', markReadController);

export default router;
