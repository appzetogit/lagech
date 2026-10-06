import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../core/auth/errors.js';
import { campaignPrice, campaignState } from './campaignSchedule.js';
import { validateBasicCampaign, validateFoodCampaign } from './campaign.validator.js';

/**
 * Campaigns, as the old panel had them:
 *
 *   basic -- a promotion ("Weekend Feast") with a banner and a schedule that
 *            restaurants take part in. For now the admin adds and removes the
 *            restaurants; restaurants cannot join from their panel yet.
 *   food  -- one special dish from one restaurant, with its own price and
 *            discount, on offer for a while.
 *
 * Either is shown to customers while switched on and between its start and
 * end (campaignState). The customer app lists them; a food campaign dish is
 * ordered at its campaign price through the normal checkout (campaignCart.js).
 */

const STATES = ['off', 'scheduled', 'running', 'expired'];

const RESTAURANT_CARD = {
    select: {
        id: true, restaurantName: true, profileImage: true, coverImage: true,
        area: true, city: true, rating: true, totalRatings: true, status: true, isAcceptingOrders: true,
    },
};

const restaurantCard = (r) => ({
    id: r.id,
    name: r.restaurantName,
    logo: r.profileImage || '',
    coverImage: r.coverImage || '',
    area: r.area || r.city || '',
    rating: Number(r.rating) || 0,
    totalRatings: r.totalRatings || 0,
    isAcceptingOrders: r.isAcceptingOrders !== false,
});

const filterByState = (rows, state) => {
    const counts = rows.reduce((acc, row) => ({ ...acc, [row.state]: (acc[row.state] || 0) + 1 }), {});
    return { rows: STATES.includes(state) ? rows.filter((row) => row.state === state) : rows, counts };
};

const notFound = (label) => (error) => {
    if (error?.code === 'P2025') throw new NotFoundError(`${label} not found`);
    throw error;
};

// ─── basic campaigns ─────────────────────────────────────────────────────────

const serializeBasic = (c) => ({
    id: c.id,
    title: c.title,
    description: c.description,
    image: c.image,
    startsAt: c.startsAt,
    endsAt: c.endsAt,
    isActive: c.isActive,
    state: campaignState(c),
    restaurantCount: c._count?.restaurants ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
});

const WITH_COUNT = { _count: { select: { restaurants: true } } };

export async function listBasicCampaigns(query = {}) {
    const search = String(query.search || '').trim().slice(0, 80);
    const rows = await prisma.foodCampaign.findMany({
        where: search ? { title: { contains: search, mode: 'insensitive' } } : {},
        orderBy: [{ startsAt: 'desc' }],
        include: WITH_COUNT,
    });
    const { rows: campaigns, counts } = filterByState(rows.map(serializeBasic), String(query.state || ''));
    return { campaigns, counts };
}

export async function createBasicCampaign(body) {
    const data = validateBasicCampaign(body);
    return serializeBasic(await prisma.foodCampaign.create({ data, include: WITH_COUNT }));
}

export async function updateBasicCampaign(id, body) {
    if (!isId(id)) throw new ValidationError('Invalid campaign');
    const existing = await prisma.foodCampaign.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Campaign not found');
    const data = validateBasicCampaign(body, existing);
    return serializeBasic(await prisma.foodCampaign.update({ where: { id: existing.id }, data, include: WITH_COUNT }));
}

export async function deleteBasicCampaign(id) {
    if (!isId(id)) throw new ValidationError('Invalid campaign');
    const { count } = await prisma.foodCampaign.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Campaign not found');
    return { deleted: true };
}

export async function listCampaignRestaurants(campaignId) {
    if (!isId(campaignId)) throw new ValidationError('Invalid campaign');
    const campaign = await prisma.foodCampaign.findUnique({ where: { id: String(campaignId) }, select: { id: true } });
    if (!campaign) throw new NotFoundError('Campaign not found');
    const rows = await prisma.foodCampaignRestaurant.findMany({
        where: { campaignId: campaign.id },
        orderBy: { joinedAt: 'asc' },
        include: { restaurant: RESTAURANT_CARD },
    });
    return {
        restaurants: rows.map((row) => ({ ...restaurantCard(row.restaurant), status: row.restaurant.status, joinedAt: row.joinedAt })),
    };
}

/** Add a restaurant to a basic campaign (joined = true) or take it out. */
export async function setCampaignRestaurant(campaignId, restaurantId, joined) {
    if (!isId(campaignId)) throw new ValidationError('Invalid campaign');
    if (!isId(restaurantId)) throw new ValidationError('Invalid restaurant');
    if (!joined) {
        await prisma.foodCampaignRestaurant.deleteMany({ where: { campaignId: String(campaignId), restaurantId: String(restaurantId) } });
        return { joined: false };
    }
    const [campaign, restaurant] = await Promise.all([
        prisma.foodCampaign.findUnique({ where: { id: String(campaignId) }, select: { id: true } }),
        prisma.foodRestaurant.findUnique({ where: { id: String(restaurantId) }, select: { id: true, status: true } }),
    ]);
    if (!campaign) throw new NotFoundError('Campaign not found');
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    if (restaurant.status !== 'approved') throw new ValidationError('Only approved restaurants can take part');
    await prisma.foodCampaignRestaurant.upsert({
        where: { campaignId_restaurantId: { campaignId: campaign.id, restaurantId: restaurant.id } },
        create: { campaignId: campaign.id, restaurantId: restaurant.id },
        update: {},
    });
    return { joined: true };
}

// ─── food campaigns ──────────────────────────────────────────────────────────

const serializeFood = (c) => {
    const price = Number(c.price);
    const discount = Number(c.discount);
    return {
        id: c.id,
        restaurantId: c.restaurantId,
        restaurantName: c.restaurant?.restaurantName || '',
        title: c.title,
        description: c.description,
        image: c.image,
        price,
        discountType: c.discountType,
        discount,
        finalPrice: campaignPrice(price, c.discountType, discount),
        foodType: c.foodType === 'NonVeg' ? 'Non-Veg' : 'Veg',
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        isActive: c.isActive,
        state: campaignState(c),
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
    };
};

const WITH_RESTAURANT_NAME = { restaurant: { select: { restaurantName: true } } };

/** Validated body -> Prisma columns (foodType's stored spelling differs). */
const foodColumns = (data) => {
    const out = { ...data };
    if (data.foodType !== undefined) out.foodType = data.foodType === 'Non-Veg' ? 'NonVeg' : 'Veg';
    return out;
};

const assertRestaurant = async (restaurantId) => {
    const restaurant = await prisma.foodRestaurant.findUnique({ where: { id: restaurantId }, select: { status: true } });
    if (!restaurant) throw new NotFoundError('Restaurant not found');
    if (restaurant.status !== 'approved') throw new ValidationError('Choose an approved restaurant');
};

export async function listFoodCampaigns(query = {}) {
    const where = {};
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    const search = String(query.search || '').trim().slice(0, 80);
    if (search) where.title = { contains: search, mode: 'insensitive' };
    const rows = await prisma.foodItemCampaign.findMany({
        where,
        orderBy: [{ startsAt: 'desc' }],
        include: WITH_RESTAURANT_NAME,
    });
    const { rows: campaigns, counts } = filterByState(rows.map(serializeFood), String(query.state || ''));
    return { campaigns, counts };
}

export async function createFoodCampaign(body) {
    const data = validateFoodCampaign(body);
    await assertRestaurant(data.restaurantId);
    const row = await prisma.foodItemCampaign.create({ data: foodColumns(data), include: WITH_RESTAURANT_NAME });
    return serializeFood(row);
}

export async function updateFoodCampaign(id, body) {
    if (!isId(id)) throw new ValidationError('Invalid campaign');
    const existing = await prisma.foodItemCampaign.findUnique({ where: { id: String(id) } });
    if (!existing) throw new NotFoundError('Campaign not found');
    const data = validateFoodCampaign(body, existing);
    if (data.restaurantId && data.restaurantId !== existing.restaurantId) await assertRestaurant(data.restaurantId);
    const row = await prisma.foodItemCampaign
        .update({ where: { id: existing.id }, data: foodColumns(data), include: WITH_RESTAURANT_NAME })
        .catch(notFound('Campaign'));
    return serializeFood(row);
}

export async function deleteFoodCampaign(id) {
    if (!isId(id)) throw new ValidationError('Invalid campaign');
    const { count } = await prisma.foodItemCampaign.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Campaign not found');
    return { deleted: true };
}

// ─── public ──────────────────────────────────────────────────────────────────

/** Running campaigns for the customer app: basic ones with their restaurants, and food ones. */
export async function listRunningCampaigns() {
    const now = new Date();
    const running = { isActive: true, startsAt: { lte: now }, endsAt: { gte: now } };
    const [basic, food] = await Promise.all([
        prisma.foodCampaign.findMany({
            where: running,
            orderBy: [{ startsAt: 'desc' }],
            take: 50,
            include: {
                restaurants: {
                    where: { restaurant: { status: 'approved' } },
                    orderBy: { joinedAt: 'asc' },
                    include: { restaurant: RESTAURANT_CARD },
                },
            },
        }),
        prisma.foodItemCampaign.findMany({
            where: { ...running, restaurant: { status: 'approved' } },
            orderBy: [{ startsAt: 'desc' }],
            take: 100,
            include: { restaurant: RESTAURANT_CARD },
        }),
    ]);

    return {
        basic: basic.map((c) => ({
            id: c.id,
            title: c.title,
            description: c.description,
            image: c.image,
            startsAt: c.startsAt,
            endsAt: c.endsAt,
            restaurants: c.restaurants.map((entry) => restaurantCard(entry.restaurant)),
        })),
        food: food.map((c) => {
            const item = serializeFood(c);
            return {
                id: item.id,
                title: item.title,
                description: item.description,
                image: item.image,
                price: item.price,
                discountType: item.discountType,
                discount: item.discount,
                finalPrice: item.finalPrice,
                foodType: item.foodType,
                startsAt: item.startsAt,
                endsAt: item.endsAt,
                restaurant: restaurantCard(c.restaurant),
            };
        }),
    };
}
