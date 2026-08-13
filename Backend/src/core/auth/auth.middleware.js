import { verifyAccessToken } from './token.util.js';
import { sendError } from '../../utils/response.js';
import { prisma } from '../../config/prisma.js';
import { isId } from '../../utils/helpers.js';

export const requireAdmin = (req, res, next) => {
    if (req.user?.role !== 'ADMIN') {
        return sendError(res, 403, 'Admin access required');
    }
    next();
};

/**
 * Accounts whose sessions are single-device.
 *
 * Admins are intentionally absent: the panel is routinely used across several
 * browser tabs and machines, so evicting the others on each sign-in would be a
 * regression rather than a safeguard.
 */
const SESSION_SCOPED_MODELS = {
    USER: () => prisma.foodUser,
    RESTAURANT: () => prisma.foodRestaurant,
    DELIVERY_PARTNER: () => prisma.foodDeliveryPartner
};

export const authMiddleware = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return sendError(res, 401, 'Authentication token missing');
    }

    let decoded;
    try {
        decoded = verifyAccessToken(token);
    } catch (error) {
        return sendError(res, 401, 'Invalid or expired token');
    }

    req.user = {
        userId: decoded.userId,
        role: decoded.role,
        adminType: decoded.adminType
    };

    const delegate = SESSION_SCOPED_MODELS[decoded.role];
    if (!delegate) return next();

    // A malformed id would otherwise reach the database as a query that cannot
    // match; reject it here as the bad token it is.
    if (!isId(decoded.userId)) return sendError(res, 401, 'Invalid or expired token');

    // One indexed lookup of two small fields. USER already paid for this to check
    // isActive; the version travels in the same query rather than a second round
    // trip, and the other two roles now share the same path.
    //
    // isActive is selected for every role even though only USER has the column
    // read below — restaurants and partners use `status`, which this check has
    // never consulted.
    delegate()
        .findUnique({
            where: { id: decoded.userId },
            select: { tokenVersion: true, ...(decoded.role === 'USER' ? { isActive: true } : {}) },
        })
        .then((doc) => {
            if (!doc) return sendError(res, 401, 'Account not found');
            if (decoded.role === 'USER' && doc.isActive === false) {
                return sendError(res, 401, 'User account is deactivated');
            }

            // A token minted before the latest login belongs to a device that has
            // since been replaced.
            //
            // Tokens issued BEFORE this feature shipped carry no version at all.
            // Treating those as 0 would sign every existing user out the moment a
            // single new login bumped anyone; instead they are accepted until the
            // account next logs in, which is when the eviction genuinely applies.
            const stored = Number(doc.tokenVersion) || 0;
            const presented = decoded.tokenVersion;
            if (presented !== undefined && Number(presented) !== stored) {
                return sendError(
                    res,
                    401,
                    'You have been signed out because this account was used on another device'
                );
            }

            return next();
        })
        .catch(() => sendError(res, 401, 'Authentication failed'));
};
export const optionalAuth = (req, res, next) => {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.substring(7) : null;

    if (!token) {
        return next();
    }

    try {
        const decoded = verifyAccessToken(token);
        req.user = {
            userId: decoded.userId,
            role: decoded.role,
            adminType: decoded.adminType
        };
        next();
    } catch (error) {
        // Silently ignore invalid tokens in optional auth
        next();
    }
};
