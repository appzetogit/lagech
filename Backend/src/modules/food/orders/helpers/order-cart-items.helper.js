import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const uniqueIds = (ids = []) =>
  [...new Set(ids.map((id) => String(id || '').trim()).filter(isId))];

function resolveFoodItemPrice(foodDoc, rawItem) {
  const variantId = String(rawItem?.variantId || '').trim();
  // `variants` is a relation; each row carries its own id. `_id` is still
  // accepted because the prisma client extension adds it to every result and
  // shipped clients echo it back.
  const variants = Array.isArray(foodDoc?.variants) ? foodDoc.variants : [];

  if (variantId) {
    const variant = variants.find(
      (entry) => String(entry?.id ?? entry?._id ?? '') === variantId,
    );
    if (!variant) {
      throw new ValidationError(`${foodDoc.name} is no longer available in the selected size`);
    }
    const price = Number(variant.price) || 0;
    const otherPrice = Number(variant.otherPrice) || 0;
    return {
      price,
      otherPrice: otherPrice > price ? otherPrice : 0,
      variantId,
      variantName: String(variant.name || rawItem?.variantName || '').trim(),
      variantPrice: price,
    };
  }

  if (variants.length > 0) {
    throw new ValidationError(`Please select a size for ${foodDoc.name}`);
  }

  const price = Number(foodDoc.price) || 0;
  const otherPrice = Number(foodDoc.otherPrice) || 0;
  return {
    price,
    otherPrice: otherPrice > price ? otherPrice : 0,
    variantId: '',
    variantName: '',
    variantPrice: price,
  };
}

export async function resolveOrderCartItems(restaurantId, rawItems = []) {
  const items = Array.isArray(rawItems) ? rawItems : [];
  if (!items.length) throw new ValidationError('At least one item required');

  const rId = String(restaurantId);
  const itemIds = uniqueIds(items.map((item) => item.itemId || item.id));

  const [foodDocs, addonDocs, restaurantAddons] = await Promise.all([
    itemIds.length
      ? prisma.foodItem.findMany({
          where: { restaurantId: rId, id: { in: itemIds }, approvalStatus: 'approved' },
          // The variant the customer chose is priced from these rows.
          include: { variants: { orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] } },
        })
      : [],
    itemIds.length
      ? prisma.foodAddon.findMany({
          where: {
            restaurantId: rId,
            id: { in: itemIds },
            isDeleted: false,
            approvalStatus: 'approved',
            isAvailable: true,
          },
          select: { id: true, published: true },
        })
      : [],
    // Add-ons attached to a line, rather than sent as their own line item.
    //
    // Looked up across the whole restaurant, not just the ids in the cart, since
    // an attached add-on's id never appears in items[].itemId.
    prisma.foodAddon.findMany({
      where: { restaurantId: rId, isDeleted: false, approvalStatus: 'approved' },
    }),
  ]);

  const foodById = new Map(foodDocs.map((doc) => [doc.id, doc]));
  // `published` is Json, so the "has been published" check is a plain JS filter
  // rather than a null comparison Prisma spells three different ways.
  const addonById = new Map(
    addonDocs.filter((doc) => doc.published).map((doc) => [doc.id, doc]),
  );

  const attachableById = new Map();
  const attachableByName = new Map();
  for (const doc of restaurantAddons) {
    const published = doc?.published;
    if (!published?.name) continue;
    const entry = {
      addonId: doc.id,
      name: String(published.name).trim(),
      price: Number(published.price) || 0,
    };
    attachableById.set(entry.addonId, entry);
    attachableByName.set(entry.name.toLowerCase(), entry);
  }

  /**
   * Resolves whatever the client attached to a line into priced add-ons.
   *
   * Accepts ids or names, and objects or bare strings, because the shipped
   * apps send names while a corrected client sends ids — matching both means
   * live orders are billed correctly today without waiting on an app release.
   * Anything unrecognised is ignored rather than guessed at: charging for an
   * add-on we cannot identify is worse than omitting it.
   */
  const resolveAttachedAddons = (raw) => {
    if (!Array.isArray(raw) || raw.length === 0) return [];
    const out = [];
    for (const entry of raw) {
      const key = String(
        (entry && typeof entry === 'object' ? entry.addonId ?? entry.id ?? entry.name : entry) ?? '',
      ).trim();
      if (!key) continue;
      const match = attachableById.get(key) || attachableByName.get(key.toLowerCase());
      if (match) out.push({ ...match });
    }
    return out;
  };

  const resolved = [];

  for (const rawItem of items) {
    const itemId = String(rawItem?.itemId || rawItem?.id || '').trim();
    const quantity = Math.max(1, Number(rawItem?.quantity) || 1);

    if (!isId(itemId)) {
      throw new ValidationError('One or more cart items are invalid');
    }

    const foodDoc = foodById.get(itemId);
    if (foodDoc) {
      if (foodDoc.isAvailable === false) {
        throw new ValidationError(`${foodDoc.name} is currently unavailable`);
      }

      const pricing = resolveFoodItemPrice(foodDoc, rawItem);
      const addons = resolveAttachedAddons(rawItem?.addons);
      const addonsTotal = addons.reduce((sum, a) => sum + a.price, 0);

      resolved.push({
        itemId,
        name: String(foodDoc.name || rawItem?.name || 'Item').trim(),
        ...pricing,
        // The unit price the customer pays, add-ons included, so subtotal and
        // every total derived from it match what the app displayed.
        price: pricing.price + addonsTotal,
        addons,
        quantity,
        isVeg: String(foodDoc.foodType || '').toLowerCase() === 'veg',
        image: String(foodDoc.image || rawItem?.image || ''),
        notes: String(rawItem?.notes || ''),
      });
      continue;
    }

    const addonDoc = addonById.get(itemId);
    if (addonDoc?.published) {
      const published = addonDoc.published;
      const price = Number(published.price) || 0;
      resolved.push({
        itemId,
        name: String(published.name || rawItem?.name || 'Add-on').trim(),
        price,
        otherPrice: 0,
        variantId: '',
        variantName: '',
        variantPrice: price,
        quantity,
        isVeg: published.foodType !== 'non-veg',
        image: String(published.image || rawItem?.image || ''),
        notes: String(rawItem?.notes || ''),
      });
      continue;
    }

    throw new ValidationError(
      `${String(rawItem?.name || 'An item')} is no longer available from this restaurant`,
    );
  }

  return resolved;
}
