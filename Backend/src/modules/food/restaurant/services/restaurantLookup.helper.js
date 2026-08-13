import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';

/**
 * Resolve an approved restaurant from either its id or its name-slug.
 *
 * The same id-or-slug branch was copy-pasted across the public menu, addon and
 * food endpoints; keeping one copy means a change to slug normalisation cannot
 * apply to two of the three.
 *
 * @returns the restaurant row, or null when nothing approved matches
 */
export async function findApprovedRestaurant(restaurantIdOrSlug, select = { id: true, status: true }) {
    const value = String(restaurantIdOrSlug || '').trim();
    if (!value) return null;

    if (isId(value)) {
        return prisma.foodRestaurant.findFirst({
            where: { id: value, status: 'approved' },
            select,
        });
    }

    const normalized = value.toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ');
    return prisma.foodRestaurant.findFirst({
        where: { restaurantNameNormalized: normalized, status: 'approved' },
        select,
    });
}

/**
 * The add-on grouping rules were a nested `group` subdocument and are four flat
 * columns now. Callers and the API still speak the nested shape.
 */
export const toAddonGroup = (addon) => ({
    name: addon.groupName || '',
    minSelect: Number(addon.groupMinSelect) || 0,
    maxSelect: Number(addon.groupMaxSelect) || 1,
    sortOrder: Number(addon.groupSortOrder) || 0,
});
