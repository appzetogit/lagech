import { prisma } from '../../../config/prisma.js';
import { isId } from '../../../utils/helpers.js';
import { ValidationError } from '../../../core/auth/errors.js';
import { campaignPrice, campaignState } from './campaignSchedule.js';
import { resolveOrderCartItems } from '../orders/helpers/order-cart-items.helper.js';

/**
 * Food campaign dishes in a cart.
 *
 * A food campaign is a dish of its own (food_item_campaigns), not a menu item,
 * so a cart line for one carries `campaignId` (and `itemId` set to the same
 * id). Everything about it is read from the campaign row here -- the client's
 * price is never used:
 *
 *   - the campaign must belong to the restaurant being ordered from, be
 *     switched on and be running at the time the order is for;
 *   - the line is priced at the campaign's full `price`, and what the
 *     campaign takes off (price - finalPrice) is reported per unit as
 *     `campaignDiscount`. Pricing adds those up into the order's
 *     campaignDiscount, which is part of `discount`.
 *
 * Who pays for it: the campaign model has no restaurant share, so the
 * platform funds the whole discount, as it does the new-customer discount.
 * The restaurant is settled -- and charged commission -- on the full price;
 * the customer pays the campaign price.
 */

const round2 = (value) => Math.round((Number(value) || 0) * 100) / 100;

/** The campaign id a raw cart line names, or '' for a menu line. */
export const lineCampaignId = (raw) => {
    const id = String(raw?.campaignId || raw?.itemCampaignId || '').trim();
    return isId(id) ? id : '';
};

/** Campaign dishes for one restaurant, priced from their rows. */
export async function resolveCampaignLines(restaurantId, rawLines, at = new Date()) {
    if (!rawLines.length) return [];
    const ids = [...new Set(rawLines.map(lineCampaignId))];
    const rows = await prisma.foodItemCampaign.findMany({ where: { id: { in: ids } } });
    const byId = new Map(rows.map((row) => [row.id, row]));

    return rawLines.map((raw) => {
        const row = byId.get(lineCampaignId(raw));
        const label = String(row?.title || raw?.name || 'This campaign dish');
        if (!row || row.restaurantId !== String(restaurantId)) {
            throw new ValidationError(`${label} is no longer available from this restaurant`);
        }
        if (campaignState(row, at) !== 'running') {
            throw new ValidationError(`The ${label} campaign is not running${at > new Date() ? ' at the time you picked' : ' any more'}`);
        }
        const price = round2(row.price);
        const finalPrice = campaignPrice(price, row.discountType, row.discount);
        return {
            itemId: row.id,
            itemCampaignId: row.id,
            name: row.title,
            price,
            otherPrice: 0,
            variantId: '',
            variantName: '',
            variantPrice: price,
            addons: [],
            quantity: Math.max(1, Number(raw?.quantity) || 1),
            isVeg: row.foodType !== 'NonVeg',
            image: row.image || '',
            notes: String(raw?.notes || ''),
            /** What the customer pays per unit while the campaign runs. */
            campaignPrice: finalPrice,
            /** Per unit, borne by the platform. */
            campaignDiscount: round2(price - finalPrice),
        };
    });
}

/**
 * resolveOrderCartItems, plus campaign dishes. Lines come back in the order
 * they were sent; a cart with no campaign line goes through untouched.
 */
export async function resolveCartWithCampaigns(restaurantId, rawItems = [], at = new Date()) {
    const items = Array.isArray(rawItems) ? rawItems : [];
    const isCampaign = items.map((raw) => Boolean(lineCampaignId(raw)));
    if (!isCampaign.some(Boolean)) return resolveOrderCartItems(restaurantId, items);

    const menuRaw = items.filter((_, i) => !isCampaign[i]);
    const [menu, campaign] = await Promise.all([
        menuRaw.length ? resolveOrderCartItems(restaurantId, menuRaw) : [],
        resolveCampaignLines(restaurantId, items.filter((_, i) => isCampaign[i]), at),
    ]);
    let m = 0;
    let c = 0;
    return items.map((_, i) => (isCampaign[i] ? campaign[c++] : menu[m++]));
}

/** Total the campaigns take off a resolved cart. */
export const cartCampaignDiscount = (items = []) =>
    round2(items.reduce((sum, it) => sum + (Number(it.campaignDiscount) || 0) * (Number(it.quantity) || 1), 0));
