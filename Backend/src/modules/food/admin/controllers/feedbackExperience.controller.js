import { sendResponse, sendError } from '../../../../utils/response.js';
import { isId } from '../../../../utils/helpers.js';
import * as feedbackService from '../services/feedbackExperience.service.js';

/**
 * Create a new feedback experience entry.
 * POST /api/v1/food/restaurant/feedback-experience
 */
export const createFeedbackExperience = async (req, res, next) => {
    try {
        const userId = req.user?.userId;
        if (!isId(userId)) return sendError(res, 401, 'User ID not found in token');

        const feedback = await feedbackService.createFeedbackExperience(
            { userId, role: req.user?.role },
            req.body || {},
        );
        return sendResponse(res, 201, 'Feedback submitted successfully', feedback);
    } catch (error) {
        next(error);
    }
};

/**
 * Get all feedback experiences (Admin only).
 * GET /api/v1/food/admin/feedback-experiences
 */
export const getFeedbackExperiences = async (req, res, next) => {
    try {
        const data = await feedbackService.getFeedbackExperiences(req.query || {});
        return sendResponse(res, 200, 'Feedbacks fetched successfully', data);
    } catch (error) {
        next(error);
    }
};

/**
 * Delete a feedback experience (Admin only).
 * DELETE /api/v1/food/admin/feedback-experiences/:id
 */
export const deleteFeedbackExperience = async (req, res, next) => {
    try {
        const deleted = await feedbackService.deleteFeedbackExperience(req.params.id);
        if (!deleted) return sendError(res, 404, 'Feedback not found');
        return sendResponse(res, 200, 'Feedback deleted successfully');
    } catch (error) {
        next(error);
    }
};
