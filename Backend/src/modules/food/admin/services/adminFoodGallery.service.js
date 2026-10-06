import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * Food gallery (the old panel's Food Setup -> Food Gallery): every dish that
 * has a photo, across restaurants, to look through and jump to its edit form.
 * Read-only.
 */

const MAX_LIMIT = 120;

export async function listFoodGallery(query = {}) {
    const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number.parseInt(query.limit, 10) || 48));

    const where = { image: { not: '' } };
    if (isId(query.restaurantId)) where.restaurantId = String(query.restaurantId);
    if (isId(query.categoryId)) where.categoryId = String(query.categoryId);
    if (['pending', 'approved', 'rejected'].includes(String(query.approvalStatus || ''))) {
        where.approvalStatus = String(query.approvalStatus);
    }
    const search = String(query.search || '').trim().slice(0, 80);
    if (search) where.name = { contains: search, mode: 'insensitive' };

    const [rows, total] = await Promise.all([
        prisma.foodItem.findMany({
            where,
            orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
            select: {
                id: true,
                name: true,
                image: true,
                images: true,
                price: true,
                foodType: true,
                categoryId: true,
                categoryName: true,
                approvalStatus: true,
                isAvailable: true,
                restaurantId: true,
                restaurant: { select: { restaurantName: true } },
            },
        }),
        prisma.foodItem.count({ where }),
    ]);

    return {
        foods: rows.map((f) => ({
            id: f.id,
            name: f.name,
            image: f.image,
            imageCount: Math.max(1, (f.images || []).length),
            price: Number(f.price),
            foodType: f.foodType === 'NonVeg' ? 'Non-Veg' : 'Veg',
            categoryId: f.categoryId,
            categoryName: f.categoryName || '',
            approvalStatus: f.approvalStatus,
            isAvailable: f.isAvailable,
            restaurantId: f.restaurantId,
            restaurantName: f.restaurant?.restaurantName || '',
        })),
        pagination: { page, limit, total, pages: Math.ceil(total / limit) },
    };
}
