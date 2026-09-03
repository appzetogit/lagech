/**
 * Turns stored S3 urls into short-lived signed ones on the way out.
 *
 * The bucket holds delivery riders' Aadhaar cards, PAN cards and driving
 * licences alongside restaurant photos. With a public-read bucket policy every
 * one of those is readable by anyone who has, guesses or is shown the url, and
 * the urls end up in browser history, logs and referrer headers. Signing them
 * means possession of a url is not possession of the document.
 *
 * Signed urls expire, so they are never stored. The database keeps the plain
 * object url; signing happens per response, in sendResponse, which is the one
 * place every payload passes through.
 *
 * SIGNING_WINDOW_MS is the part that is easy to get wrong. Signing with
 * `new Date()` produces a different url on every request, so the browser can
 * never reuse a cached image and every page view refetches every photo. The
 * signing timestamp is rounded down to a window instead: within one window the
 * url is byte-identical and caches normally, and it still stops working once
 * the expiry passes.
 */
import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';

const BUCKET = process.env.UPLOAD_S3_BUCKET || '';
const REGION = process.env.UPLOAD_S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const ENABLED = String(process.env.UPLOAD_SIGNED_URLS || '').toLowerCase() === 'true' && Boolean(BUCKET);

// An hour is long enough for a page to load and be read, short enough that a
// leaked url is not a lasting problem.
const EXPIRY_SECONDS = Number(process.env.UPLOAD_SIGNED_URL_TTL || 3600);
const SIGNING_WINDOW_MS = 15 * 60 * 1000;

const HOSTS = [
    `${BUCKET}.s3.${REGION}.amazonaws.com`,
    `${BUCKET}.s3.amazonaws.com`,
];

let signerPromise = null;
const getSigner = async () => {
    if (!signerPromise) {
        signerPromise = (async () => {
            const [{ S3Client, GetObjectCommand }, { getSignedUrl }] = await Promise.all([
                import('@aws-sdk/client-s3'),
                import('@aws-sdk/s3-request-presigner'),
            ]);
            return { client: new S3Client({ region: REGION }), GetObjectCommand, getSignedUrl };
        })();
    }
    return signerPromise;
};

/** Object key for one of our bucket urls, or null if it is not ours. */
export const keyForUrl = (value) => {
    if (typeof value !== 'string' || value.length < 12) return null;
    if (!value.startsWith('http')) return null;
    let parsed;
    try { parsed = new URL(value); } catch { return null; }
    if (!HOSTS.includes(parsed.hostname)) return null;
    // Already signed: re-signing would nest query parameters and break it.
    if (parsed.searchParams.has('X-Amz-Signature')) return null;
    const key = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
    return key || null;
};

const cache = new Map();

export const signUrl = async (value) => {
    const key = keyForUrl(value);
    if (!key) return value;

    // Rounded so the same key yields the same url for the whole window.
    const windowStart = Math.floor(Date.now() / SIGNING_WINDOW_MS) * SIGNING_WINDOW_MS;
    const cacheKey = `${windowStart}:${key}`;
    const hit = cache.get(cacheKey);
    if (hit) return hit;

    try {
        const { client, GetObjectCommand, getSignedUrl } = await getSigner();
        const signed = await getSignedUrl(
            client,
            new GetObjectCommand({ Bucket: BUCKET, Key: key }),
            { expiresIn: EXPIRY_SECONDS, signingDate: new Date(windowStart) },
        );
        // Only the current window is worth keeping; anything older can never be
        // returned again, so the map does not grow without bound.
        if (cache.size > 5000) cache.clear();
        cache.set(cacheKey, signed);
        return signed;
    } catch (error) {
        // A response with an unsigned url is far better than a failed request.
        logger.error(`Failed to sign media url for ${key}: ${error.message}`);
        return value;
    }
};

/**
 * Walks a response payload and signs every url belonging to our bucket.
 * Returns the value unchanged when signing is off, so the call site needs no
 * condition of its own.
 */
export const signMediaUrls = async (payload) => {
    if (!ENABLED || payload == null) return payload;

    const seen = new WeakSet();
    const walk = async (node) => {
        if (typeof node === 'string') return signUrl(node);
        if (Array.isArray(node)) return Promise.all(node.map(walk));
        if (node && typeof node === 'object') {
            // Dates, Decimals and Buffers have their own constructor and must not
            // be shredded into their enumerable properties.
            if (node.constructor && node.constructor !== Object) return node;
            if (seen.has(node)) return node;
            seen.add(node);
            const entries = await Promise.all(
                Object.entries(node).map(async ([k, v]) => [k, await walk(v)]),
            );
            return Object.fromEntries(entries);
        }
        return node;
    };

    try {
        return await walk(payload);
    } catch (error) {
        logger.error(`Media url signing failed, returning payload unsigned: ${error.message}`);
        return payload;
    }
};

export const signingEnabled = () => ENABLED;
export const signingConfig = () => ({ enabled: ENABLED, bucket: BUCKET, region: REGION, ttl: EXPIRY_SECONDS });
