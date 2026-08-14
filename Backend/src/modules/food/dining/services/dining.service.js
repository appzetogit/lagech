import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const slugify = (value) =>
    String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');

const toIdArray = (values) =>
    Array.from(
        new Set(
            (Array.isArray(values) ? values : [values])
                .map((value) => String(value || '').trim())
                .filter(isId)
        )
    );

/** Restaurant columns the dining screens read. */
const RESTAURANT_FIELDS = {
    id: true, restaurantName: true, ownerName: true, ownerPhone: true,
    profileImage: true, coverImages: true, menuImages: true,
    area: true, city: true, status: true, rating: true, pureVegRestaurant: true,
    diningEnabled: true, diningMaxGuests: true, diningType: true,
};

/**
 * Mirror the dining row onto the restaurant's own columns.
 *
 * The restaurant carries a flattened copy because the customer-facing feed
 * filters on it, and joining every listing to food_dining_restaurants to answer
 * "is dining on" is not worth it. It is a cache, and this is the only writer.
 */
async function syncRestaurantDiningSettings(tx, restaurantId, dining) {
    const primarySlug = dining?.primaryCategoryId
        ? (await tx.foodDiningCategory.findUnique({
            where: { id: dining.primaryCategoryId },
            select: { slug: true },
        }))?.slug
        : null;

    await tx.foodRestaurant.update({
        where: { id: restaurantId },
        data: {
            diningEnabled: Boolean(dining?.isEnabled),
            diningMaxGuests: Math.max(1, Number(dining?.maxGuests) || 6),
            diningType: primarySlug || 'family-dining',
        },
    });
}

/**
 * Keep FoodDiningCategory.restaurantIds agreeing with the dining rows.
 *
 * ponytail: the link is stored in both directions — categoryIds here,
 * restaurantIds there — so the two can drift. food_dining_restaurants is the
 * writer's side; the mirror exists only so the admin grid can show a count.
 * A join table would remove the question entirely, and needs a migration.
 *
 * Both halves run in the caller's transaction: as two loose updateMany calls, a
 * failure between them left a restaurant listed under a category it had just
 * been removed from.
 */
async function syncCategoryRestaurantLinks(tx, restaurantId, categoryIds) {
    const stale = await tx.foodDiningCategory.findMany({
        where: { restaurantIds: { has: restaurantId }, id: { notIn: categoryIds } },
        select: { id: true, restaurantIds: true },
    });

    for (const category of stale) {
        await tx.foodDiningCategory.update({
            where: { id: category.id },
            data: { restaurantIds: category.restaurantIds.filter((id) => id !== restaurantId) },
        });
    }

    if (categoryIds.length) {
        const linked = await tx.foodDiningCategory.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, restaurantIds: true },
        });
        for (const category of linked) {
            if (category.restaurantIds.includes(restaurantId)) continue;
            await tx.foodDiningCategory.update({
                where: { id: category.id },
                data: { restaurantIds: [...category.restaurantIds, restaurantId] },
            });
        }
    }
}

function mapCategory(doc) {
    return {
        _id: doc.id,
        name: doc.name,
        slug: doc.slug,
        imageUrl: doc.imageUrl || '',
        isActive: doc.isActive !== false,
        sortOrder: doc.sortOrder || 0,
        restaurantCount: Array.isArray(doc.restaurantIds) ? doc.restaurantIds.length : 0,
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt,
    };
}

const getRestaurantZone = (restaurant) => restaurant?.area || restaurant?.city || 'N/A';

/** First usable image: cover, then menu, then the profile picture. */
function getRestaurantImage(restaurant) {
    const firstUrl = (list) =>
        Array.isArray(list)
            ? list.map((image) => (typeof image === 'string' ? image : image?.url || '')).find(Boolean)
            : '';

    const cover = firstUrl(restaurant?.coverImages);
    if (cover) return cover;

    const menu = firstUrl(restaurant?.menuImages);
    if (menu) return menu;

    const profile = restaurant?.profileImage;
    if (!profile) return '';
    return typeof profile === 'string' ? profile : profile?.url || '';
}

function mapDiningRestaurant(restaurant, dining, categoriesById) {
    const categoryIds = (dining?.categoryIds || []).map(String);
    const categories = categoryIds
        .map((id) => categoriesById.get(id))
        .filter(Boolean)
        .map((category) => ({
            _id: category.id,
            name: category.name,
            slug: category.slug,
            imageUrl: category.imageUrl || '',
        }));

    const primaryCategoryId = dining?.primaryCategoryId ? String(dining.primaryCategoryId) : '';
    const primaryCategory =
        categories.find((category) => String(category._id) === primaryCategoryId) || categories[0] || null;

    const pureVeg = dining?.pureVegRestaurant === true || restaurant?.pureVegRestaurant === true;

    return {
        _id: restaurant.id,
        id: restaurant.id,
        name: restaurant.restaurantName || 'N/A',
        restaurantName: restaurant.restaurantName || 'N/A',
        ownerName: restaurant.ownerName || 'N/A',
        ownerPhone: restaurant.ownerPhone || 'N/A',
        pureVegRestaurant: pureVeg,
        zone: getRestaurantZone(restaurant),
        city: restaurant?.city || '',
        status: restaurant.status,
        isActive: restaurant.status === 'approved',
        rating: Number(restaurant.rating || 0),
        logo: getRestaurantImage(restaurant),
        categories,
        categoryIds,
        primaryCategoryId: primaryCategory?._id || null,
        diningSettings: {
            isEnabled: Boolean(dining?.isEnabled),
            maxGuests: Math.max(1, Number(dining?.maxGuests) || 6),
            pureVegRestaurant: pureVeg,
            diningType: primaryCategory?.slug || restaurant?.diningType || '',
        },
    };
}

export async function listDiningCategoriesAdmin() {
    const categories = await prisma.foodDiningCategory.findMany({
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    return { categories: categories.map(mapCategory) };
}

export async function createDiningCategory(body = {}) {
    const name = String(body.name || '').trim();
    if (!name) throw new ValidationError('Category name is required');

    const slug = slugify(body.slug || name);
    if (!slug) throw new ValidationError('Category slug is required');

    try {
        const created = await prisma.foodDiningCategory.create({
            data: {
                name,
                slug,
                imageUrl: String(body.imageUrl || '').trim(),
                isActive: body.isActive !== false,
                sortOrder: Number(body.sortOrder) || 0,
            },
        });
        return mapCategory(created);
    } catch (error) {
        // slug is unique in the database, so let the insert decide rather than
        // checking first — the check-then-insert let two admins create the same
        // category at the same time.
        if (error?.code === 'P2002') throw new ValidationError('Dining category already exists');
        throw error;
    }
}

export async function updateDiningCategory(id, body = {}) {
    if (!isId(id)) return null;

    const existing = await prisma.foodDiningCategory.findUnique({ where: { id } });
    if (!existing) return null;

    const data = {};
    if (body.name !== undefined) data.name = String(body.name || '').trim();
    if (body.slug !== undefined || body.name !== undefined) {
        data.slug = slugify(body.slug || data.name || existing.name);
    }
    if (body.imageUrl !== undefined) data.imageUrl = String(body.imageUrl || '').trim();
    if (body.isActive !== undefined) data.isActive = body.isActive !== false;
    if (body.sortOrder !== undefined) data.sortOrder = Number(body.sortOrder) || 0;

    const updated = await prisma
        .$transaction(async (tx) => {
            const category = await tx.foodDiningCategory.update({ where: { id }, data });

            // The restaurant's diningType mirrors its primary category's slug, so
            // a renamed slug has to be pushed out to everyone using it.
            if (data.slug && data.slug !== existing.slug) {
                const affected = await tx.foodDiningRestaurant.findMany({
                    where: { primaryCategoryId: id },
                });
                for (const dining of affected) {
                    await syncRestaurantDiningSettings(tx, dining.restaurantId, dining);
                }
            }

            return category;
        })
        .catch((error) => {
            if (error?.code === 'P2002') {
                throw new ValidationError('Dining category slug already exists');
            }
            throw error;
        });

    return mapCategory(updated);
}

export async function deleteDiningCategory(id) {
    if (!isId(id)) return null;

    const category = await prisma.foodDiningCategory.findUnique({ where: { id } });
    if (!category) return null;

    await prisma.$transaction(async (tx) => {
        // primaryCategoryId is a real foreign key now, so every reference has to
        // be cleared before the delete rather than left dangling as it was in
        // Mongo — otherwise the delete is refused.
        const affected = await tx.foodDiningRestaurant.findMany({
            where: { OR: [{ categoryIds: { has: id } }, { primaryCategoryId: id }] },
        });

        for (const dining of affected) {
            const categoryIds = (dining.categoryIds || []).filter((value) => String(value) !== id);
            const next = await tx.foodDiningRestaurant.update({
                where: { id: dining.id },
                data: {
                    categoryIds,
                    primaryCategoryId:
                        String(dining.primaryCategoryId) === id
                            ? categoryIds[0] || null
                            : dining.primaryCategoryId,
                },
            });
            await syncRestaurantDiningSettings(tx, next.restaurantId, next);
        }

        await tx.foodDiningCategory.delete({ where: { id } });
    });

    return { id };
}

export async function listDiningRestaurantsAdmin() {
    const [restaurants, diningRows, categories] = await Promise.all([
        prisma.foodRestaurant.findMany({
            orderBy: { createdAt: 'desc' },
            select: RESTAURANT_FIELDS,
        }),
        prisma.foodDiningRestaurant.findMany({
            select: {
                restaurantId: true, categoryIds: true, primaryCategoryId: true,
                isEnabled: true, maxGuests: true, pureVegRestaurant: true,
            },
        }),
        prisma.foodDiningCategory.findMany({
            select: { id: true, name: true, slug: true, imageUrl: true },
        }),
    ]);

    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const diningByRestaurantId = new Map(diningRows.map((row) => [row.restaurantId, row]));

    return {
        restaurants: restaurants.map((restaurant) =>
            mapDiningRestaurant(restaurant, diningByRestaurantId.get(restaurant.id), categoriesById)
        ),
    };
}

/** Accepts a real boolean or the strings a multipart form sends. */
const toBoolean = (value, fallback) => {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (['true', '1', 'yes'].includes(normalized)) return true;
        if (['false', '0', 'no'].includes(normalized)) return false;
    }
    return fallback;
};

export async function updateDiningRestaurant(restaurantId, body = {}) {
    if (!isId(restaurantId)) return null;

    const restaurant = await prisma.foodRestaurant.findUnique({
        where: { id: String(restaurantId) },
        select: RESTAURANT_FIELDS,
    });
    if (!restaurant) return null;

    const dining = await prisma.$transaction(async (tx) => {
        const existing = await tx.foodDiningRestaurant.findUnique({
            where: { restaurantId: restaurant.id },
        });

        const requestedIds =
            body.categoryIds !== undefined
                ? toIdArray(body.categoryIds)
                : existing?.categoryIds || [];

        // Drop ids that no longer name a category, so a stale admin tab cannot
        // write a dangling reference.
        const categoryIds = requestedIds.length
            ? (await tx.foodDiningCategory.findMany({
                where: { id: { in: requestedIds } },
                select: { id: true },
            })).map((category) => category.id)
            : [];

        let primaryCategoryId =
            body.primaryCategoryId !== undefined
                ? (isId(body.primaryCategoryId) ? String(body.primaryCategoryId) : null)
                : existing?.primaryCategoryId || null;

        // The primary has to be one of the selected categories.
        if (!primaryCategoryId || !categoryIds.includes(primaryCategoryId)) {
            primaryCategoryId = categoryIds[0] || null;
        }

        const data = {
            categoryIds,
            primaryCategoryId,
            isEnabled: body.isEnabled !== undefined
                ? body.isEnabled === true
                : existing?.isEnabled ?? false,
            maxGuests: body.maxGuests !== undefined
                ? Math.max(1, parseInt(body.maxGuests, 10) || 6)
                : existing?.maxGuests ?? 6,
            pureVegRestaurant: toBoolean(
                body.pureVegRestaurant,
                existing?.pureVegRestaurant ?? restaurant.pureVegRestaurant === true,
            ),
        };

        const saved = await tx.foodDiningRestaurant.upsert({
            where: { restaurantId: restaurant.id },
            create: { restaurantId: restaurant.id, ...data },
            update: data,
        });

        await syncCategoryRestaurantLinks(tx, restaurant.id, categoryIds);
        await syncRestaurantDiningSettings(tx, restaurant.id, saved);

        return saved;
    });

    const categories = await prisma.foodDiningCategory.findMany({
        select: { id: true, name: true, slug: true, imageUrl: true },
    });
    const categoriesById = new Map(categories.map((category) => [category.id, category]));

    return mapDiningRestaurant(restaurant, dining, categoriesById);
}

export async function listDiningCategoriesPublic() {
    const categories = await prisma.foodDiningCategory.findMany({
        where: { isActive: true },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
    });
    return categories.map(mapCategory);
}

export async function listDiningRestaurantsPublic(query = {}) {
    const categoryValue = String(query.category || '').trim();
    const cityValue = String(query.city || '').trim();

    const where = { diningEnabled: true, status: 'approved' };
    if (cityValue) where.city = { contains: cityValue, mode: 'insensitive' };

    if (categoryValue) {
        const category = await prisma.foodDiningCategory.findFirst({
            where: isId(categoryValue)
                ? { OR: [{ id: categoryValue }, { slug: categoryValue.toLowerCase() }] }
                : { slug: categoryValue.toLowerCase() },
            select: { id: true },
        });
        if (!category) return [];

        // Read the membership from the dining rows, which is the side the writes
        // go to, rather than from the mirrored restaurantIds array.
        const members = await prisma.foodDiningRestaurant.findMany({
            where: { categoryIds: { has: category.id } },
            select: { restaurantId: true },
        });
        if (!members.length) return [];
        where.id = { in: members.map((m) => m.restaurantId) };
    }

    const restaurants = await prisma.foodRestaurant.findMany({
        where,
        select: {
            ...RESTAURANT_FIELDS,
            restaurantNameNormalized: true, cuisines: true,
            estimatedDeliveryTime: true, estimatedDeliveryTimeMinutes: true,
            featuredDish: true, featuredPrice: true, offer: true,
            openingTime: true, closingTime: true, openDays: true,
            isAcceptingOrders: true,
        },
    });
    if (!restaurants.length) return [];

    const diningRows = await prisma.foodDiningRestaurant.findMany({
        where: { restaurantId: { in: restaurants.map((r) => r.id) } },
    });
    const categoryIds = [...new Set(diningRows.flatMap((row) => row.categoryIds || []))];
    const categories = categoryIds.length
        ? await prisma.foodDiningCategory.findMany({
            where: { id: { in: categoryIds } },
            select: { id: true, name: true, slug: true, imageUrl: true },
        })
        : [];

    const categoriesById = new Map(categories.map((category) => [category.id, category]));
    const diningByRestaurantId = new Map(diningRows.map((row) => [row.restaurantId, row]));

    return restaurants.map((restaurant) => {
        const dining = diningByRestaurantId.get(restaurant.id);
        // categoryIds was a .populate() in Mongo; the ids are a plain column, so
        // the categories are gathered in one query above and mapped here.
        const linked = (dining?.categoryIds || []).map((id) => categoriesById.get(id)).filter(Boolean);

        return {
            ...restaurant,
            restaurant,
            categories: linked,
            diningSettings: {
                isEnabled: true,
                maxGuests: Math.max(1, Number(dining?.maxGuests || restaurant.diningMaxGuests) || 6),
                pureVegRestaurant:
                    restaurant.pureVegRestaurant === true || dining?.pureVegRestaurant === true,
                diningType: linked[0]?.slug || restaurant.diningType || 'family-dining',
            },
        };
    });
}
