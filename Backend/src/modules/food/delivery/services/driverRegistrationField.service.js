import { prisma } from '../../../../config/prisma.js';
import { isId } from '../../../../utils/helpers.js';
import { ValidationError } from '../../../../core/auth/errors.js';

const FIELD_TYPES = ['text', 'number', 'email', 'phone', 'date', 'select', 'document'];
const KEY_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,49}$/;

const clean = (v) => String(v ?? '').trim();

const serialize = (f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    required: !!f.required,
    page: f.page,
    order: f.order,
    options: f.options || [],
    placeholder: f.placeholder || '',
    helpText: f.helpText || '',
    regex: f.regex || '',
    minLength: f.minLength ?? null,
    maxLength: f.maxLength ?? null,
    isSystem: !!f.isSystem,
    isActive: !!f.isActive
});

const BY_FORM_ORDER = [{ page: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }];

// ───────────────────────── Admin CRUD ─────────────────────────

export async function listFields() {
    const docs = await prisma.foodDriverRegistrationField.findMany({ orderBy: BY_FORM_ORDER });
    return { fields: docs.map(serialize) };
}

export async function createField(body = {}) {
    const key = clean(body.key);
    if (!KEY_RE.test(key)) {
        throw new ValidationError('key must start with a letter and contain only letters, numbers, underscore');
    }
    const type = FIELD_TYPES.includes(body.type) ? body.type : 'text';
    const label = clean(body.label);
    if (!label) throw new ValidationError('label is required');

    const exists = await prisma.foodDriverRegistrationField.findUnique({ where: { key } });
    if (exists) throw new ValidationError('A field with this key already exists');

    const doc = await prisma.foodDriverRegistrationField.create({
        data: {
            key,
            label,
            type,
            required: body.required === true || body.required === 'true',
            page: Math.max(1, parseInt(body.page, 10) || 1),
            order: parseInt(body.order, 10) || 0,
            options: Array.isArray(body.options) ? body.options.map(clean).filter(Boolean) : [],
            placeholder: clean(body.placeholder),
            helpText: clean(body.helpText),
            regex: clean(body.regex),
            minLength: body.minLength != null && body.minLength !== '' ? Number(body.minLength) : null,
            maxLength: body.maxLength != null && body.maxLength !== '' ? Number(body.maxLength) : null,
            isActive: body.isActive !== false && body.isActive !== 'false'
        }
    });
    return serialize(doc);
}

export async function updateField(id, body = {}) {
    if (!isId(id)) throw new ValidationError('Invalid field id');
    const doc = await prisma.foodDriverRegistrationField.findUnique({ where: { id: String(id) } });
    if (!doc) throw new ValidationError('Field not found');

    // key is immutable — app answers are stored under it.
    const data = {};
    if (body.label !== undefined) data.label = clean(body.label) || doc.label;
    if (body.type !== undefined && FIELD_TYPES.includes(body.type)) data.type = body.type;
    if (body.required !== undefined) data.required = body.required === true || body.required === 'true';
    if (body.page !== undefined) data.page = Math.max(1, parseInt(body.page, 10) || 1);
    if (body.order !== undefined) data.order = parseInt(body.order, 10) || 0;
    if (body.options !== undefined) {
        data.options = Array.isArray(body.options) ? body.options.map(clean).filter(Boolean) : [];
    }
    if (body.placeholder !== undefined) data.placeholder = clean(body.placeholder);
    if (body.helpText !== undefined) data.helpText = clean(body.helpText);
    if (body.regex !== undefined) data.regex = clean(body.regex);
    if (body.minLength !== undefined) {
        data.minLength = body.minLength === '' || body.minLength == null ? null : Number(body.minLength);
    }
    if (body.maxLength !== undefined) {
        data.maxLength = body.maxLength === '' || body.maxLength == null ? null : Number(body.maxLength);
    }
    if (body.isActive !== undefined) data.isActive = body.isActive === true || body.isActive === 'true';

    const updated = await prisma.foodDriverRegistrationField.update({ where: { id: doc.id }, data });
    return serialize(updated);
}

export async function deleteField(id) {
    if (!isId(id)) throw new ValidationError('Invalid field id');
    const doc = await prisma.foodDriverRegistrationField.findUnique({ where: { id: String(id) } });
    if (!doc) throw new ValidationError('Field not found');
    if (doc.isSystem) throw new ValidationError('System fields cannot be deleted; deactivate instead');

    await prisma.foodDriverRegistrationField.delete({ where: { id: doc.id } });
    return { deleted: true, id: doc.id };
}

// ───────────────────────── Public (app) ─────────────────────────

/** Active fields grouped by page — what the Flutter form renders. */
export async function getPublicFormSchema() {
    const docs = await prisma.foodDriverRegistrationField.findMany({
        where: { isActive: true },
        orderBy: BY_FORM_ORDER
    });

    const byPage = new Map();
    for (const d of docs) {
        const p = d.page || 1;
        if (!byPage.has(p)) byPage.set(p, []);
        byPage.get(p).push(serialize(d));
    }
    const pages = [...byPage.keys()].sort((a, b) => a - b).map((page) => ({
        page,
        fields: byPage.get(page)
    }));

    return { totalPages: pages.length, pages, fields: docs.map(serialize) };
}

// ─────────────── Registration: validate + collect answers ───────────────

/**
 * Validate the dynamic (admin-defined) answers against the active schema.
 * Returns { customFields, documentKeys } — the caller uploads the document files
 * and merges the resulting URLs into customDocuments.
 *
 * @param body     the registration request body (contains non-file answers)
 * @param fileKeys Set of fieldnames present in the uploaded files
 */
export async function collectDynamicRegistration(body = {}, fileKeys = new Set()) {
    const fields = await prisma.foodDriverRegistrationField.findMany({ where: { isActive: true } });
    const customFields = {};

    for (const f of fields) {
        if (f.type === 'document') {
            if (f.required && !fileKeys.has(f.key)) {
                throw new ValidationError(`${f.label} document is required`);
            }
            continue;
        }

        const raw = body[f.key];
        const val = raw == null ? '' : String(raw).trim();

        if (f.required && !val) throw new ValidationError(`${f.label} is required`);
        if (!val) continue;

        if (f.minLength != null && val.length < f.minLength) {
            throw new ValidationError(`${f.label} must be at least ${f.minLength} characters`);
        }
        if (f.maxLength != null && val.length > f.maxLength) {
            throw new ValidationError(`${f.label} must be at most ${f.maxLength} characters`);
        }
        if (f.type === 'select' && Array.isArray(f.options) && f.options.length && !f.options.includes(val)) {
            throw new ValidationError(`${f.label} must be one of: ${f.options.join(', ')}`);
        }
        if (f.regex) {
            try {
                if (!new RegExp(f.regex).test(val)) throw new ValidationError(`${f.label} is invalid`);
            } catch (e) {
                if (e instanceof ValidationError) throw e;
                // ignore a malformed admin regex rather than blocking registration
            }
        }
        customFields[f.key] = val;
    }

    // keys of all document fields the app may send (so the caller knows which files to upload)
    const allDocumentKeys = fields.filter((f) => f.type === 'document').map((f) => f.key);
    return { customFields, documentKeys: allDocumentKeys };
}
