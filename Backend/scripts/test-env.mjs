/**
 * Defaults the test suite needs before anything imports config/env.js.
 *
 * There is no .env in the repo, so a bare `npm test` had to be run with the
 * variables set by hand — which meant the HTTP tests could not mint a token.
 * Loaded with `node --import`, which runs before the main module and is
 * inherited by every `node --test` child.
 *
 * Only fills gaps: a real value in the environment always wins. DATABASE_URL is
 * deliberately not defaulted — pointing the suite at a database nobody asked
 * for is worse than skipping.
 */
process.env.NODE_ENV ??= 'test';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret';
process.env.USE_DEFAULT_OTP ??= 'true';
