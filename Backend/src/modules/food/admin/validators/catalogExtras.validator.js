import { z } from 'zod';
import { ValidationError } from '../../../../core/auth/errors.js';

const id = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

const parse = (schema, value, fallback) => {
    const result = schema.safeParse(value ?? {});
    if (!result.success) throw new ValidationError(result.error.errors[0]?.message || fallback);
    return result.data;
};

const addonCategoryCreate = z.object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name must be 100 characters or fewer'),
    isActive: z.boolean().optional(),
    sortOrder: z.coerce.number().int('Sort order must be a whole number').min(0).max(100000).optional(),
});

export const validateAddonCategoryCreate = (body) => parse(addonCategoryCreate, body, 'Invalid addon category');
export const validateAddonCategoryUpdate = (body) => {
    const data = parse(addonCategoryCreate.partial(), body, 'Invalid addon category');
    if (!Object.keys(data).length) throw new ValidationError('Nothing to change');
    return data;
};

export const validateSetAddonCategory = (body) =>
    parse(z.object({ categoryId: id.nullable() }), body, 'Choose an addon category').categoryId;

export const validateReviewVisibility = (body) =>
    parse(z.object({ hidden: z.boolean({ required_error: 'Say whether to hide or show the review' }) }), body, 'Invalid request').hidden;

export const validateRecommendedList = (body) =>
    parse(z.object({ restaurantIds: z.array(id).max(50, 'At most 50 recommended restaurants') }), body, 'Invalid restaurant list')
        .restaurantIds;

export const validateDisplayPosition = (body) =>
    parse(
        z.object({
            position: z.union([
                z.null(),
                z.coerce.number().int('Position must be a whole number').min(1, 'Position starts at 1').max(9999, 'Position is too large'),
            ]),
        }),
        body,
        'Invalid position',
    ).position;
