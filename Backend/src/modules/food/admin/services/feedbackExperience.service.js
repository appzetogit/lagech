import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * The "how was your experience" survey, answered from all three apps.
 *
 * `userId` is polymorphic — `userModel` names the table it points at — so there
 * is no foreign key and the author has to be looked up per table.
 */

const MODULES = ['user', 'restaurant', 'delivery'];

const MODEL_BY_ROLE = {
    RESTAURANT: 'FoodRestaurant',
    DELIVERY_PARTNER: 'FoodDeliveryPartner',
};

/**
 * The survey stores 1–5; every screen shows it out of 10.
 * `very_bad` and `bad` both land on 1, `above_average` and `good` both on 4 —
 * the form has more labels than the scale has points.
 */
const RATING_BY_EXPERIENCE = {
    very_bad: 1,
    bad: 1,
    below_average: 2,
    average: 3,
    above_average: 4,
    good: 4,
    very_good: 5,
};

export async function createFeedbackExperience({ userId, role }, body = {}) {
    const rating = Number(body.rating);
    const module = String(body.module || '').trim();

    if (!rating || !module) throw new ValidationError('Rating and module are required');
    if (!MODULES.includes(module)) throw new ValidationError('Invalid module');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
        throw new ValidationError('Rating must be a whole number from 1 to 5');
    }

    const userModel = MODEL_BY_ROLE[role] || 'FoodUser';

    return prisma.feedbackExperience.create({
        data: {
            userId,
            userModel,
            module,
            rating,
            comment: String(body.comment || ''),
            // Only a restaurant's own feedback is attributable to a restaurant.
            restaurantId: userModel === 'FoodRestaurant' ? userId : null,
        },
    });
}

/** Resolve the authors across the three tables in three queries, not N. */
const loadAuthors = async (rows) => {
    const idsByModel = { FoodUser: [], FoodRestaurant: [], FoodDeliveryPartner: [] };
    for (const row of rows) idsByModel[row.userModel]?.push(row.userId);

    const [users, restaurants, partners] = await Promise.all([
        idsByModel.FoodUser.length
            ? prisma.foodUser.findMany({
                where: { id: { in: idsByModel.FoodUser } },
                select: { id: true, name: true, phone: true, email: true },
            })
            : [],
        idsByModel.FoodRestaurant.length
            ? prisma.foodRestaurant.findMany({
                where: { id: { in: idsByModel.FoodRestaurant } },
                select: { id: true, restaurantName: true, ownerPhone: true, ownerEmail: true },
            })
            : [],
        idsByModel.FoodDeliveryPartner.length
            ? prisma.foodDeliveryPartner.findMany({
                where: { id: { in: idsByModel.FoodDeliveryPartner } },
                select: { id: true, name: true, phone: true, email: true },
            })
            : [],
    ]);

    const byId = new Map();
    for (const u of users) byId.set(u.id, { name: u.name, phone: u.phone, email: u.email });
    for (const p of partners) byId.set(p.id, { name: p.name, phone: p.phone, email: p.email });
    for (const r of restaurants) {
        byId.set(r.id, { name: r.restaurantName, phone: r.ownerPhone, email: r.ownerEmail });
    }
    return byId;
};

export async function getFeedbackExperiences(query = {}) {
    const limit = Math.min(Math.max(parseInt(query.limit, 10) || 10, 1), 100);
    const page = Math.max(parseInt(query.page, 10) || 1, 1);
    const skip = (page - 1) * limit;

    const where = {};
    if (MODULES.includes(String(query.module || '').trim())) where.module = String(query.module).trim();

    if (query.startDate || query.endDate) {
        where.createdAt = {};
        if (query.startDate) where.createdAt.gte = new Date(query.startDate);
        if (query.endDate) {
            const end = new Date(query.endDate);
            end.setHours(23, 59, 59, 999);
            where.createdAt.lte = end;
        }
    }

    // The filter panel sends the doubled value it displays.
    if (query.rating) where.rating = Math.ceil(parseInt(query.rating, 10) / 2) || 1;
    if (RATING_BY_EXPERIENCE[query.experience]) where.rating = RATING_BY_EXPERIENCE[query.experience];

    const [rows, total, stats] = await Promise.all([
        prisma.feedbackExperience.findMany({
            where,
            orderBy: { createdAt: 'desc' },
            skip,
            take: limit,
            include: { restaurant: { select: { id: true, restaurantName: true } } },
        }),
        prisma.feedbackExperience.count({ where }),
        // Aggregated in the database. The old code fetched every matching row
        // and reduced it in Node just to get an average.
        prisma.feedbackExperience.aggregate({
            where,
            _avg: { rating: true },
            _min: { rating: true },
            _max: { rating: true },
        }),
    ]);

    const authors = await loadAuthors(rows);

    const feedbacks = rows.map((row) => {
        const author = authors.get(row.userId) || {};
        return {
            ...row,
            _id: row.id,
            userName: author.name || 'N/A',
            userPhone: author.phone || 'N/A',
            userEmail: author.email || 'N/A',
        };
    });

    // Everything the panel shows is out of 10.
    const outOfTen = (value) => (value == null ? 0 : value * 2);

    return {
        feedbacks,
        pagination: { total, page, limit, pages: Math.ceil(total / limit) || 1 },
        statistics: {
            totalFeedback: total,
            averageRating: outOfTen(stats._avg.rating),
            minRating: outOfTen(stats._min.rating),
            maxRating: outOfTen(stats._max.rating),
        },
    };
}

export async function deleteFeedbackExperience(id) {
    if (!isId(id)) return false;
    const { count } = await prisma.feedbackExperience.deleteMany({ where: { id: String(id) } });
    return count > 0;
}
