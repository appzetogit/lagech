import { prisma } from '../../config/prisma.js';
import { logger } from '../../utils/logger.js';
import { EMAIL_TEMPLATES } from '../../utils/emailTemplates.js';
import { composeStoredEmail, getTransporter, fromHeader } from '../../utils/email.js';
import { EMAIL_SETTINGS_KEY, cleanEmail, isSwitchable, normalizeEmailSettings } from './emailSettings.js';

/**
 * Transactional emails (registration decisions, withdrawals, refunds, orders,
 * wallet credits, suspensions), sent after the action that caused them has
 * been written.
 *
 * Rules every caller relies on:
 *  - queueEmail() returns at once and never throws. The work runs on a later
 *    tick; nothing it does can block, slow or fail the caller's action.
 *  - Nothing is sent when Mail Config is off or incomplete, when the email is
 *    switched off on Email Templates, or when there is no valid recipient.
 *  - Each event is sent once: its eventKey is claimed in food_email_send_logs
 *    (unique) before sending. A retry, a double click or a second server finds
 *    the key taken. A failed send may be claimed again, up to MAX_ATTEMPTS.
 *  - Logs carry the template, event and reason, never SMTP credentials.
 *
 * Tests: nothing runs under `node --test` unless a fake transport has been
 * installed with setEmailTransportForTests(), so the suite can never send a
 * real email or leave queries behind after it disconnects.
 */

export { EMAIL_SETTINGS_KEY, cleanEmail, isSwitchable, normalizeEmailSettings };
export const MAX_ATTEMPTS = 3;

let testTransport = null;
const inflight = new Set();

/** Install (or with null, remove) a fake { sendMail } for tests. */
export function setEmailTransportForTests(transport) {
    testTransport = transport || null;
}

/** Resolves when every queued email has finished (tests). */
export async function flushEmails() {
    while (inflight.size) await Promise.allSettled([...inflight]);
}

export async function readEmailSettings(db = prisma) {
    const row = await db.foodSystemSetting.findUnique({ where: { key: EMAIL_SETTINGS_KEY } });
    return normalizeEmailSettings(row?.value);
}

/** Where admin emails go: the configured list, else the Business Info email. */
export async function adminRecipients(settings) {
    if (settings.adminRecipients.length) return settings.adminRecipients;
    const business = await prisma.foodBusinessSettings.findFirst({ select: { email: true } });
    const fallback = cleanEmail(business?.email);
    return fallback ? [fallback] : [];
}

async function mailTransport() {
    if (testTransport) return { trans: testTransport, mail: {} };
    const { getThirdPartySettings } = await import('../thirdParty/thirdParty.runtime.js');
    const mail = await getThirdPartySettings('mail');
    if (!mail.enabled || !mail.host || !mail.username || !mail.password) return { trans: null, mail };
    return getTransporter();
}

/** Error text safe to store and log: no password, bounded. */
const safeError = (err, mail) => {
    let text = String(err?.code ? `${err.code}: ${err.message || ''}` : err?.message || err || 'Sending failed');
    if (mail?.password) text = text.split(mail.password).join('••••');
    return text.slice(0, 300);
};

/**
 * Claim an event. Returns true for the caller that should send it: a new key,
 * or one whose earlier attempt failed and has attempts left.
 */
async function claim(eventKey, templateKey, recipient) {
    const rows = await prisma.$queryRaw`
        INSERT INTO "food_email_send_logs" ("eventKey", "templateKey", "recipient", "status", "attempts")
        VALUES (${eventKey}, ${templateKey}, ${recipient}, 'sending', 1)
        ON CONFLICT ("eventKey") DO UPDATE
            SET "status" = 'sending', "attempts" = "food_email_send_logs"."attempts" + 1,
                "recipient" = EXCLUDED."recipient", "updatedAt" = CURRENT_TIMESTAMP
            WHERE "food_email_send_logs"."status" = 'failed'
              AND "food_email_send_logs"."attempts" < ${MAX_ATTEMPTS}
        RETURNING "id"`;
    return rows.length > 0;
}

const finish = (eventKey, status, error = '') =>
    prisma.foodEmailSendLog.update({ where: { eventKey }, data: { status, error } });

/**
 * Send one event email now. Returns what happened ('sent', 'duplicate',
 * 'failed' or 'skipped:<why>'); throws nothing a caller has to handle.
 */
export async function deliverEmail({ template, eventKey, to, values = {} }) {
    if (!EMAIL_TEMPLATES[template]) return 'skipped:unknown_template';
    if (!eventKey) return 'skipped:no_event_key';

    const settings = await readEmailSettings();
    if (isSwitchable(template) && settings.switches[template] === false) return 'skipped:switched_off';

    const recipients = to === 'admins'
        ? await adminRecipients(settings)
        : [cleanEmail(to)].filter(Boolean);
    if (!recipients.length) return 'skipped:no_recipient';

    const { trans, mail } = await mailTransport();
    if (!trans) return 'skipped:mail_off';

    const key = String(eventKey).slice(0, 191);
    if (!(await claim(key, template, recipients.join(',')))) return 'duplicate';

    try {
        const { subject, html, text } = await composeStoredEmail(template, values);
        await trans.sendMail({ from: fromHeader(mail), to: recipients.join(', '), subject, html, text });
        await finish(key, 'sent');
        return 'sent';
    } catch (err) {
        const reason = safeError(err, mail);
        logger.warn(`Email "${template}" (${key}) not sent: ${reason}`);
        await finish(key, 'failed', reason).catch(() => {});
        return 'failed';
    }
}

/**
 * Fire and forget. `job` is the email ({ template, eventKey, to, values }) or
 * an async function that builds it (or an array of them, or null to send
 * nothing) -- the function form lets a hook do its lookups off the caller's
 * path. Call it after the action's transaction has committed.
 */
export function queueEmail(job) {
    if (process.env.NODE_TEST_CONTEXT && !testTransport) return;
    const run = (async () => {
        await new Promise((resolve) => setImmediate(resolve));
        const built = typeof job === 'function' ? await job() : job;
        const jobs = (Array.isArray(built) ? built : [built]).filter(Boolean);
        for (const one of jobs) {
            const outcome = await deliverEmail(one).catch((err) => {
                logger.warn(`Email "${one?.template}" (${one?.eventKey}) not sent: ${String(err?.message || err).slice(0, 300)}`);
                return 'failed';
            });
            if (outcome === 'sent') logger.info(`Email "${one.template}" sent (${one.eventKey})`);
        }
    })().catch((err) => {
        logger.warn(`Email job failed: ${String(err?.message || err).slice(0, 300)}`);
    });
    inflight.add(run);
    run.finally(() => inflight.delete(run));
}
