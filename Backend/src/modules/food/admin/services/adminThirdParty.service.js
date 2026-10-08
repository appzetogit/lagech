import crypto from 'crypto';
import { prisma } from '../../../../config/prisma.js';
import { config } from '../../../../config/env.js';
import { ValidationError } from '../../../../core/auth/errors.js';
import {
    AREA_KEYS,
    getArea,
    describeArea,
    applySave,
    applyImport,
    storeKey,
} from '../../../../core/thirdParty/thirdParty.catalog.js';
import {
    getThirdPartySettings,
    invalidateThirdPartySettings,
    primeThirdPartySettings,
} from '../../../../core/thirdParty/thirdParty.runtime.js';
import { sendOtpSms } from '../../../../core/thirdParty/sms.js';
import { sendTestEmail } from '../../../../utils/email.js';

/**
 * The admin side of 3rd Party settings: read (secrets masked), save, import
 * what the server uses today, test sends, and the audit trail.
 *
 * Every write is audit-logged with the admin and the field names, never the
 * values. Nothing here logs a value, and nothing here is reachable from a
 * public route.
 */

const readDoc = async (area) =>
    (await prisma.foodSystemSetting.findUnique({ where: { key: storeKey(area) } })) || null;

async function adminLabel(adminId) {
    if (!adminId) return '';
    const admin = await prisma.foodAdmin.findUnique({ where: { id: String(adminId) }, select: { email: true } }).catch(() => null);
    return admin?.email || '';
}

export async function audit(area, action, fields, adminId) {
    await prisma.foodSettingsAuditLog.create({
        data: {
            area: storeKey(area),
            action,
            fields: (fields || []).map(String),
            adminId: adminId ? String(adminId) : null,
            adminEmail: await adminLabel(adminId),
        },
    });
}

const view = (area, row) => ({
    ...describeArea(area, row?.value || null, config),
    savedAt: row?.updatedAt || null,
});

/** One area as the admin page shows it. */
export async function getThirdPartyArea(area) {
    getArea(area);
    return view(area, await readDoc(area));
}

/** Every area, for the page's first load. */
export async function getAllThirdPartyAreas() {
    const rows = await prisma.foodSystemSetting.findMany({ where: { key: { in: AREA_KEYS.map(storeKey) } } });
    const byKey = new Map(rows.map((row) => [row.key, row]));
    return { areas: AREA_KEYS.map((area) => view(area, byKey.get(storeKey(area)))) };
}

async function writeDoc(area, doc, adminId) {
    const row = await prisma.foodSystemSetting.upsert({
        where: { key: storeKey(area) },
        create: { key: storeKey(area), value: doc, updatedBy: adminId ? String(adminId) : null },
        update: { value: doc, updatedBy: adminId ? String(adminId) : null },
    });
    invalidateThirdPartySettings(area);
    primeThirdPartySettings(area, doc);
    return row;
}

/** Saves what the admin changed. Body: { values: {field: value}, clear: [field] }. */
export async function saveThirdPartyArea(area, body = {}, adminId = null) {
    getArea(area);
    const row = await readDoc(area);
    const { doc, changed } = applySave(area, row?.value || null, body, config);
    if (!changed.length) return { ...view(area, row), changed };
    const saved = await writeDoc(area, doc, adminId);
    await audit(area, 'save', changed, adminId);
    return { ...view(area, saved), changed };
}

/**
 * Copies what the server uses today into the saved settings, on the server:
 * the secrets go from the environment straight into encrypted storage and
 * never through the browser. Leaves fields the admin saved unless
 * `overwrite` is true. Running it twice imports nothing the second time.
 */
export async function importThirdPartyArea(area, { overwrite = false } = {}, adminId = null) {
    getArea(area);
    const row = await readDoc(area);
    const { doc, imported, skipped } = applyImport(area, row?.value || null, { overwrite: overwrite === true }, config);
    if (!imported.length) return { ...view(area, row), imported, skipped };
    const saved = await writeDoc(area, doc, adminId);
    await audit(area, overwrite === true ? 'import_overwrite' : 'import', imported, adminId);
    return { ...view(area, saved), imported, skipped };
}

export async function importAllThirdPartyAreas(options = {}, adminId = null) {
    const results = [];
    for (const area of AREA_KEYS) results.push(await importThirdPartyArea(area, options, adminId));
    return { areas: results };
}

/** Recent changes, newest first. */
export async function listThirdPartyAudit({ limit = 30 } = {}) {
    const take = Math.min(Math.max(Number(limit) || 30, 1), 100);
    const rows = await prisma.foodSettingsAuditLog.findMany({
        where: { area: { startsWith: 'third_party.' } },
        orderBy: { createdAt: 'desc' },
        take,
    });
    return {
        entries: rows.map((row) => ({
            id: row.id,
            area: row.area.replace(/^third_party\./, ''),
            action: row.action,
            fields: row.fields,
            adminEmail: row.adminEmail,
            createdAt: row.createdAt,
        })),
    };
}

// ─── Test sends ──────────────────────────────────────────────────────────────

export const cleanTestPhone = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    const local = digits.length === 12 && digits.startsWith('91') ? digits.slice(2) : digits;
    if (!/^[6-9]\d{9}$/.test(local)) throw new ValidationError('Enter a 10-digit Indian mobile number');
    return local;
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Sends one SMS through the saved settings, with a random code in the OTP
 * template (the only text the DLT registration allows). Sent even when logins
 * use the fixed test OTP, since the admin asked for it; the reply says so.
 */
export async function sendThirdPartyTestSms(body = {}, adminId = null, { fetchImpl } = {}) {
    const phone = cleanTestPhone(body.phone);
    const settings = await getThirdPartySettings('sms');
    const code = String(crypto.randomInt(1000, 10000));
    const result = await sendOtpSms(settings, phone, code, fetchImpl ? { fetchImpl } : undefined);
    await audit('sms', result.ok ? 'test_sent' : 'test_failed', [], adminId);
    return {
        sent: result.ok,
        reason: result.ok ? null : result.reason,
        reply: result.reply || '',
        fixedOtpMode: config.useDefaultOtp,
    };
}

export async function sendThirdPartyTestEmail(body = {}, adminId = null) {
    const to = String(body.email || '').trim().slice(0, 200);
    if (!EMAIL.test(to)) throw new ValidationError('Enter a valid email address');
    const result = await sendTestEmail(to);
    await audit('mail', result.sent ? 'test_sent' : 'test_failed', [], adminId);
    return { sent: result.sent, reason: result.sent ? null : result.reason };
}
