import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import express from 'express';
import { once } from 'node:events';

import { mountDeployWebhook } from './deployWebhook.js';

/**
 * The /api/deploy webhook, end to end over real HTTP.
 *
 * The signature is verified against the bytes the sender transmitted. It used
 * to be computed over JSON.stringify(req.body) — the parsed body re-serialised
 * — which only matches when the sender happened to use the same formatting.
 * The whitespace test below is the one that fails under the old approach.
 *
 * No database, so these run everywhere.
 */
const SECRET = 'deploy-test-secret';

const sign = (payload, secret = SECRET) =>
    `sha256=${crypto.createHmac('sha256', secret).update(payload).digest('hex')}`;

/** An app wired exactly as src/app.js wires the real one. */
const startApp = async ({ secret = SECRET, runDeploy } = {}) => {
    const app = express();
    app.use(express.json({
        verify: (req, _res, buf) => {
            if ((req.originalUrl || '').includes('/api/deploy')) req.rawBody = buf;
        },
    }));

    let deployRuns = 0;
    mountDeployWebhook(app, {
        secret,
        runDeploy: runDeploy ?? ((done) => { deployRuns += 1; done(null, 'ok'); }),
    });

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}/api/deploy`;

    return {
        deployRuns: () => deployRuns,
        post: async (rawPayload, signature) => {
            const res = await fetch(base, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(signature ? { 'X-Hub-Signature-256': signature } : {}),
                },
                body: rawPayload,
            });
            return { status: res.status, text: await res.text() };
        },
        close: () => new Promise((resolve) => server.close(resolve)),
    };
};

test('a correctly signed payload reaches the deploy script', async () => {
    const app = await startApp();
    try {
        const payload = '{"ref":"refs/heads/main"}';
        const res = await app.post(payload, sign(payload));

        assert.equal(res.status, 200);
        assert.equal(app.deployRuns(), 1);
    } finally {
        await app.close();
    }
});

test('the signature is checked against the bytes sent, not the re-serialised body', async () => {
    const app = await startApp();
    try {
        // Valid JSON that does not survive a parse-and-stringify round trip:
        // the spaces disappear and the key order is the sender's, not ours.
        const payload = '{"zeta": 1,  "alpha":   2}';
        assert.notEqual(JSON.stringify(JSON.parse(payload)), payload, 'the fixture must differ');

        const res = await app.post(payload, sign(payload));

        // The old implementation hashed JSON.stringify(req.body) and rejected
        // this — a genuine delivery refused because of whitespace.
        assert.equal(res.status, 200);
        assert.equal(app.deployRuns(), 1);
    } finally {
        await app.close();
    }
});

test('a signature over different bytes is refused', async () => {
    const app = await startApp();
    try {
        const sent = '{"ref":"refs/heads/main"}';
        const signedOther = sign('{"ref":"refs/heads/attacker"}');

        assert.equal((await app.post(sent, signedOther)).status, 403);
        assert.equal((await app.post(sent, sign(sent, 'a-different-secret'))).status, 403);
        assert.equal((await app.post(sent, 'sha256=deadbeef')).status, 403);
        assert.equal((await app.post(sent)).status, 403);

        // Nothing ran.
        assert.equal(app.deployRuns(), 0);
    } finally {
        await app.close();
    }
});

test('a body that was never captured cannot be verified, so it is refused', async () => {
    // The rawBody capture keys on the URL. An app that forgot to add this path
    // to that list must refuse everything rather than fall back to guessing.
    const app = express();
    app.use(express.json()); // no verify hook, so no req.rawBody
    let ran = 0;
    mountDeployWebhook(app, { secret: SECRET, runDeploy: (done) => { ran += 1; done(null, ''); } });

    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}/api/deploy`;

    try {
        const payload = '{"ref":"refs/heads/main"}';
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': sign(payload) },
            body: payload,
        });

        assert.equal(res.status, 403, 'an unverifiable request must not deploy');
        assert.equal(ran, 0);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('without a secret the route does not exist', async () => {
    const app = await startApp({ secret: '' });
    try {
        const payload = '{}';
        const res = await app.post(payload, sign(payload));

        // 404, not 403: an unset secret means no endpoint, never an open one.
        assert.equal(res.status, 404);
        assert.equal(app.deployRuns(), 0);
    } finally {
        await app.close();
    }
});

test('a failing deploy script is a 500, not a silent success', async () => {
    const app = await startApp({
        runDeploy: (done) => done(new Error('deploy.sh exited 1')),
    });
    try {
        const payload = '{"ref":"refs/heads/main"}';
        const res = await app.post(payload, sign(payload));

        // The old handler answered 200 'Deploy failed', so a webhook sender saw
        // a success it could not distinguish from a real one.
        assert.equal(res.status, 500);
    } finally {
        await app.close();
    }
});
