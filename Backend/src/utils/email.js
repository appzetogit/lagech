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

let transporter = null;

function getTransporter() {
    if (transporter) return transporter;
    const { emailHost, emailPort, emailUser, emailPass } = config;
    if (!emailHost || !emailUser || !emailPass) {
        logger.warn('Email not configured: EMAIL_HOST, EMAIL_USER, EMAIL_PASS required');
        return null;
    }
    transporter = nodemailer.createTransport({
        host: emailHost,
        port: emailPort || 587,
        secure: emailPort === 465,
        auth: {
            user: emailUser,
            pass: emailPass
        }
    });
    return transporter;
}

/**
 * Send OTP email for admin forgot password.
 * @param {string} to - Recipient email
 * @param {string} otp - 6-digit OTP
 * @returns {Promise<boolean>} true if sent, false if skipped/failed
 */
export async function sendAdminResetOtpEmail(to, otp) {
    const trans = getTransporter();
    if (!trans) {
        logger.warn('Admin OTP email skipped: SMTP not configured');
        return false;
    }
    const from = config.emailFrom || config.emailUser;
    // The admin's template when one is saved and switched on, else the
    // built-in wording (the text this email always had).
    const { subject, html, text } = await composeStoredEmail('admin_password_reset', {
        otp,
        validMinutes: 10,
    });

    try {
        await trans.sendMail({
            from: typeof from === 'string' && from.includes('<') ? from : `Lagech <${from}>`,
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
