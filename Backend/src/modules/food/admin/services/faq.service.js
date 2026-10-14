import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import {
    readFaqInput,
    readFaqOrder,
    normalizeAudience,
    faqsForAudience,
    serializeFaq,
    publicFaq,
} from './faq.helpers.js';

/**
 * FAQs (old 6amMart f_a_q_s): the admin's list, add, edit, delete, reorder
 * and on/off, and the public read behind GET /food/faqs?audience=customer.
 */

const ORDER = [{ sortOrder: 'asc' }, { createdAt: 'asc' }];

// The public list, read at most once a minute per process; any admin write
// here drops it at once (other processes catch up within the minute).
const TTL_MS = 60 * 1000;
let publicCache = { at: 0, rows: null };

export function invalidateFaqCache() {
    publicCache = { at: 0, rows: null };
}

export async function listFaqs(query = {}) {
    const where = {};
    if (query.audience !== undefined && query.audience !== '') {
        const audience = String(query.audience).toLowerCase() === 'everyone' ? null : normalizeAudience(query.audience);
        if (audience === undefined) throw new ValidationError('Unknown audience');
        where.audience = audience;
    }
    if (query.status === 'active') where.isActive = true;
    if (query.status === 'inactive') where.isActive = false;
    const search = String(query.search || '').trim().slice(0, 100);
    if (search) {
        where.OR = [
            { question: { contains: search, mode: 'insensitive' } },
            { answer: { contains: search, mode: 'insensitive' } },
        ];
    }
    const rows = await prisma.foodFaq.findMany({ where, orderBy: ORDER });
    return { faqs: rows.map(serializeFaq), total: rows.length };
}

export async function createFaq(body = {}) {
    const data = readFaqInput(body);
    if (data.sortOrder === undefined) {
        // New questions go to the end of the list.
        const last = await prisma.foodFaq.findFirst({ orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } });
        data.sortOrder = last ? last.sortOrder + 1 : 0;
    }
    const row = await prisma.foodFaq.create({ data });
    invalidateFaqCache();
    return serializeFaq(row);
}

export async function updateFaq(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid FAQ');
    const data = readFaqInput(body, { partial: true });
    const { count } = await prisma.foodFaq.updateMany({ where: { id: String(id) }, data });
    if (!count) throw new NotFoundError('FAQ not found');
    invalidateFaqCache();
    return serializeFaq(await prisma.foodFaq.findUnique({ where: { id: String(id) } }));
}

export async function deleteFaq(id) {
    if (!isId(id)) throw new ValidationError('Invalid FAQ');
    const { count } = await prisma.foodFaq.deleteMany({ where: { id: String(id) } });
    if (!count) throw new NotFoundError('FAQ not found');
    invalidateFaqCache();
    return { id: String(id), deleted: true };
}

/** body.ids: FAQ ids in their new order (all of them, or the ones moved). */
export async function reorderFaqs(body = {}) {
    const ids = readFaqOrder(body);
    const found = await prisma.foodFaq.count({ where: { id: { in: ids } } });
    if (found !== ids.length) throw new NotFoundError('FAQ not found');
    await prisma.$transaction(ids.map((id, index) => prisma.foodFaq.update({ where: { id }, data: { sortOrder: index } })));
    invalidateFaqCache();
    return listFaqs();
}

/** Active FAQs for one audience (plus those for everyone), for the apps and the website. */
export async function getPublicFaqs(query = {}) {
    const audience = normalizeAudience(query.audience);
    if (audience === undefined) throw new ValidationError('audience must be customer, restaurant or rider');
    if (!publicCache.rows || Date.now() - publicCache.at >= TTL_MS) {
        const rows = await prisma.foodFaq.findMany({ where: { isActive: true }, orderBy: ORDER });
        publicCache = { at: Date.now(), rows };
    }
    return { audience, faqs: faqsForAudience(publicCache.rows, audience).map(publicFaq) };
}
