import crypto from 'crypto';
import nodemailer from 'nodemailer';
import { config } from '../config/env.js';
import { logger } from './logger.js';
import { composeEmail } from './emailTemplates.js';

/**
 * An email's subject and body from the stored template, falling back to the
 * built-in text if the template is missing, switched off or cannot be read.
 * `companyName` comes from Business Setup unless the caller gives one.
 * Sending must never fail because the template lookup did.
 */
export async function composeStoredEmail(key, values = {}) {
    let stored = null;
    let companyName = values.companyName;
    try {
        const { prisma } = await import('../config/prisma.js');
        const [template, business] = await Promise.all([
            prisma.foodEmailTemplate.findUnique({ where: { key } }),
            companyName ? null : prisma.foodBusinessSettings.findFirst({ select: { companyName: true } }),
        ]);
        stored = template;
        companyName = companyName || business?.companyName;
    } catch (error) {
        logger.warn(`Email template "${key}" not read, using the built-in text: ${error?.message || error}`);
    }
    return composeEmail(key, { ...values, companyName: companyName || 'Lagech' }, stored);
}

/**
 * SMTP settings in use: what an admin saved under 3rd Party > Mail Config,
 * else the server's EMAIL_* values. The transporter is rebuilt when they
 * change; the password only ever goes to nodemailer.
 */
let transporter = null;
let transporterFingerprint = '';

export function mailTransportOptions(mail) {
    const encryption = mail.encryption || (Number(mail.port) === 465 ? 'ssl' : 'tls');
    return {
        host: mail.host,
        port: Number(mail.port) || 587,
        secure: encryption === 'ssl',
        ...(encryption === 'none' ? { ignoreTLS: true } : {}),
        auth: { user: mail.username, pass: mail.password },
    };
}

async function getMailSettings() {
    const { getThirdPartySettings } = await import('../core/thirdParty/thirdParty.runtime.js');
    return getThirdPartySettings('mail');
}

export async function getTransporter() {
    const mail = await getMailSettings();
    if (!mail.enabled) {
        logger.warn('Email is switched off (3rd Party > Mail Config)');
        return { trans: null, mail };
    }
    if (!mail.host || !mail.username || !mail.password) {
        logger.warn('Email not configured: SMTP host, username and password required');
        return { trans: null, mail };
    }
    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify([mail.host, mail.port, mail.encryption, mail.username, mail.password]))
        .digest('hex');
    if (!transporter || fingerprint !== transporterFingerprint) {
        transporter = nodemailer.createTransport(mailTransportOptions(mail));
        transporterFingerprint = fingerprint;
    }
    return { trans: transporter, mail };
}

export const fromHeader = (mail) => {
    const from = mail.from || mail.username || config.emailFrom;
    return typeof from === 'string' && from.includes('<') ? from : `Lagech <${from}>`;
};

/**
 * A short test email to the address an admin typed, through the SMTP settings
 * in use. Returns { sent, reason }; the reason never contains the password.
 */
export async function sendTestEmail(to) {
    const { trans, mail } = await getTransporter();
    if (!trans) return { sent: false, reason: mail.enabled ? 'SMTP host, username and password are needed' : 'Email is switched off' };
    try {
        await trans.sendMail({
            from: fromHeader(mail),
            to,
            subject: 'Lagech test email',
            text: 'This is a test email from the Lagech admin panel. Your mail settings work.',
        });
        return { sent: true };
    } catch (err) {
        let reason = String(err?.message || 'Sending failed');
        if (mail.password) reason = reason.split(mail.password).join('••••');
        return { sent: false, reason: reason.slice(0, 300) };
    }
}

/**
 * Send OTP email for admin forgot password.
 * @param {string} to - Recipient email
 * @param {string} otp - 6-digit OTP
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
export async function sendAdminResetOtpEmail(to, otp) {
    const { trans, mail } = await getTransporter();
    if (!trans) {
        logger.warn('Admin OTP email skipped: SMTP not configured');
        return false;
    }
    // The admin's template when one is saved and switched on, else the
    // built-in wording (the text this email always had).
    const { subject, html, text } = await composeStoredEmail('admin_password_reset', {
        otp,
        validMinutes: 10,
    });

    try {
        await trans.sendMail({
            from: fromHeader(mail),
            to,
            subject,
            text,
            html
        });
        logger.info(`Admin reset OTP email sent to ${to}`);
        return true;
    } catch (err) {
        logger.error(`Failed to send admin OTP email to ${to}:`, err.message);
        return false;
    }
}
