import express from 'express';
import path from 'path';
import cors from 'cors';
import helmet from 'helmet';
import mongoSanitize from 'mongo-sanitize';
import xssClean from 'xss-clean';
import routes from './routes/index.js';
import shareLinksRoutes from './modules/food/public/shareLinks.routes.js';
import errorHandler from './middleware/errorHandler.js';
import { apiRateLimiter } from './middleware/rateLimit.js';
import { responseTimeLogger } from './middleware/responseTimeLogger.js';
import { requestIdMiddleware } from './middleware/requestId.js';
import { healthCheck } from './config/health.js';
import { config } from './config/env.js';

const app = express();

// Trust first proxy (essential for express-rate-limit if behind a proxy)
app.set('trust proxy', 1);

// Request ID tracing (before other middlewares so all logs can use it)
app.use(requestIdMiddleware);

// Health endpoints (no rate limit, minimal JSON, no secrets)
app.get('/health', async (_req, res) => {
    try {
        const data = await healthCheck();
        // 503 when the database is unreachable, so a load balancer stops
        // routing to this instance instead of only the body saying DOWN.
        res.status(data.status === 'UP' ? 200 : 503).json(data);
    } catch (err) {
        res.status(503).json({ status: 'DOWN', error: 'Health check failed' });
    }
});
app.get('/ready', (_req, res) => {
    res.status(200).json({ status: 'ready' });
});

// Security & parsing middlewares
app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"] } },
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    hsts: config.nodeEnv === 'production' ? { maxAge: 31536000, includeSubDomains: true, preload: true } : false,
    xssFilter: true,
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
// An empty list is any origin — the mobile apps send no Origin header, so
// nothing else would work for them. Set CORS_ORIGINS in production for the
// admin panel; validateEnv warns when it is unset there.
app.use(cors(config.corsOrigins.length ? { origin: config.corsOrigins } : undefined));

// Every request except the health probes above, which a load balancer hits
// constantly and which are registered before this on purpose.
//
// This replaced morgan('dev'), which logged the same requests a second time —
// without the request id, in raw ANSI straight to stdout, and still chattering
// under the test runner, whose stdout is also its protocol channel.
app.use(responseTimeLogger);
/**
 * Requests whose authenticity is checked against the bytes we actually received.
 *
 * A sender signs the exact payload it transmitted. Re-serialising the parsed
 * JSON can change whitespace and key order, so an HMAC computed over
 * JSON.stringify(req.body) only matches by luck — and fails closed when it does
 * not, which reads as a rejected webhook rather than as a bug.
 */
const SIGNED_WEBHOOK_PATHS = ['/webhook/razorpay', '/api/deploy'];

app.use(express.json({
    verify: (req, _res, buf) => {
        const url = req.originalUrl || '';
        if (SIGNED_WEBHOOK_PATHS.some((signed) => url.includes(signed))) {
            req.rawBody = buf;
        }
    }
}));
app.use(express.urlencoded({ extended: true }));

// Protect against NoSQL injection and XSS
app.use((req, _res, next) => {
    req.body = mongoSanitize(req.body);
    req.query = mongoSanitize(req.query);
    req.params = mongoSanitize(req.params);
    next();
});
app.use(xssClean());

// Global rate limiting for API routes
app.use('/api', apiRateLimiter);

// API Routes
app.use('/api', routes);

// Public share-link landing pages and the Android App Links manifest.
// Mounted at the root, not under /api, because these paths are what shared links
// point at and what Android matches its intent filter against.
app.use(shareLinksRoutes);

// Dev-only: serve uploaded files when nginx is not in front (production uses nginx)
if (config.nodeEnv === 'development') {
    app.use('/uploads', express.static(path.resolve(config.uploadStorageRoot)));
}

// Error Handling
app.use(errorHandler);

export default app;
