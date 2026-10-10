import { getServiceAccountFromEnv } from '../../config/firebase.js';
import { logger } from '../../utils/logger.js';
import { AuthError } from './errors.js';

/**
 * Firebase Phone Authentication: the app proves the phone number to Firebase
 * (Firebase sends and checks the SMS code), then hands us the Firebase ID token.
 * We verify that token here and log the phone number in through exactly the
 * same path as the SMS OTP verify. This is how the old 6amMart system worked
 * (firebase_otp_verification=1, project pr-2602-048---lagech): no SMS gateway.
 *
 * The verification itself is injectable so tests can stub it; production uses
 * firebase-admin's verifyIdToken(idToken, checkRevoked = true), which checks the
 * signature, expiry, issuer and that the audience is the service account's own
 * project.
 *
 * The ID token is a bearer credential: it is never logged, not even on failure.
 */

/** A named app, so it is always the one initialised with the service account. */
const AUTH_APP_NAME = 'lagech-phone-auth';

let authPromise = null;

const getExpectedProjectIdFromServiceAccount = () => {
    const account = getServiceAccountFromEnv();
    return account?.project_id ? String(account.project_id) : null;
};

const getAdminAuth = async () => {
    if (!authPromise) {
        authPromise = (async () => {
            const serviceAccount = getServiceAccountFromEnv();
            if (!serviceAccount?.project_id) {
                throw new Error('Firebase service account is not configured');
            }
            const { initializeApp, getApps, cert } = await import('firebase-admin/app');
            const { getAuth } = await import('firebase-admin/auth');
            const existing = getApps().find((app) => app.name === AUTH_APP_NAME);
            const app = existing || initializeApp(
                {
                    credential: cert(serviceAccount),
                    // Pinned to the service account's project: verifyIdToken
                    // checks the token's audience against this.
                    projectId: serviceAccount.project_id,
                },
                AUTH_APP_NAME,
            );
            return getAuth(app);
        })().catch((err) => {
            authPromise = null;
            throw err;
        });
    }
    return authPromise;
};

const defaultVerifier = async (idToken) => {
    const auth = await getAdminAuth();
    return auth.verifyIdToken(idToken, true);
};

let verifier = defaultVerifier;
let expectedProjectIdOverride;

/**
 * Tests only: replace the token verifier (and optionally the project the
 * token's audience must match). Call resetFirebaseIdTokenVerifier() after.
 */
export const setFirebaseIdTokenVerifier = (fn, { projectId } = {}) => {
    verifier = fn;
    expectedProjectIdOverride = projectId;
};

export const resetFirebaseIdTokenVerifier = () => {
    verifier = defaultVerifier;
    expectedProjectIdOverride = undefined;
};

const FIREBASE_ERROR_MESSAGES = {
    'auth/id-token-expired': 'Phone verification has expired. Please verify your phone number again.',
    'auth/id-token-revoked': 'Phone verification has been revoked. Please verify your phone number again.',
    'auth/user-disabled': 'This phone number has been disabled for sign-in. Please contact support.',
    'auth/user-not-found': 'Phone verification is no longer valid. Please verify your phone number again.',
};

/**
 * +91XXXXXXXXXX -> XXXXXXXXXX, the form the system stores phones in (the
 * same last-10-digits rule the OTP verify uses for riders and restaurants).
 * Only Indian numbers are accepted: every account is stored without a
 * country code, so a foreign number could collide with an Indian one.
 */
export const normalizeFirebasePhone = (phoneNumber) => {
    const raw = String(phoneNumber || '').trim();
    const digits = raw.replace(/\D/g, '');
    if (raw.startsWith('+')) {
        if (!digits.startsWith('91') || digits.length !== 12) return null;
        return digits.slice(-10);
    }
    return digits.length === 10 ? digits : null;
};

/**
 * Verifies a Firebase ID token and returns the phone number it proves, in the
 * stored 10-digit form. Throws AuthError (401) on anything else.
 */
export const verifyFirebasePhoneIdToken = async (idToken) => {
    if (typeof idToken !== 'string' || !idToken.trim()) {
        throw new AuthError('Firebase ID token is required');
    }

    let decoded;
    try {
        decoded = await verifier(idToken.trim());
    } catch (err) {
        const code = err?.code || err?.errorInfo?.code || '';
        if (FIREBASE_ERROR_MESSAGES[code]) {
            throw new AuthError(FIREBASE_ERROR_MESSAGES[code]);
        }
        if (String(code).startsWith('auth/')) {
            throw new AuthError('Invalid phone verification token. Please verify your phone number again.');
        }
        // Not a token problem: Firebase is not configured or unreachable. The
        // message is logged (it never contains the token); the client gets a
        // plain 503 rather than a misleading "invalid token".
        logger.error(`[firebase-login] could not verify an ID token: ${err?.message || 'unknown error'}`);
        const unavailable = new Error('Phone verification is temporarily unavailable. Please try again.');
        unavailable.statusCode = 503;
        throw unavailable;
    }

    if (!decoded || typeof decoded !== 'object') {
        throw new AuthError('Invalid phone verification token. Please verify your phone number again.');
    }

    let expectedProjectId = expectedProjectIdOverride;
    if (expectedProjectId === undefined) {
        try {
            expectedProjectId = getExpectedProjectIdFromServiceAccount();
        } catch {
            expectedProjectId = null;
        }
    }
    if (expectedProjectId && decoded.aud !== expectedProjectId) {
        throw new AuthError('This phone verification was issued for a different app. Please update the app and try again.');
    }

    if (decoded.firebase?.sign_in_provider !== 'phone') {
        throw new AuthError('Only phone number sign-in is accepted here.');
    }

    if (!decoded.phone_number) {
        throw new AuthError('The phone verification token carries no phone number.');
    }

    const phone = normalizeFirebasePhone(decoded.phone_number);
    if (!phone) {
        throw new AuthError('Only Indian (+91) mobile numbers can sign in.');
    }

    return { phone, uid: decoded.uid || decoded.sub || null };
};
