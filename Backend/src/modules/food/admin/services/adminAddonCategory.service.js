import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { NotFoundError, ValidationError } from '../../../../core/auth/errors.js';

/**
 * Add-on categories (the old panel's Addons -> Addon Category): an admin
 * grouping for the add-on list, e.g. "Drinks" or "Extra toppings". Deleting a
 * category leaves its add-ons uncategorised (the foreign key is SET NULL).
 */

const serialize = (c) => ({
    id: c.id,
    name: c.name,
    isActive: c.isActive,
    sortOrder: c.sortOrder,
    addonCount: c._count?.addons ?? 0,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
});

const WITH_COUNT = { _count: { select: { addons: { where: { isDeleted: false } } } } };

const assertNameFree = async (name, exceptId = null) => {
    const clash = await prisma.foodAddonCategory.findFirst({
        where: { name: { equals: name, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) },
        select: { id: true },
    });
    if (clash) throw new ValidationError(`An addon category named "${name}" already exists`);
};

export async function listAddonCategories(query = {}) {
    const where = {};
    const search = String(query.search || '').trim().slice(0, 80);
    if (search) where.name = { contains: search, mode: 'insensitive' };
    if (query.active === 'true') where.isActive = true;
    const rows = await prisma.foodAddonCategory.findMany({
        where,
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
        include: WITH_COUNT,
    });
    return { categories: rows.map(serialize) };
}

export async function createAddonCategory(body) {
    await assertNameFree(body.name);
    const row = await prisma.foodAddonCategory.create({ data: body, include: WITH_COUNT });
    return serialize(row);
}

export async function updateAddonCategory(id, body) {
    if (!isId(id)) throw new ValidationError('Invalid addon category');
    if (body.name !== undefined) await assertNameFree(body.name, String(id));
    const row = await prisma.foodAddonCategory
        .update({ where: { id: String(id) }, data: body, include: WITH_COUNT })
        .catch((error) => {
            if (error?.code === 'P2025') throw new NotFoundError('Addon category not found');
            throw error;
        });
    return serialize(row);
}

export async function deleteAddonCategory(id) {
    if (!isId(id)) throw new ValidationError('Invalid addon category');
    const { count } = await prisma.foodAddonCategory.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('Addon category not found');
    return { deleted: true };
}

/** File one add-on under a category, or take it out of one (null). */
export async function setAddonCategory(addonId, categoryId) {
    if (!isId(addonId)) throw new ValidationError('Invalid add-on');
    if (categoryId !== null) {
        if (!isId(categoryId)) throw new ValidationError('Invalid addon category');
        const exists = await prisma.foodAddonCategory.findUnique({ where: { id: String(categoryId) }, select: { id: true } });
        if (!exists) throw new NotFoundError('Addon category not found');
    }
    const { count } = await prisma.foodAddon.updateMany({
        where: { id: String(addonId), isDeleted: false },
        data: { categoryId: categoryId === null ? null : String(categoryId) },
    });
    if (!count) throw new NotFoundError('Add-on not found');
    return { id: String(addonId), categoryId };
}
