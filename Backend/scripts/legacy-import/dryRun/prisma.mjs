/**
 * The Prisma client as the import sees it during --dry-run.
 *
 * Everything goes to the open dry-run transaction while one is active. Outside
 * it the real client is reachable for reads only: a write there would not be
 * rolled back, so it throws instead. Nested $transaction calls (the order step
 * and the restaurant service use them) run inside the same transaction rather
 * than opening a second one that would commit on its own.
 */
import { prisma as realClient, connectDB, disconnectDB } from '../../../src/config/prisma.js?real';

export { connectDB, disconnectDB };
export const realPrisma = realClient;

const WRITES = new Set([
    'create', 'createMany', 'createManyAndReturn', 'update', 'updateMany', 'updateManyAndReturn',
    'upsert', 'delete', 'deleteMany',
]);
const RAW_WRITES = new Set(['$executeRaw', '$executeRawUnsafe', '$transaction', '$runCommandRaw']);

const refuse = (what) => {
    throw new Error(`dry run: refused ${what} outside the dry-run transaction (it would not be rolled back)`);
};

/** The real client with every write refused. */
const readOnly = new Proxy(realClient, {
    get(target, key) {
        if (RAW_WRITES.has(key)) return () => refuse(String(key));
        const value = target[key];
        if (typeof key === 'string' && !key.startsWith('$') && value && typeof value === 'object') {
            return new Proxy(value, {
                get(delegate, method) {
                    if (WRITES.has(method)) return () => refuse(`${key}.${String(method)}`);
                    const fn = delegate[method];
                    return typeof fn === 'function' ? fn.bind(delegate) : fn;
                },
            });
        }
        return typeof value === 'function' ? value.bind(target) : value;
    },
});

/** A transaction client that also answers $transaction, by running inside itself. */
export const nestable = (tx) => {
    const wrapped = new Proxy(tx, {
        get(target, key) {
            if (key === '$transaction') {
                return async (arg) => {
                    if (typeof arg === 'function') return arg(wrapped);
                    const results = [];
                    for (const operation of arg) results.push(await operation);
                    return results;
                };
            }
            if (key === '$connect' || key === '$disconnect') return async () => {};
            const value = target[key];
            return typeof value === 'function' ? value.bind(target) : value;
        },
    });
    return wrapped;
};

let active = null;

/** Route everything to `tx` (a nestable transaction client), or back to read-only with null. */
export const setActive = (tx) => {
    active = tx;
};

export const prisma = new Proxy({}, {
    get(_, key) {
        if (key === '$disconnect') return () => realClient.$disconnect();
        const target = active || readOnly;
        return target[key];
    },
});
