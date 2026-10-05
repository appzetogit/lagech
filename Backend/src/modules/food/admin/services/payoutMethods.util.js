import { ValidationError } from '../../../../core/auth/errors.js';

/**
 * Payout method types and the values a payee fills in for one.
 *
 * Pure, so the rules -- what a field may be called, what a required or email
 * field accepts -- are tested without a database. withdrawalMethods.service.js
 * is the only writer.
 */

export const FIELD_TYPES = ['text', 'number', 'email'];
export const PAYEE_TYPES = ['restaurant', 'rider'];

const MAX_FIELDS = 20;
const MAX_VALUE = 200;

/** "Account holder name" -> "account_holder_name". */
export const fieldKeyFrom = (value) =>
    String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 40);

/** "account_holder_name" -> "Account holder name". */
export const labelFromKey = (value) => {
    const words = String(value ?? '').replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : '';
};

const isTrue = (value) => value === true || value === 'true' || value === 1 || value === '1';

/**
 * The field list an admin saved, cleaned: every field has a label, a type the
 * apps know how to render, and a key unique within the method. The key is
 * what a payee's values are stored under, so it is kept when one is given --
 * renaming a label must not orphan what payees already entered.
 */
export function normalizeMethodFields(raw) {
    if (!Array.isArray(raw) || !raw.length) throw new ValidationError('Add at least one field');
    if (raw.length > MAX_FIELDS) throw new ValidationError(`A method can have at most ${MAX_FIELDS} fields`);

    const seen = new Set();
    return raw.map((field, index) => {
        const label = String(field?.label ?? '').trim().slice(0, 80);
        if (!label) throw new ValidationError(`Field ${index + 1} needs a label`);

        const type = String(field?.type || 'text').toLowerCase();
        if (!FIELD_TYPES.includes(type)) {
            throw new ValidationError(`"${label}" has an unknown type; use text, number or email`);
        }

        const key = fieldKeyFrom(field?.key || label) || `field_${index + 1}`;
        if (seen.has(key)) {
            throw new ValidationError(`Two fields would both be stored as "${key}"; give them different labels`);
        }
        seen.add(key);

        return {
            key,
            label,
            type,
            required: isTrue(field?.required),
            placeholder: String(field?.placeholder ?? '').trim().slice(0, 120),
        };
    });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Account numbers and the like are digits that must keep their leading zeros,
// so a number field is checked as text and stored as text.
const NUMBER = /^\d+(\.\d+)?$/;

/**
 * What a payee entered for a method's fields, checked against them. Unknown
 * keys are dropped; blanks are dropped unless the field is required, in which
 * case every problem is reported together.
 */
export function validatePayoutValues(fields = [], values = {}) {
    const input = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const clean = {};
    const problems = [];

    for (const field of fields) {
        const value = String(input[field.key] ?? '').trim();
        if (!value) {
            if (field.required) problems.push(`${field.label} is required`);
            continue;
        }
        if (value.length > MAX_VALUE) {
            problems.push(`${field.label} is too long`);
            continue;
        }
        if (field.type === 'number' && !NUMBER.test(value)) {
            problems.push(`${field.label} must be a number`);
            continue;
        }
        if (field.type === 'email' && !EMAIL.test(value)) {
            problems.push(`${field.label} must be an email address`);
            continue;
        }
        clean[field.key] = value;
    }

    if (problems.length) throw new ValidationError(problems.join('. '));
    return clean;
}

/**
 * What the admin pays to, frozen at the time of a payout: the method's name
 * and each field's label with the value entered. Stored on the withdrawal so a
 * later edit by the payee does not change where a past payment went.
 */
export function payoutSnapshot(method, values = {}) {
    if (!method) return null;
    const fields = Array.isArray(method.fields) ? method.fields : [];
    return {
        methodId: method.id,
        methodName: method.name,
        fields: fields
            .filter((field) => values?.[field.key])
            .map((field) => ({ key: field.key, label: field.label, value: String(values[field.key]) })),
    };
}

/**
 * One legacy (6amMart) `withdrawal_methods.method_fields` entry:
 * { input_type, input_name, placeholder, is_required }.
 */
export function fieldFromLegacy(entry = {}) {
    const rawType = String(entry.input_type || 'text').toLowerCase();
    // A phone number may carry "+" and spaces, so it stays text.
    const type = rawType === 'number' ? 'number' : rawType === 'email' ? 'email' : 'text';
    const key = fieldKeyFrom(entry.input_name);
    return {
        key,
        label: labelFromKey(entry.input_name) || key,
        type,
        required: isTrue(entry.is_required),
        placeholder: String(entry.placeholder ?? '').trim().slice(0, 120),
    };
}
