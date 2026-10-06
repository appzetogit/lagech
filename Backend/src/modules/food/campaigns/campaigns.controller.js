import * as campaigns from './campaigns.service.js';

/** One JSON handler shape for every campaign endpoint. */
const handle = (fn, { status = 200, message = 'OK' } = {}) => async (req, res, next) => {
    try {
        res.status(status).json({ success: true, message, data: await fn(req) });
    } catch (error) {
        next(error);
    }
};

// Admin: basic campaigns
export const listBasic = handle((req) => campaigns.listBasicCampaigns(req.query || {}));
export const createBasic = handle(async (req) => ({ campaign: await campaigns.createBasicCampaign(req.body || {}) }), { status: 201, message: 'Campaign created' });
export const updateBasic = handle(async (req) => ({ campaign: await campaigns.updateBasicCampaign(req.params.id, req.body || {}) }), { message: 'Campaign saved' });
export const deleteBasic = handle((req) => campaigns.deleteBasicCampaign(req.params.id), { message: 'Campaign deleted' });
export const listBasicRestaurants = handle((req) => campaigns.listCampaignRestaurants(req.params.id));
export const joinBasic = handle((req) => campaigns.setCampaignRestaurant(req.params.id, req.params.restaurantId, true), { message: 'Restaurant added' });
export const leaveBasic = handle((req) => campaigns.setCampaignRestaurant(req.params.id, req.params.restaurantId, false), { message: 'Restaurant removed' });

// Admin: food campaigns
export const listFood = handle((req) => campaigns.listFoodCampaigns(req.query || {}));
export const createFood = handle(async (req) => ({ campaign: await campaigns.createFoodCampaign(req.body || {}) }), { status: 201, message: 'Campaign created' });
export const updateFood = handle(async (req) => ({ campaign: await campaigns.updateFoodCampaign(req.params.id, req.body || {}) }), { message: 'Campaign saved' });
export const deleteFood = handle((req) => campaigns.deleteFoodCampaign(req.params.id), { message: 'Campaign deleted' });

// Public (customer apps)
export const listRunning = handle(() => campaigns.listRunningCampaigns());
