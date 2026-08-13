import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import { findApprovedRestaurant, toAddonGroup } from './restaurantLookup.helper.js';

/**
 * Folds a flat add-on list into the grouped, rule-carrying shape the item sheet
 * renders: a heading, a "Select up to N" subtitle, and radio vs checkbox choice.
 *
 * Rules live on each member, so members of one group could disagree. The lowest
 * sortOrder wins rather than, say, the max — a restaurant lowering maxSelect from
 * 2 to 1 on the first option should take effect, not be silently overridden by a
 * stale sibling.
 */
export function buildAddonGroups(addons = []) {
    const byName = new Map();

    for (const addon of addons) {
        const key = addon.group?.name || '';
        if (!byName.has(key)) {
            byName.set(key, {
                name: key,
                // Ungrouped extras still need a heading in the sheet.
                title: key || 'Add-ons',
                minSelect: Number(addon.group?.minSelect) || 0,
                maxSelect: Number(addon.group?.maxSelect) || 1,
                sortOrder: Number(addon.group?.sortOrder) || 0,
                options: [],
            });
        }
        const group = byName.get(key);
        const order = Number(addon.group?.sortOrder) || 0;
        if (order < group.sortOrder) {
            group.sortOrder = order;
            group.minSelect = Number(addon.group?.minSelect) || 0;
            group.maxSelect = Number(addon.group?.maxSelect) || 1;
        }
        group.options.push(addon);
    }

    return [...byName.values()]
        .sort((a, b) => a.sortOrder - b.sortOrder || a.title.localeCompare(b.title))
        .map((g) => ({
            ...g,
            isRequired: g.minSelect > 0,
            // Exactly how Zomato labels it, so the app does not have to reinvent it.
            selectionLabel:
                g.minSelect > 0
                    ? `Required • Select any ${g.minSelect} option${g.minSelect > 1 ? 's' : ''}`
                    : `Select up to ${g.maxSelect} option${g.maxSelect > 1 ? 's' : ''}`,
            /** 'single' => radio buttons, 'multi' => checkboxes. */
            selectionType: g.maxSelect <= 1 ? 'single' : 'multi',
        }));
}

export async function getPublicApprovedRestaurantAddons(restaurantIdOrSlug, { foodId } = {}) {
    if (!String(restaurantIdOrSlug || '').trim()) {
        throw new ValidationError('Restaurant id is required');
    }

    const restaurant = await findApprovedRestaurant(restaurantIdOrSlug);
    if (!restaurant?.id) return null;

    const where = {
        restaurantId: restaurant.id,
        isDeleted: false,
        approvalStatus: 'approved',
        isAvailable: true,
    };

    // Per-item lookup. An add-on with empty foodIds applies to the whole menu
    // (the only behaviour that existed before item linking), so it must still be
    // offered alongside the item-specific ones rather than filtered out.
    const wanted = String(foodId || '').trim();
    if (wanted) {
        if (!isId(wanted)) throw new ValidationError('Invalid menu item id');
        where.OR = [{ foodIds: { has: wanted } }, { foodIds: { isEmpty: true } }];
    }

    const addons = await prisma.foodAddon.findMany({
        where,
        orderBy: [{ approvedAt: 'desc' }, { updatedAt: 'desc' }],
        select: {
            id: true, published: true, foodIds: true,
            groupName: true, groupMinSelect: true, groupMaxSelect: true, groupSortOrder: true,
        },
    });

    const flat = (addons || [])
        // `published` is Json, so "has been published" is a plain JS check rather
        // than a null comparison Prisma spells three different ways.
        .filter((a) => a && a.published)
        .map((a) => {
            const p = a.published;
            return {
                id: a.id,
                _id: a.id,
                name: p.name || '',
                description: p.description || '',
                foodType: p.foodType === 'non-veg' ? 'non-veg' : 'veg',
                isVeg: p.foodType !== 'non-veg',
                price: Number(p.price) || 0,
                image: p.image || '',
                images: Array.isArray(p.images) ? p.images : [],
                // Lets the app group add-ons per item from one unfiltered fetch.
                foodIds: (a.foodIds || []).map(String),
                appliesToWholeMenu: !Array.isArray(a.foodIds) || a.foodIds.length === 0,
                group: toAddonGroup(a),
            };
        });

    // Flat list stays for existing callers; groups is what the item sheet renders.
    return { addons: flat, groups: buildAddonGroups(flat) };
}
