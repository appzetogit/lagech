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
        audience: ['admin'],
        // A locked-out admin's only way back in; not switchable.
        canDisable: false,
    },
    ...transactionalTemplates(),
};

/** Common footer and placeholder descriptions for the event emails. */
function transactionalTemplates() {
    const P = {
        companyName: { key: 'companyName', description: 'Company name from Business Setup' },
        userName: { key: 'userName', description: 'Name of the person the email is to' },
        restaurantName: { key: 'restaurantName', description: 'Restaurant name' },
        ownerName: { key: 'ownerName', description: 'Restaurant owner name' },
        phone: { key: 'phone', description: 'Phone number given at sign-up' },
        email: { key: 'email', description: 'Email given at sign-up' },
        riderName: { key: 'riderName', description: 'Delivery partner name' },
        orderId: { key: 'orderId', description: 'Order number the customer sees' },
        amount: { key: 'amount', description: 'Amount in rupees' },
        reason: { key: 'reason', description: 'Reason the admin gave' },
        transactionId: { key: 'transactionId', description: 'Payment reference, if any' },
        balance: { key: 'balance', description: 'Wallet balance after the credit' },
        accountType: { key: 'accountType', description: 'restaurant, delivery partner or customer' },
    };
    const foot = '<hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">\n<p style="color: #999; font-size: 12px;">{{companyName}}</p>';
    const t = (name, description, audience, placeholders, subject, body) => ({
        name,
        description,
        audience,
        placeholders: [...placeholders.map((k) => P[k]), P.companyName],
        subject,
        body: `${body}\n${foot}`,
    });
    return {
        admin_new_restaurant: t(
            'New restaurant registration (to admin)',
            'Sent to the admin addresses when a restaurant registers and is waiting for approval.',
            ['admin'],
            ['restaurantName', 'ownerName', 'phone', 'email'],
            'New restaurant registration: {{restaurantName}}',
            `<h2 style="color: #111;">New restaurant registration</h2>
<p><strong>{{restaurantName}}</strong> has registered and is waiting for approval.</p>
<p>Owner: {{ownerName}}<br>Phone: {{phone}}<br>Email: {{email}}</p>
<p>Review it under Restaurants &gt; New joining requests.</p>`,
        ),
        admin_new_delivery_partner: t(
            'New delivery man registration (to admin)',
            'Sent to the admin addresses when a delivery partner signs up and is waiting for approval.',
            ['admin'],
            ['riderName', 'phone', 'email'],
            'New delivery partner registration: {{riderName}}',
            `<h2 style="color: #111;">New delivery partner registration</h2>
<p><strong>{{riderName}}</strong> has signed up as a delivery partner and is waiting for approval.</p>
<p>Phone: {{phone}}<br>Email: {{email}}</p>
<p>Review it under Delivery men &gt; New joining requests.</p>`,
        ),
        restaurant_approved: t(
            'Restaurant registration approved',
            'Sent to the restaurant owner when an admin approves the registration.',
            ['restaurant'],
            ['userName', 'restaurantName'],
            'Your restaurant {{restaurantName}} is approved',
            `<h2 style="color: #111;">Welcome aboard!</h2>
<p>Hi {{userName}},</p>
<p>Your restaurant <strong>{{restaurantName}}</strong> has been approved. You can now sign in to the restaurant app and start taking orders.</p>`,
        ),
        restaurant_rejected: t(
            'Restaurant registration denied',
            'Sent to the restaurant owner when an admin rejects the registration.',
            ['restaurant'],
            ['userName', 'restaurantName', 'reason'],
            'Update on your restaurant registration',
            `<h2 style="color: #111;">Registration not approved</h2>
<p>Hi {{userName}},</p>
<p>We could not approve the registration for <strong>{{restaurantName}}</strong>.</p>
<p>Reason: {{reason}}</p>
<p>You can correct the details and apply again.</p>`,
        ),
        delivery_partner_approved: t(
            'Delivery man registration approved',
            'Sent to the delivery partner when an admin approves the application.',
            ['rider'],
            ['userName'],
            'Your delivery partner application is approved',
            `<h2 style="color: #111;">Welcome aboard!</h2>
<p>Hi {{userName}},</p>
<p>Your delivery partner application has been approved. You can now go online in the app and start earning.</p>`,
        ),
        delivery_partner_rejected: t(
            'Delivery man registration denied',
            'Sent to the delivery partner when an admin rejects the application.',
            ['rider'],
            ['userName', 'reason'],
            'Update on your delivery partner application',
            `<h2 style="color: #111;">Application not approved</h2>
<p>Hi {{userName}},</p>
<p>We could not approve your delivery partner application.</p>
<p>Reason: {{reason}}</p>`,
        ),
        withdraw_approved: t(
            'Withdraw request approved',
            'Sent to the restaurant or delivery partner when a withdrawal or payout is approved and paid.',
            ['restaurant', 'rider'],
            ['userName', 'amount', 'transactionId'],
            'Your withdrawal of ₹{{amount}} is approved',
            `<h2 style="color: #111;">Withdrawal approved</h2>
<p>Hi {{userName}},</p>
<p>Your withdrawal of <strong>₹{{amount}}</strong> has been approved and paid.</p>
<p>Reference: {{transactionId}}</p>`,
        ),
        withdraw_rejected: t(
            'Withdraw request denied',
            'Sent to the restaurant or delivery partner when a withdrawal or payout is rejected.',
            ['restaurant', 'rider'],
            ['userName', 'amount', 'reason'],
            'Your withdrawal of ₹{{amount}} was not approved',
            `<h2 style="color: #111;">Withdrawal not approved</h2>
<p>Hi {{userName}},</p>
<p>Your withdrawal of <strong>₹{{amount}}</strong> was not approved. The amount stays in your wallet.</p>
<p>Reason: {{reason}}</p>`,
        ),
        order_placed: t(
            'Order placed',
            'Sent to the customer when an order is placed (after payment, for online payments). Only customers with an email address get it.',
            ['customer'],
            ['userName', 'orderId', 'restaurantName', 'amount'],
            'Order #{{orderId}} confirmed',
            `<h2 style="color: #111;">Thanks for your order!</h2>
<p>Hi {{userName}},</p>
<p>Your order <strong>#{{orderId}}</strong> from {{restaurantName}} has been placed.</p>
<p>Order total: <strong>₹{{amount}}</strong></p>`,
        ),
        refund_approved: t(
            'Refund request approved',
            'Sent to the customer when an admin approves a refund request. Only customers with an email address get it.',
            ['customer'],
            ['userName', 'orderId', 'amount'],
            'Your refund for order #{{orderId}} is approved',
            `<h2 style="color: #111;">Refund approved</h2>
<p>Hi {{userName}},</p>
<p>Your refund of <strong>₹{{amount}}</strong> for order #{{orderId}} has been approved and sent.</p>`,
        ),
        refund_rejected: t(
            'Refund request denied',
            'Sent to the customer when an admin rejects a refund request. Only customers with an email address get it.',
            ['customer'],
            ['userName', 'orderId', 'reason'],
            'Update on your refund request for order #{{orderId}}',
            `<h2 style="color: #111;">Refund request declined</h2>
<p>Hi {{userName}},</p>
<p>Your refund request for order #{{orderId}} was declined.</p>
<p>Reason: {{reason}}</p>`,
        ),
        wallet_credited: t(
            'Add fund (wallet credited)',
            'Sent to the customer when an admin adds money to their wallet. Only customers with an email address get it.',
            ['customer'],
            ['userName', 'amount', 'balance'],
            '₹{{amount}} added to your wallet',
            `<h2 style="color: #111;">Money added to your wallet</h2>
<p>Hi {{userName}},</p>
<p><strong>₹{{amount}}</strong> has been added to your wallet. Your balance is now ₹{{balance}}.</p>`,
        ),
        account_suspended: t(
            'Account suspended',
            'Sent to a restaurant, delivery partner or customer when an admin suspends or deactivates the account.',
            ['restaurant', 'rider', 'customer'],
            ['userName', 'accountType'],
            'Your {{companyName}} account has been suspended',
            `<h2 style="color: #111;">Account suspended</h2>
<p>Hi {{userName}},</p>
<p>Your {{accountType}} account has been suspended. Please contact support if you think this is a mistake.</p>`,
        ),
        account_unsuspended: t(
            'Account unsuspended',
            'Sent to a restaurant, delivery partner or customer when an admin reactivates the account.',
            ['restaurant', 'rider', 'customer'],
            ['userName', 'accountType'],
            'Your {{companyName}} account is active again',
            `<h2 style="color: #111;">Account active again</h2>
<p>Hi {{userName}},</p>
<p>Your {{accountType}} account has been reactivated. Welcome back!</p>`,
        ),
    };
}

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
