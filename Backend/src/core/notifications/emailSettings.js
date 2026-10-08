import { EMAIL_TEMPLATES } from '../../utils/emailTemplates.js';

/**
 * Which transactional emails are sent and where admin emails go, stored as
 * one food_system_settings document. Pure: no database, no SMTP.
 */

export const EMAIL_SETTINGS_KEY = 'email_notifications';
export const MAX_ADMIN_RECIPIENTS = 10;
const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** A usable address, lower-cased, or null. */
export function cleanEmail(value) {
    const email = String(value ?? '').trim().toLowerCase();
    return email.length <= 254 && EMAIL.test(email) ? email : null;
}

/** Whether an admin may switch this email off (the reset code cannot be). */
export const isSwitchable = (key) => Boolean(EMAIL_TEMPLATES[key]) && EMAIL_TEMPLATES[key].canDisable !== false;

/**
 * The stored settings with every gap filled: a switch per email (default on;
 * customer emails still need the customer to have an address) and the admin
 * notification addresses (empty = the Business Info email).
 */
export function normalizeEmailSettings(value = {}) {
    const stored = value && typeof value === 'object' ? value : {};
    const saved = stored.switches && typeof stored.switches === 'object' ? stored.switches : {};
    const switches = {};
    for (const key of Object.keys(EMAIL_TEMPLATES)) {
        if (!isSwitchable(key)) continue;
        switches[key] = typeof saved[key] === 'boolean' ? saved[key] : EMAIL_TEMPLATES[key].defaultEnabled !== false;
    }
    const list = Array.isArray(stored.adminRecipients) ? stored.adminRecipients : [];
    const adminRecipients = [...new Set(list.map(cleanEmail).filter(Boolean))].slice(0, MAX_ADMIN_RECIPIENTS);
    return { switches, adminRecipients };
}
