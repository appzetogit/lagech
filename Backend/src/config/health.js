import { config } from './env.js';
import { prisma } from './prisma.js';
import { getRedisClient } from './redis.js';

/**
 * Minimal health check: server, Postgres, Redis (if enabled).
 * Does not expose internal secrets.
 */
export const healthCheck = async () => {
    // An actual round trip, not a connection flag. Mongoose exposed
    // `readyState`, which reported "connected" for a socket that was still open
    // to a server that had stopped answering — the check passed while every
    // query timed out. Prisma pools lazily and has no equivalent flag anyway.
    let postgresOk = false;
    try {
        await prisma.$queryRaw`SELECT 1`;
        postgresOk = true;
    } catch {
        postgresOk = false;
    }

    let redisOk = 'disabled';
    if (config.redisEnabled) {
        const client = getRedisClient();
        redisOk = client ? 'ok' : 'unavailable';
        if (client) {
            try {
                await client.ping();
            } catch {
                redisOk = 'unavailable';
            }
        }
    }

    return {
        // Reports DOWN when the database is unreachable. It used to answer UP
        // unconditionally, so a load balancer kept routing to an instance that
        // could not serve a single request.
        status: postgresOk ? 'UP' : 'DOWN',
        postgres: postgresOk ? 'connected' : 'disconnected',
        redis: redisOk,
    };
};
