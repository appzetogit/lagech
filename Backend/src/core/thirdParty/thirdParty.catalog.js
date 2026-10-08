import { ValidationError } from '../auth/errors.js';
import { seal, open, isSealed, maskSecret } from './secretBox.js';

/**
 * The third-party settings an admin can edit (the old panel's "3rd party"
 * page), one area per tab: each field, whether it is a secret, and how to read
 * what the server uses today from its environment.
 *
 * Stored per area in food_system_settings under `third_party.<area>` as
 * `{ values: { field: plain | { enc } } }`. A field present in `values` was
 * saved by an admin and wins; a missing field falls back to the server's
 * environment value, so nothing changes until an admin saves something.
 * Secrets are always stored encrypted (secretBox.js).
 *
 * `wired` says whether the running server reads the area: true means a save
 * takes effect (within the cache window), false means it is kept for later and
 * the page says why.
 *
 * Pure apart from the encryption, so every rule is tested without a database.
 */

export const DEFAULT_OTP_MESSAGE = 'Welcome to the Lagech powered by Appzeto.Your OTP for registration is {otp}.BGADEC.';

const str = (value) => (value === undefined || value === null ? '' : String(value).trim());
const envStr = (value) => str(value);

export const THIRD_PARTY_AREAS = {
    sms: {
        label: 'SMS Module',
        wired: true,
        note: 'Used for the login OTP sent to customers, restaurants and riders. When the server runs with the fixed test OTP (USE_DEFAULT_OTP), no SMS is sent at all, whatever is saved here. SMS India Hub is the only provider the backend can send through.',
        fields: [
            {
                key: 'provider', label: 'Provider', type: 'select',
                options: [{ value: 'smsindiahub', label: 'SMS India Hub' }],
                env: () => 'smsindiahub',
            },
            { key: 'username', label: 'Username', type: 'text', max: 120, env: (c) => c.smsIndiaHubUsername },
            { key: 'apiKey', label: 'API key', type: 'text', secret: true, env: (c) => c.smsApiKey },
            { key: 'senderId', label: 'Sender ID', type: 'text', max: 20, env: (c) => c.smsSenderId },
            { key: 'dltTemplateId', label: 'DLT template ID', type: 'text', max: 60, env: (c) => c.smsDltTemplateId },
            {
                key: 'otpMessage', label: 'OTP message', type: 'textarea', max: 480,
                help: 'Must match the DLT template registered for the template ID exactly. {otp} is replaced with the code.',
                env: () => DEFAULT_OTP_MESSAGE,
            },
        ],
        validate: (v) => {
            if (v.otpMessage && !v.otpMessage.includes('{otp}')) throw new ValidationError('The OTP message must contain {otp}');
        },
    },
    mail: {
        label: 'Mail Config',
        wired: true,
        note: 'Used for the admin password-reset email (and any email the server sends).',
        fields: [
            { key: 'enabled', label: 'Send email', type: 'boolean', env: (c) => Boolean(c.emailHost && c.emailUser && c.emailPass) },
            { key: 'host', label: 'SMTP host', type: 'text', max: 200, env: (c) => c.emailHost },
            { key: 'port', label: 'SMTP port', type: 'number', min: 1, max: 65535, env: (c) => c.emailPort || 587 },
            {
                key: 'encryption', label: 'Encryption', type: 'select',
                options: [
                    { value: 'tls', label: 'STARTTLS (usually port 587)' },
                    { value: 'ssl', label: 'SSL/TLS (usually port 465)' },
                    { value: 'none', label: 'None' },
                ],
                env: (c) => (Number(c.emailPort) === 465 ? 'ssl' : 'tls'),
            },
            { key: 'username', label: 'Username', type: 'text', max: 200, env: (c) => c.emailUser },
            { key: 'password', label: 'Password', type: 'text', secret: true, stripSpaces: true, env: (c) => c.emailPass },
            {
                key: 'from', label: 'From address', type: 'text', max: 200,
                help: 'An address, or a name and address such as Lagech <noreply@example.com>.',
                env: (c) => c.emailFrom,
            },
        ],
        validate: (v) => {
            if (v.from && !/[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/.test(v.from)) throw new ValidationError('From address must contain an email address');
        },
    },
    maps: {
        label: 'Map APIs',
        wired: true,
        note: 'The server key is used by the backend for driving routes and distances, and takes effect on save. The client key is stored only: the website and admin panel are built with VITE_GOOGLE_MAPS_API_KEY, so a new client key needs a new frontend build.',
        fields: [
            {
                key: 'clientKey', label: 'Client key (website, apps, admin)', type: 'text', max: 200, storedOnly: true,
                help: 'Browser key, restrict it to your domains in Google Cloud.',
                env: (_c, e) => e.VITE_GOOGLE_MAPS_API_KEY,
            },
            {
                key: 'serverKey', label: 'Server key (backend)', type: 'text', secret: true,
                help: 'Needs the Directions API. Restrict it to the server IP.',
                env: (c) => c.googleMapsApiKey,
            },
        ],
    },
    recaptcha: {
        label: 'Recaptcha',
        wired: false,
        note: 'Stored only. No login screen uses reCAPTCHA today (admin sign-in is email and password, everyone else signs in with a phone OTP), so switching it on does not change any login yet.',
        fields: [
            { key: 'enabled', label: 'Use reCAPTCHA', type: 'boolean', env: () => false },
            { key: 'siteKey', label: 'Site key', type: 'text', max: 200, env: (_c, e) => e.RECAPTCHA_SITE_KEY },
            { key: 'secretKey', label: 'Secret key', type: 'text', secret: true, env: (_c, e) => e.RECAPTCHA_SECRET_KEY },
        ],
        validate: (v) => {
            if (v.enabled && (!v.siteKey || !v.secretKey)) throw new ValidationError('Enter the site key and the secret key before switching reCAPTCHA on');
        },
    },
    social_login: {
        label: 'Social Logins',
        wired: false,
        note: 'Stored only. Sign-in is by phone OTP today; the backend has no Google or Apple sign-in yet. The Google / Apple switches the apps read are under Login Setup.',
        fields: [
            { key: 'googleClientId', label: 'Google client ID', type: 'text', max: 300, env: (_c, e) => e.GOOGLE_CLIENT_ID },
            { key: 'googleClientSecret', label: 'Google client secret', type: 'text', secret: true, env: (_c, e) => e.GOOGLE_CLIENT_SECRET },
            { key: 'appleServiceId', label: 'Apple service ID', type: 'text', max: 200, env: (_c, e) => e.APPLE_SERVICE_ID },
            { key: 'appleTeamId', label: 'Apple team ID', type: 'text', max: 20, env: (_c, e) => e.APPLE_TEAM_ID },
            { key: 'appleKeyId', label: 'Apple key ID', type: 'text', max: 20, env: (_c, e) => e.APPLE_KEY_ID },
            { key: 'applePrivateKey', label: 'Apple private key (.p8)', type: 'textarea', secret: true, max: 4000, env: (_c, e) => e.APPLE_PRIVATE_KEY },
        ],
    },
    storage: {
        label: 'Storage Connection',
        wired: false,
        note: 'Stored only. Uploads go where the server was started with (UPLOAD_DRIVER): switching between local disk and S3 while running would leave every file already uploaded behind on the old store and break signed image links, so a change here is applied by updating the server configuration and restarting.',
        fields: [
            {
                key: 'driver', label: 'Store uploads on', type: 'select',
                options: [{ value: 'local', label: 'Server disk (local)' }, { value: 's3', label: 'Amazon S3' }],
                env: (_c, e) => (String(e.UPLOAD_DRIVER || '').toLowerCase() === 's3' ? 's3' : 'local'),
            },
            { key: 'bucket', label: 'S3 bucket', type: 'text', max: 100, env: (_c, e) => e.UPLOAD_S3_BUCKET },
            { key: 'region', label: 'S3 region', type: 'text', max: 40, env: (_c, e) => e.UPLOAD_S3_REGION || e.AWS_REGION },
            { key: 'prefix', label: 'Key prefix', type: 'text', max: 100, env: (_c, e) => e.UPLOAD_S3_PREFIX },
            { key: 'accessKeyId', label: 'Access key ID', type: 'text', secret: true, env: (_c, e) => e.AWS_ACCESS_KEY_ID },
            { key: 'secretAccessKey', label: 'Secret access key', type: 'text', secret: true, env: (_c, e) => e.AWS_SECRET_ACCESS_KEY },
        ],
        validate: (v) => {
            if (v.driver === 's3' && (!v.bucket || !v.region)) throw new ValidationError('Enter the S3 bucket and region for S3 storage');
        },
    },
    payment: {
        label: 'Payment Setup',
        wired: true,
        note: 'Razorpay. Saved keys take effect for new payments within a minute. Payments already in progress still verify against the server keys too, so changing keys does not fail them. Switching Razorpay off stops new online payments; verification and refunds of earlier ones keep working.',
        fields: [
            { key: 'enabled', label: 'Accept online payments (Razorpay)', type: 'boolean', env: () => true },
            {
                key: 'mode', label: 'Mode', type: 'select',
                options: [{ value: 'test', label: 'Test' }, { value: 'live', label: 'Live' }],
                env: (c) => (String(c.razorpayKeyId || '').startsWith('rzp_live_') ? 'live' : 'test'),
            },
            { key: 'keyId', label: 'Key ID', type: 'text', max: 100, pair: 'razorpay', env: (c) => c.razorpayKeyId },
            { key: 'keySecret', label: 'Key secret', type: 'text', secret: true, pair: 'razorpay', env: (c) => c.razorpayKeySecret },
            { key: 'webhookSecret', label: 'Webhook secret', type: 'text', secret: true, env: (c) => c.razorpayWebhookSecret },
        ],
        validate: (v) => {
            if (v.keyId && !/^rzp_(test|live)_[A-Za-z0-9]+$/.test(v.keyId)) throw new ValidationError('Key ID should look like rzp_live_XXXXXXXX or rzp_test_XXXXXXXX');
            if (v.keyId && v.mode === 'live' && v.keyId.startsWith('rzp_test_')) throw new ValidationError('Live mode needs a live key (rzp_live_...)');
            if (v.keyId && v.mode === 'test' && v.keyId.startsWith('rzp_live_')) throw new ValidationError('Test mode needs a test key (rzp_test_...)');
        },
    },
};

export const AREA_KEYS = Object.keys(THIRD_PARTY_AREAS);

/** The food_system_settings key for an area. Never one of the generic areas. */
export const storeKey = (area) => `third_party.${area}`;

export function getArea(area) {
    const definition = THIRD_PARTY_AREAS[area];
    if (!definition) throw new ValidationError('Unknown third-party settings area');
    return definition;
}

const where = (area, field) => `${area}.${field}`;

/** The server's own value for a field (environment / built-in), cleaned. */
export function envValue(field, config, env = process.env) {
    const raw = field.env ? field.env(config, env) : undefined;
    if (field.type === 'boolean') return Boolean(raw);
    if (field.type === 'number') {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? n : null;
    }
    const text = envStr(raw);
    return field.stripSpaces ? text.replace(/\s/g, '') : text;
}

const hasContent = (field, value) =>
    field.type === 'boolean' ? typeof value === 'boolean' : value !== null && value !== undefined && value !== '';

/** One admin input checked against its field. '' means "not set". */
export function cleanFieldInput(field, value) {
    if (field.type === 'boolean') return value === true || value === 'true' || value === 1 || value === '1';
    if (field.type === 'number') {
        if (value === '' || value === null || value === undefined) return '';
        const n = Number(value);
        if (!Number.isInteger(n) || n < (field.min ?? 0) || n > (field.max ?? Number.MAX_SAFE_INTEGER)) {
            throw new ValidationError(`${field.label} must be a whole number between ${field.min} and ${field.max}`);
        }
        return n;
    }
    let text = str(value);
    if (field.stripSpaces) text = text.replace(/\s/g, '');
    const max = field.max || (field.secret ? 4096 : 500);
    if (text.length > max) throw new ValidationError(`${field.label} is too long (at most ${max} characters)`);
    if (field.type === 'select' && text && !field.options.some((o) => o.value === text)) {
        throw new ValidationError(`${field.label} must be one of: ${field.options.map((o) => o.label).join(', ')}`);
    }
    return text;
}

/**
 * Reads a stored document: per field, the admin's plain value (decrypted for
 * secrets) or a note that the saved secret could not be decrypted.
 */
export function readStored(area, doc) {
    const definition = getArea(area);
    const values = doc && typeof doc === 'object' && doc.values && typeof doc.values === 'object' ? doc.values : {};
    const saved = {};
    const unreadable = [];
    for (const field of definition.fields) {
        if (!Object.prototype.hasOwnProperty.call(values, field.key)) continue;
        const stored = values[field.key];
        if (field.secret) {
            const plain = open(stored, where(area, field.key));
            if (plain === null) unreadable.push(field.key);
            else saved[field.key] = plain;
        } else if (!isSealed(stored)) {
            saved[field.key] = stored;
        }
    }
    return { saved, unreadable };
}

/**
 * What the server uses for an area: the admin's value where one is saved,
 * otherwise the environment. `sources` says which, per field ('admin',
 * 'server' or 'none' when neither has a value).
 */
export function resolveEffective(area, doc, config, env = process.env) {
    const definition = getArea(area);
    const { saved, unreadable } = readStored(area, doc);
    // Half of a pair unreadable: the whole pair falls back to the server, so
    // an admin key id is never used with the server's secret.
    for (const field of definition.fields) {
        if (!field.pair || !unreadable.includes(field.key)) continue;
        for (const partner of definition.fields) if (partner.pair === field.pair) delete saved[partner.key];
    }
    const values = {};
    const sources = {};
    for (const field of definition.fields) {
        if (Object.prototype.hasOwnProperty.call(saved, field.key)) {
            values[field.key] = saved[field.key];
            sources[field.key] = 'admin';
        } else {
            const fallback = envValue(field, config, env);
            values[field.key] = fallback;
            sources[field.key] = field.type === 'boolean' || hasContent(field, fallback) ? 'server' : 'none';
        }
    }
    return { values, sources, unreadable };
}

/**
 * The admin page's view of an area. Secrets are never included, only whether
 * one is set and a mask; everything else is shown in full.
 */
export function describeArea(area, doc, config, env = process.env) {
    const definition = getArea(area);
    const { values, sources, unreadable } = resolveEffective(area, doc, config, env);
    return {
        area,
        label: definition.label,
        wired: definition.wired,
        note: definition.note,
        fields: definition.fields.map((field) => {
            const value = values[field.key];
            const base = {
                key: field.key,
                label: field.label,
                type: field.type,
                secret: Boolean(field.secret),
                source: sources[field.key],
                hasValue: hasContent(field, value),
                ...(field.options ? { options: field.options } : {}),
                ...(field.help ? { help: field.help } : {}),
                ...(field.storedOnly ? { storedOnly: true } : {}),
                ...(unreadable.includes(field.key) ? { unreadable: true } : {}),
            };
            if (field.secret) return { ...base, value: '', masked: maskSecret(value) };
            return { ...base, value: value ?? '' };
        }),
    };
}

/**
 * Applies an admin save to a stored document and returns the new document and
 * the names of the fields that changed.
 *
 * `values` holds only what the admin changed. An empty secret keeps the saved
 * one (the page never has it to send back); an empty non-secret, or a field
 * named in `clear`, removes the admin value so the server setting applies
 * again. The resulting effective settings are validated as a whole.
 */
export function applySave(area, doc, { values = {}, clear = [] } = {}, config, env = process.env) {
    const definition = getArea(area);
    const current = doc && typeof doc === 'object' && doc.values && typeof doc.values === 'object' ? { ...doc.values } : {};
    const input = values && typeof values === 'object' && !Array.isArray(values) ? values : {};
    const clearList = Array.isArray(clear) ? clear.map(String) : [];
    const changed = new Set();

    for (const field of definition.fields) {
        if (clearList.includes(field.key)) {
            if (Object.prototype.hasOwnProperty.call(current, field.key)) {
                delete current[field.key];
                changed.add(field.key);
            }
            continue;
        }
        if (!Object.prototype.hasOwnProperty.call(input, field.key)) continue;
        const clean = cleanFieldInput(field, input[field.key]);
        if (field.secret) {
            if (clean === '') continue; // keep what is saved
            current[field.key] = seal(clean, where(area, field.key));
            changed.add(field.key);
        } else if (clean === '') {
            if (Object.prototype.hasOwnProperty.call(current, field.key)) {
                delete current[field.key];
                changed.add(field.key);
            }
        } else if (current[field.key] !== clean) {
            current[field.key] = clean;
            changed.add(field.key);
        }
    }

    const next = { values: current };
    checkPairs(area, next);
    const { values: effective } = resolveEffective(area, next, config, env);
    if (definition.validate) definition.validate(effective);
    return { doc: next, changed: [...changed] };
}

/**
 * Fields that only work together (Razorpay key id and secret) must both come
 * from the same place: an admin key id with the server's secret would sign
 * every payment with a mismatched pair.
 */
export function checkPairs(area, doc) {
    const definition = getArea(area);
    const values = doc?.values || {};
    const groups = {};
    for (const field of definition.fields) {
        if (!field.pair) continue;
        (groups[field.pair] ||= []).push(field);
    }
    for (const fields of Object.values(groups)) {
        const saved = fields.filter((f) => Object.prototype.hasOwnProperty.call(values, f.key));
        if (saved.length && saved.length !== fields.length) {
            const missing = fields.filter((f) => !saved.includes(f)).map((f) => f.label);
            throw new ValidationError(`Save ${missing.join(' and ')} too: ${fields.map((f) => f.label).join(' and ')} must be changed together`);
        }
    }
}

/**
 * Copies the server's current values into the stored document, server side.
 * Fields the admin already saved are left alone unless `overwrite` is set.
 * Returns the new document and which fields were imported.
 */
export function applyImport(area, doc, { overwrite = false } = {}, config, env = process.env) {
    const definition = getArea(area);
    const current = doc && typeof doc === 'object' && doc.values && typeof doc.values === 'object' ? { ...doc.values } : {};
    const imported = [];
    const skipped = [];
    for (const field of definition.fields) {
        const value = envValue(field, config, env);
        if (!hasContent(field, value)) continue;
        if (Object.prototype.hasOwnProperty.call(current, field.key) && !overwrite) {
            skipped.push(field.key);
            continue;
        }
        current[field.key] = field.secret ? seal(value, where(area, field.key)) : value;
        imported.push(field.key);
    }
    const next = { values: current };
    // A pair only half present on the server stays as it was rather than
    // failing the whole import.
    try {
        checkPairs(area, next);
    } catch {
        for (const field of definition.fields.filter((f) => f.pair)) {
            if (doc?.values && Object.prototype.hasOwnProperty.call(doc.values, field.key)) current[field.key] = doc.values[field.key];
            else delete current[field.key];
            const at = imported.indexOf(field.key);
            if (at >= 0) imported.splice(at, 1);
        }
    }
    return { doc: next, imported, skipped };
}
