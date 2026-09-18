/**
 * Foods: `items` -> food_items, food_item_variants, food_addons.
 *
 * Written directly rather than through the restaurant or admin food services:
 * those put every new dish through approval and notify admins, which is right
 * for a restaurant adding a dish and wrong for 1,800 dishes that were already
 * approved and on sale.
 *
 * Prices follow what customers were actually charged, checked against old
 * orders:
 *
 *   - An option's price was ADDED to the base price. "Margherita (R)" is 150 and
 *     its Large option 115, and customers paid 265.
 *   - A discount applied to that total.
 *
 * The new model prices variants absolutely and makes choosing one mandatory,
 * so an item's first single-choice group becomes its variants, with the base
 * price as a variant of its own -- in the old system choosing no option meant
 * the base, and without that variant the base could no longer be ordered.
 * Every other group (multi-select, or a second group) becomes add-ons, which
 * the new model does price additively, with the same min/max rules.
 */
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../../../src/config/prisma.js';
import { config } from '../../../src/config/env.js';
import { buildPublicUrl } from '../../../src/services/storage.service.js';
import { loadIdMap, recordId } from '../idMap.mjs';
import { normalizeTags } from '../../../src/modules/food/shared/tags.util.js';

const ENTITY = 'food';
const IMAGE_DIR = 'legacy/product';

const money = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** The old discount, applied to a full unit price (base plus any option). */
const applyDiscount = (price, item) => {
    const discount = Number(item.discount) || 0;
    if (discount <= 0) return price;
    const off = item.discount_type === 'percent' ? (price * discount) / 100 : discount;
    return Math.max(0, money(price - off));
};

/** Customer price and struck-through original for a full unit price. */
const priced = (fullPrice, item) => {
    const price = applyDiscount(fullPrice, item);
    return { price, otherPrice: price < fullPrice ? money(fullPrice) : 0 };
};

const parseJson = (raw, fallback) => {
    if (raw === null || raw === undefined || raw === '') return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
};

/** Groups with at least one named option; empty placeholder groups are dropped. */
const variationGroups = (item) => (parseJson(item.food_variations, []) || [])
    .map((group) => ({
        name: String(group?.name || '').trim(),
        type: group?.type === 'multi' ? 'multi' : 'single',
        required: group?.required === 'on',
        min: parseInt(group?.min, 10) || 0,
        max: parseInt(group?.max, 10) || 0,
        values: (Array.isArray(group?.values) ? group.values : [])
            .map((value) => ({ label: String(value?.label || '').trim(), extra: money(value?.optionPrice) }))
            .filter((value) => value.label),
    }))
    .filter((group) => group.values.length);

/**
 * Name for the base-price variant, which the old data never named: choosing no
 * option was simply the base. "Chicken fried rice (Half)" names itself; an
 * option called "Full" implies the base is "Half"; otherwise "Regular".
 *
 * Never a name a real option already has. One item offered an option called
 * "Regular", and taking that name for the base pushed the real option to
 * "Regular 2" -- the option customers had been ordering by name.
 */
const baseVariantName = (item, group) => {
    const taken = new Set(group.values.map((value) => value.label.toLowerCase()));
    const suffix = String(item.name).match(/\(([^()]{1,20})\)\s*$/);
    const candidates = [
        suffix?.[1]?.trim(),
        group.values.some((value) => /^full$/i.test(value.label)) ? 'Half' : null,
        'Regular',
        'Standard',
        'Base',
    ];
    return candidates.find((name) => name && !taken.has(name.toLowerCase())) || 'Base';
};

/** Deepest category the old item was filed under: a sub-category beats its parent. */
const categoryOf = (item) => {
    const entries = parseJson(item.category_ids, []) || [];
    const deepest = [...entries]
        .filter((entry) => entry?.id)
        .sort((a, b) => (Number(b.position) || 0) - (Number(a.position) || 0))[0];
    return String(deepest?.id || item.category_id || '');
};

const imageUrl = (file) => {
    const name = String(file || '').trim();
    if (!name || name === 'def.png') return null;
    const onDisk = path.join(config.uploadStorageRoot || 'uploads', IMAGE_DIR, name);
    return fs.existsSync(onDisk) ? buildPublicUrl(`${IMAGE_DIR}/${name}`) : undefined;
};

export async function importFoods(mysql, report) {
    const restaurantMap = await loadIdMap('restaurant');
    const categoryMap = await loadIdMap('category');
    const idMap = await loadIdMap(ENTITY);

    const [[foodModule]] = await mysql.query(
        "SELECT id FROM modules WHERE module_type = 'food' ORDER BY status DESC, id LIMIT 1"
    );
    const [items] = await mysql.query('SELECT * FROM items WHERE module_id = ? ORDER BY id', [foodModule.id]);
    // Search tags, tidied the way the admin form tidies them.
    const [tagRows] = await mysql.query('SELECT it.item_id, t.tag FROM item_tag it JOIN tags t ON t.id = it.tag_id');
    const tagsByItem = new Map();
    for (const row of tagRows) {
        const key = String(row.item_id);
        tagsByItem.set(key, [...(tagsByItem.get(key) || []), row.tag]);
    }
    const categoryNames = new Map(
        (await prisma.foodCategory.findMany({ select: { id: true, name: true } })).map((c) => [c.id, c.name])
    );

    const notCarried = { availabilityWindow: 0, maxCartQuantity: 0 };

    for (const item of items) {
        const restaurantId = restaurantMap.get(String(item.store_id));
        if (!restaurantId) {
            report.skip(ENTITY, item.id, item.name, `restaurant ${item.store_id} no longer exists in the old data`);
            continue;
        }

        const legacyCategory = categoryOf(item);
        const categoryId = categoryMap.get(legacyCategory) || null;
        if (legacyCategory && !categoryId) {
            report.warn(ENTITY, item.id, item.name, `category ${legacyCategory} was not imported; imported uncategorised`);
        }

        const main = imageUrl(item.image);
        if (main === undefined) report.warn(ENTITY, item.id, item.name, `image ${item.image} not found; imported without it`);
        const gallery = (parseJson(item.images, []) || [])
            .map((entry) => imageUrl(entry?.img))
            .filter(Boolean);

        const groups = variationGroups(item);
        const sizeGroup = groups.find((group) => group.type === 'single') || null;
        const addonGroups = groups.filter((group) => group !== sizeGroup);

        const base = priced(money(item.price), item);
        const variants = [];
        if (sizeGroup) {
            const seen = new Set();
            const push = (name, fullPrice) => {
                let unique = name;
                for (let n = 2; seen.has(unique.toLowerCase()); n += 1) unique = `${name} ${n}`;
                if (unique !== name) report.warn(ENTITY, item.id, item.name, `duplicate option "${name}" renamed "${unique}"`);
                seen.add(unique.toLowerCase());
                variants.push({ name: unique, ...priced(fullPrice, item), sortOrder: variants.length });
            };
            push(baseVariantName(item, sizeGroup), money(item.price));
            for (const value of sizeGroup.values) push(value.label, money(item.price) + value.extra);
        }

        if (item.available_time_starts && item.available_time_ends
            && !(String(item.available_time_starts).startsWith('00:00') && String(item.available_time_ends) >= '23:59')) {
            notCarried.availabilityWindow += 1;
        }
        if (Number(item.maximum_cart_quantity) > 0) notCarried.maxCartQuantity += 1;

        const data = {
            restaurantId,
            categoryId,
            categoryName: categoryId ? categoryNames.get(categoryId) || '' : '',
            name: String(item.name).trim(),
            description: String(item.description || '').trim(),
            price: base.price,
            otherPrice: base.otherPrice,
            image: main || '',
            images: gallery,
            foodType: item.veg === 1 ? 'Veg' : 'NonVeg',
            isAvailable: item.status === 1,
            isRecommended: item.recommended === 1,
            tags: normalizeTags(tagsByItem.get(String(item.id)) || []),
            approvalStatus: item.is_approved === 1 ? 'approved' : 'pending',
            approvedAt: item.is_approved === 1 ? item.created_at || new Date() : null,
            rating: Math.min(5, Math.max(0, Math.round((Number(item.avg_rating) || 0) * 10) / 10)),
            totalRatings: Number(item.rating_count) || 0,
            ...(item.created_at ? { createdAt: item.created_at } : {}),
        };

        const existingId = idMap.get(String(item.id));
        const exists = existingId && (await prisma.foodItem.count({ where: { id: existingId } })) > 0;

        const foodId = await prisma.$transaction(async (tx) => {
            const food = exists
                ? await tx.foodItem.update({ where: { id: existingId }, data })
                : await tx.foodItem.create({ data });

            // Variants and imported add-ons are replaced wholesale on a re-run:
            // the old data is the source of truth until cut-over.
            await tx.foodItemVariant.deleteMany({ where: { foodItemId: food.id } });
            if (variants.length) {
                await tx.foodItemVariant.createMany({
                    data: variants.map((variant) => ({ foodItemId: food.id, ...variant })),
                });
            }

            // Only add-ons this import made for this item: a restaurant's own
            // add-ons carry no importedFrom marker and are never touched.
            await tx.foodAddon.deleteMany({
                where: { restaurantId, draft: { path: ['importedFrom'], equals: `legacy:${item.id}` } },
            });
            for (const [groupIndex, group] of addonGroups.entries()) {
                const maxSelect = group.type === 'single' ? 1 : (group.max || group.values.length);
                const minSelect = group.required ? Math.max(1, group.min) : 0;
                for (const value of group.values) {
                    // Named per item: the cart can resolve an add-on by name, and
                    // "Medium" on two pizzas at different prices must not collide.
                    const option = {
                        name: `${value.label} · ${data.name}`,
                        description: '',
                        foodType: data.foodType,
                        price: applyDiscount(value.extra, item),
                        image: '',
                        images: [],
                        importedFrom: `legacy:${item.id}`,
                    };
                    await tx.foodAddon.create({
                        data: {
                            restaurantId,
                            foodIds: [food.id],
                            groupName: group.name || 'Options',
                            groupMinSelect: minSelect,
                            groupMaxSelect: Math.max(minSelect, maxSelect),
                            groupSortOrder: groupIndex,
                            draft: option,
                            published: option,
                            approvalStatus: 'approved',
                            approvedAt: new Date(),
                        },
                    });
                }
            }
            return food.id;
        });

        if (addonGroups.length) {
            report.warn(ENTITY, item.id, item.name,
                `${addonGroups.length} option group(s) imported as add-ons (${addonGroups.map((g) => g.name || 'unnamed').join(', ')})`);
        }

        await recordId(ENTITY, item.id, foodId);
        report.done(ENTITY, exists ? 'updated' : 'created');
    }

    if (notCarried.availabilityWindow) {
        report.warn(ENTITY, '-', '(all)',
            `${notCarried.availabilityWindow} item(s) had their own serving hours; the new model has none, so they follow the restaurant's hours`);
    }
    if (notCarried.maxCartQuantity) {
        report.warn(ENTITY, '-', '(all)',
            `${notCarried.maxCartQuantity} item(s) had a maximum cart quantity; the new model has none`);
    }
}
