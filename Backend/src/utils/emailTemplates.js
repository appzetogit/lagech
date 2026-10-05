/**
 * The emails this backend actually sends, their placeholders and their
 * built-in wording, plus the {{placeholder}} renderer.
 *
 * Pure: no database, no SMTP. The admin can override a template's subject and
 * body (food_email_templates); a missing or switched-off override means the
 * built-in text below is sent, which is the text the email had before
 * templates existed.
 *
 * Adding an email to the system means adding it here too -- the admin page
 * lists exactly these, so it can never offer a template nothing sends.
 */

export const EMAIL_TEMPLATES = {
    admin_password_reset: {
        name: 'Admin password reset code',
        description: 'Sent when an admin asks for a password reset code from the login page.',
        placeholders: [
            { key: 'otp', description: 'The 6-digit reset code' },
            { key: 'validMinutes', description: 'How many minutes the code works for' },
            { key: 'companyName', description: 'Company name from Business Setup' },
        ],
        subject: 'Your password reset code – {{companyName}} Admin',
        body: `<h2 style="color: #111;">Password reset code</h2>
<p>Use the code below to reset your admin password. It is valid for {{validMinutes}} minutes.</p>
<p style="font-size: 24px; font-weight: bold; letter-spacing: 4px; background: #f5f5f5; padding: 12px 16px; border-radius: 8px;">{{otp}}</p>
<p style="color: #666; font-size: 14px;">If you did not request this, you can ignore this email.</p>
<hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
<p style="color: #999; font-size: 12px;">{{companyName}} Admin</p>`,
    },
};

const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

const escapeHtml = (value) =>
    String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

/**
 * Fill {{placeholders}}. Values are HTML-escaped unless `html` is false (the
 * subject line is plain text). An unknown placeholder renders as nothing
 * rather than leaking braces into a customer's inbox.
 */
export function renderTemplate(template, values = {}, { html = true } = {}) {
    return String(template ?? '').replace(PLACEHOLDER, (_, key) => {
        const value = Object.prototype.hasOwnProperty.call(values, key) ? values[key] : '';
        return html ? escapeHtml(value) : String(value ?? '').replace(/[\r\n]+/g, ' ');
    });
}

/** Placeholder names used in a template, in order, without repeats. */
export function placeholdersIn(template) {
    const found = [];
    for (const match of String(template ?? '').matchAll(PLACEHOLDER)) {
        if (!found.includes(match[1])) found.push(match[1]);
    }
    return found;
}

/** Placeholders a template uses that its email does not supply. */
export function unknownPlaceholders(key, ...templates) {
    const known = new Set((EMAIL_TEMPLATES[key]?.placeholders || []).map((p) => p.key));
    return [...new Set(templates.flatMap(placeholdersIn))].filter((name) => !known.has(name));
}

/** A plain-text part from an HTML body, for mail clients that want one. */
export function htmlToText(html) {
    return String(html ?? '')
        .replace(/<\s*br\s*\/?>/gi, '\n')
        .replace(/<\/(p|h[1-6]|div|li|tr)>/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, '&')
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** The full HTML document an email body is sent in. */
export function wrapEmailHtml(body) {
    return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"></head>
<body style="font-family: Arial, sans-serif; line-height: 1.6; color: #333; max-width: 480px; margin: 0 auto; padding: 20px;">
${body}
</body>
</html>`;
}

/**
 * Subject, HTML and text for one email: the stored override when there is an
 * active one, otherwise the built-in wording.
 */
export function composeEmail(key, values = {}, stored = null) {
    const builtIn = EMAIL_TEMPLATES[key];
    if (!builtIn) throw new Error(`Unknown email template "${key}"`);
    const useStored = Boolean(stored && stored.isActive !== false && stored.subject && stored.body);
    const subjectTemplate = useStored ? stored.subject : builtIn.subject;
    const bodyTemplate = useStored ? stored.body : builtIn.body;
    const body = renderTemplate(bodyTemplate, values, { html: true });
    return {
        subject: renderTemplate(subjectTemplate, values, { html: false }),
        html: wrapEmailHtml(body),
        text: htmlToText(body),
        source: useStored ? 'stored' : 'built_in',
    };
}
