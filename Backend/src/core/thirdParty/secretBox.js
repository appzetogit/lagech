import crypto from 'crypto';
import { config } from '../../config/env.js';

/**
 * Encryption at rest for the third-party secrets an admin saves (SMTP
 * password, SMS API key, Razorpay secret, ...).
 *
 * AES-256-GCM with a fresh 12-byte IV per value. The key is derived with HKDF
 * from SETTINGS_ENCRYPTION_KEY when it is set, otherwise from the JWT access
 * secret, so a working server needs no new variable. The ciphertext is bound
 * to where it is stored (area + field, as GCM associated data): a value copied
 * into another field of the row fails to decrypt instead of being used there.
 *
 * Rotating the key material makes old values unreadable. That is reported as
 * a decrypt failure: the runtime then falls back to the server setting and the
 * admin page asks for the value again. It never throws into a request.
 */

const VERSION = 'v1';
const SALT = 'lagech-third-party-settings';
const INFO = 'aes-256-gcm/v1';

let cached = null;

const keyMaterial = () =>
    String(process.env.SETTINGS_ENCRYPTION_KEY || config.jwtAccessSecret || process.env.JWT_SECRET || '').trim();

function getKey() {
    const material = keyMaterial();
    if (!material) throw new Error('No key material for settings encryption (set SETTINGS_ENCRYPTION_KEY)');
    if (cached && cached.material === material) return cached.key;
    const key = Buffer.from(crypto.hkdfSync('sha256', material, SALT, INFO, 32));
    cached = { material, key };
    return key;
}

/** True when a stored value is an encrypted envelope this module wrote. */
export const isSealed = (value) =>
    Boolean(value && typeof value === 'object' && typeof value.enc === 'string' && value.enc.startsWith(`${VERSION}:`));

/** Encrypts `plain` for `where` (e.g. "mail.password"). */
export function seal(plain, where) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
    cipher.setAAD(Buffer.from(String(where), 'utf8'));
    const body = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { enc: `${VERSION}:${Buffer.concat([iv, tag, body]).toString('base64')}` };
}

/** The plain value, or null when it cannot be decrypted (wrong key, tampered, moved). */
export function open(envelope, where) {
    if (!isSealed(envelope)) return null;
    try {
        const raw = Buffer.from(envelope.enc.slice(VERSION.length + 1), 'base64');
        if (raw.length < 29) return null;
        const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(String(where), 'utf8'));
        decipher.setAuthTag(raw.subarray(12, 28));
        return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
    } catch {
        return null;
    }
}

/**
 * What the admin page shows for a secret: never the value. Long values show
 * their last four characters so two keys can be told apart; short ones (a
 * password) show nothing of themselves.
 */
export function maskSecret(value) {
    const text = String(value ?? '');
    if (!text) return '';
    return text.length >= 12 ? `••••${text.slice(-4)}` : '••••••••';
}
