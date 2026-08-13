export class ValidationError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ValidationError';
        this.statusCode = 400;
    }
}

export class AuthError extends Error {
    constructor(message) {
        super(message);
        this.name = 'AuthError';
        this.statusCode = 401;
    }
}

export class ForbiddenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'ForbiddenError';
        this.statusCode = 403;
    }
}


export class NotFoundError extends Error {
    constructor(message) {
        super(message);
        this.name = 'NotFoundError';
        this.statusCode = 404;
    }
}

/**
 * Business-layer rate limit (e.g. per-phone OTP quota), as opposed to the
 * HTTP/IP limiter in middleware/rateLimit.js.
 *
 * Carries [retryAfterSeconds] so the error handler can emit a real `Retry-After`
 * header — previously this path threw a ValidationError, which told the client
 * "400 Bad Request" for what is actually a temporary, retryable condition, with
 * no machine-readable indication of when to retry.
 */
export class RateLimitError extends Error {
    constructor(message, retryAfterSeconds) {
        super(message);
        this.name = 'RateLimitError';
        this.statusCode = 429;
        this.retryAfterSeconds = Math.max(1, Math.ceil(Number(retryAfterSeconds) || 1));
    }
}

