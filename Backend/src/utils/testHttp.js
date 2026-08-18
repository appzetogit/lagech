import { once } from 'node:events';
import jwt from 'jsonwebtoken';

import app from '../app.js';
import { config } from '../config/env.js';

/**
 * A real HTTP server for the tests, on an ephemeral port.
 *
 * Everything else in this suite calls services directly, which cannot see the
 * layers in front of them: whether a route is mounted at the path the client
 * uses, whether auth runs, whether an error becomes the right status. Both
 * genuine bugs found by hand-testing the running app — a route importing a
 * module path that did not exist, and a startup check demanding a variable the
 * app no longer uses — were invisible to service tests for exactly that reason.
 *
 * `app` is imported rather than `server.js`, so none of the background jobs,
 * sockets or queues start. No supertest: listening on port 0 and using the
 * built-in fetch is the same thing in five lines.
 */
export const startTestServer = async () => {
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;

    /** Returns the status and parsed body; never throws on a non-2xx. */
    const request = async (method, path, { token, body, headers = {} } = {}) => {
        const res = await fetch(base + path, {
            method,
            headers: {
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
                ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
                ...headers,
            },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });

        const text = await res.text();
        let parsed = null;
        try {
            parsed = text ? JSON.parse(text) : null;
        } catch {
            // A 404 from Express, or a stack trace, arrives as HTML.
            parsed = { raw: text.slice(0, 200) };
        }
        return { status: res.status, body: parsed };
    };

    return {
        base,
        request,
        get: (path, opts) => request('GET', path, opts),
        post: (path, opts) => request('POST', path, opts),
        close: () => new Promise((resolve) => server.close(resolve)),
    };
};

/** An access token in the shape auth.middleware.js expects. */
export const tokenFor = ({ userId, role, adminType }) => jwt.sign(
    { userId, role, ...(adminType ? { adminType } : {}) },
    config.jwtAccessSecret,
    { expiresIn: '10m' },
);
