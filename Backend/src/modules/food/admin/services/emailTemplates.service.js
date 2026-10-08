import { prisma } from '../../../../config/prisma.js';
import { ValidationError, NotFoundError } from '../../../../core/auth/errors.js';
import { EMAIL_TEMPLATES, composeEmail, unknownPlaceholders } from '../../../../utils/emailTemplates.js';
import {
    EMAIL_SETTINGS_KEY,
    cleanEmail,
    isSwitchable,
    normalizeEmailSettings,
    readEmailSettings,
} from '../../../../core/notifications/transactionalEmail.js';

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

const serialize = (key, stored, settings = null) => {
    const builtIn = EMAIL_TEMPLATES[key];
    return {
        key,
        name: builtIn.name,
        description: builtIn.description,
        audience: builtIn.audience || [],
        // Whether the email goes out at all (Email Templates switch); separate
        // from isActive, which picks the custom wording over the built-in one.
        canDisable: isSwitchable(key),
        sendEnabled: isSwitchable(key) ? (settings ? settings.switches[key] !== false : true) : true,
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
    const [stored, settings] = await Promise.all([
        prisma.foodEmailTemplate.findMany({ where: { key: { in: Object.keys(EMAIL_TEMPLATES) } } }),
        readEmailSettings(),
    ]);
    const byKey = new Map(stored.map((row) => [row.key, row]));
    return {
        templates: Object.keys(EMAIL_TEMPLATES).map((key) => serialize(key, byKey.get(key), settings)),
        settings: await serializeSettings(settings),
    };
}

export async function getEmailTemplate(key) {
    known(key);
    const [stored, settings] = await Promise.all([prisma.foodEmailTemplate.findUnique({ where: { key } }), readEmailSettings()]);
    return serialize(key, stored, settings);
}

// ─── Sending switches and admin addresses ────────────────────────────────────

const serializeSettings = async (settings) => {
    const business = await prisma.foodBusinessSettings.findFirst({ select: { email: true } });
    return {
        switches: settings.switches,
        adminRecipients: settings.adminRecipients,
        // Where admin emails go while the list is empty.
        businessEmail: cleanEmail(business?.email) || '',
    };
};

export async function getEmailSettings() {
    return serializeSettings(await readEmailSettings());
}

/**
 * Save which emails are sent and the admin notification addresses. Only the
 * fields given change; an address that is not one is refused, not dropped.
 */
export async function saveEmailSettings(body = {}, adminId = null) {
    const current = await readEmailSettings();
    const next = { switches: { ...current.switches }, adminRecipients: current.adminRecipients };

    if (body.switches !== undefined) {
        if (!body.switches || typeof body.switches !== 'object') throw new ValidationError('switches must be an object');
        for (const [key, value] of Object.entries(body.switches)) {
            if (!EMAIL_TEMPLATES[key]) throw new ValidationError(`There is no email "${key}"`);
            if (!isSwitchable(key)) throw new ValidationError(`${EMAIL_TEMPLATES[key].name} cannot be switched off`);
            if (typeof value !== 'boolean') throw new ValidationError('Each switch must be true or false');
            next.switches[key] = value;
        }
    }
    if (body.adminRecipients !== undefined) {
        const raw = Array.isArray(body.adminRecipients)
            ? body.adminRecipients
            : String(body.adminRecipients ?? '').split(/[\s,;]+/);
        const list = raw.map((v) => String(v ?? '').trim()).filter(Boolean);
        const bad = list.find((v) => !cleanEmail(v));
        if (bad) throw new ValidationError(`"${bad.slice(0, 80)}" is not an email address`);
        if (list.length > 10) throw new ValidationError('At most 10 admin addresses');
        next.adminRecipients = list;
    }

    const value = normalizeEmailSettings(next);
    await prisma.foodSystemSetting.upsert({
        where: { key: EMAIL_SETTINGS_KEY },
        create: { key: EMAIL_SETTINGS_KEY, value, updatedBy: adminId ? String(adminId) : null },
        update: { value, updatedBy: adminId ? String(adminId) : null },
    });
    return serializeSettings(value);
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
    return serialize(key, row, await readEmailSettings());
}

/** Back to the built-in wording. */
export async function resetEmailTemplate(key) {
    known(key);
    await prisma.foodEmailTemplate.deleteMany({ where: { key } });
    return serialize(key, null, await readEmailSettings());
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
