import { prisma } from '../../../../config/prisma.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { EMAIL_TEMPLATES, composeEmail, unknownPlaceholders } from '../../../../utils/emailTemplates.js';

/**
 * The admin side of email templates. Only emails the backend sends are
 * listed (utils/emailTemplates.js); each shows the stored wording if there is
 * one, else the built-in wording it would fall back to.
 */

const known = (key) => {
    const template = EMAIL_TEMPLATES[key];
    if (!template) throw new NotFoundError('There is no such email');
    return template;
};

const serialize = (key, stored) => {
    const builtIn = EMAIL_TEMPLATES[key];
    return {
        key,
        name: builtIn.name,
        description: builtIn.description,
        placeholders: builtIn.placeholders,
        subject: stored?.subject ?? builtIn.subject,
        body: stored?.body ?? builtIn.body,
        isActive: stored ? stored.isActive : true,
        isCustomized: Boolean(stored),
        builtIn: { subject: builtIn.subject, body: builtIn.body },
        updatedAt: stored?.updatedAt || null,
    };
};

export async function listEmailTemplates() {
    const stored = await prisma.foodEmailTemplate.findMany({ where: { key: { in: Object.keys(EMAIL_TEMPLATES) } } });
    const byKey = new Map(stored.map((row) => [row.key, row]));
    return { templates: Object.keys(EMAIL_TEMPLATES).map((key) => serialize(key, byKey.get(key))) };
}

export async function getEmailTemplate(key) {
    known(key);
    return serialize(key, await prisma.foodEmailTemplate.findUnique({ where: { key } }));
}

/** Subject and body checked: present, sane length, only known placeholders. */
export function readTemplateBody(key, body = {}) {
    known(key);
    const subject = String(body.subject ?? '').trim();
    const html = String(body.body ?? '').trim();
    if (!subject) throw new ValidationError('Subject is required');
    if (subject.length > 200) throw new ValidationError('Subject is too long');
    if (!html) throw new ValidationError('Body is required');
    if (html.length > 50000) throw new ValidationError('Body is too long');
    const unknown = unknownPlaceholders(key, subject, html);
    if (unknown.length) {
        throw new ValidationError(`This email cannot fill ${unknown.map((name) => `{{${name}}}`).join(', ')}`);
    }
    return { subject, body: html, isActive: body.isActive === undefined ? true : body.isActive === true || body.isActive === 'true' };
}

export async function saveEmailTemplate(key, body = {}, adminId = null) {
    const data = { ...readTemplateBody(key, body), updatedBy: adminId ? String(adminId) : null };
    const row = await prisma.foodEmailTemplate.upsert({ where: { key }, create: { key, ...data }, update: data });
    return serialize(key, row);
}

/** Back to the built-in wording. */
export async function resetEmailTemplate(key) {
    known(key);
    await prisma.foodEmailTemplate.deleteMany({ where: { key } });
    return serialize(key, null);
}

/**
 * What the email would look like with the given subject, body and values.
 * Rendering is the same function sending uses.
 */
export function previewEmailTemplate(key, body = {}) {
    const { subject, body: html } = readTemplateBody(key, { ...body, isActive: true });
    const values = body.values && typeof body.values === 'object' ? body.values : {};
    const filled = Object.fromEntries(
        known(key).placeholders.map((p) => [p.key, String(values[p.key] ?? `[${p.key}]`)]),
    );
    const { subject: renderedSubject, html: renderedHtml, text } = composeEmail(key, filled, { subject, body: html, isActive: true });
    return { subject: renderedSubject, html: renderedHtml, text };
}
