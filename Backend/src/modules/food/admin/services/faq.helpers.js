import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * FAQ rules that need no database: what an admin may save, who a question is
 * for, and which questions a public reader sees. Used by faq.service.js and
 * the legacy import (f_a_q_s).
 */

export const FAQ_AUDIENCES = ['customer', 'restaurant', 'rider'];

// Old panel and app spellings of the same audiences.
const ALIASES = { user: 'customer', customers: 'customer', vendor: 'restaurant', store: 'restaurant', restaurants: 'restaurant', deliveryman: 'rider', delivery_man: 'rider', delivery: 'rider', riders: 'rider' };

export const MAX_QUESTION = 255;
export const MAX_ANSWER = 5000;

/**
 * An audience as stored: one of FAQ_AUDIENCES, or null for everyone ('',
 * 'all', null). Anything else is `undefined`, which callers treat as invalid.
 */
export function normalizeAudience(value) {
    if (value === null || value === undefined) return null;
    const text = String(value).trim().toLowerCase();
    if (!text || text === 'all' || text === 'everyone') return null;
    const audience = ALIASES[text] || text;
    return FAQ_AUDIENCES.includes(audience) ? audience : undefined;
}

const flag = (value) => value === true || value === 'true' || value === 1 || value === '1';

/** FAQ input, checked. `partial` for an edit: only the fields sent. */
export function readFaqInput(body = {}, { partial = false } = {}) {
    const data = {};
    if (!partial || body.question !== undefined) {
        const question = String(body.question ?? '').replace(/\s+/g, ' ').trim();
        if (!question) throw new ValidationError('Question is required');
        if (question.length > MAX_QUESTION) throw new ValidationError(`Question must be at most ${MAX_QUESTION} characters`);
        data.question = question;
    }
    if (!partial || body.answer !== undefined) {
        const answer = String(body.answer ?? '').trim();
        if (!answer) throw new ValidationError('Answer is required');
        if (answer.length > MAX_ANSWER) throw new ValidationError(`Answer must be at most ${MAX_ANSWER} characters`);
        data.answer = answer;
    }
    if (!partial || body.audience !== undefined) {
        const audience = normalizeAudience(body.audience);
        if (audience === undefined) throw new ValidationError('Audience must be customer, restaurant, rider or everyone');
        data.audience = audience;
    }
    if (body.isActive !== undefined) data.isActive = flag(body.isActive);
    else if (!partial) data.isActive = true;
    if (body.sortOrder !== undefined) {
        const order = Number(body.sortOrder);
        data.sortOrder = Number.isFinite(order) ? Math.max(0, Math.trunc(order)) : 0;
    }
    return data;
}

/** The ids of a reorder request, checked: every id once. */
export function readFaqOrder(body = {}) {
    const ids = Array.isArray(body?.ids) ? body.ids.map(String) : null;
    if (!ids || !ids.length) throw new ValidationError('Send the FAQ ids in their new order');
    if (new Set(ids).size !== ids.length) throw new ValidationError('An FAQ is listed twice');
    if (!ids.every((id) => /^[a-f0-9]{24}$/i.test(id))) throw new ValidationError('Invalid FAQ id');
    return ids;
}

const byOrder = (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || new Date(a.createdAt || 0) - new Date(b.createdAt || 0);

/**
 * What a public reader sees: active questions for that audience plus those
 * for everyone, in the admin's order. No audience: every active question.
 */
export function faqsForAudience(rows = [], audience = null) {
    return (rows || [])
        .filter((row) => row.isActive)
        .filter((row) => !audience || !row.audience || row.audience === audience)
        .sort(byOrder);
}

export const serializeFaq = (row) => ({
    id: row.id,
    question: row.question,
    answer: row.answer,
    audience: row.audience || null,
    isActive: row.isActive,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
});

export const publicFaq = ({ id, question, answer, audience }) => ({ id, question, answer, audience: audience || null });
