import { exec } from 'child_process';

import { config } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { verifyDeploySignature } from '../utils/deploySignature.js';

/**
 * The /api/deploy webhook.
 *
 * It runs a shell script on the server, so everything here fails closed: no
 * secret means no route, and an unverifiable request is refused rather than
 * given the benefit of the doubt.
 *
 * Lives in its own module so it can be mounted onto a bare app in a test. It
 * used to sit inline in startServer(), where nothing could reach it.
 *
 * `runDeploy` is injectable for the same reason — a test must be able to prove
 * the guard admits a correct signature without actually running deploy.sh.
 */
const defaultRunDeploy = (done) => exec('cd ~ && ./deploy.sh', done);

export const mountDeployWebhook = (app, {
    secret = config.deploySecret,
    runDeploy = defaultRunDeploy,
} = {}) => {
    if (!secret) {
        logger.warn('DEPLOY_SECRET is not set - the /api/deploy webhook is not mounted.');
        return false;
    }

    app.post('/api/deploy', (req, res) => {
        // The signature covers the bytes the sender hashed. Without them there
        // is nothing to verify against, and guessing with a re-serialised body
        // would make the check pass or fail on formatting.
        if (!req.rawBody) {
            logger.warn('Deploy webhook: no raw body captured, cannot verify the signature.');
            return res.status(403).send('Unauthorized');
        }

        const ok = verifyDeploySignature({
            payload: req.rawBody,
            signature: req.headers['x-hub-signature-256'],
            secret,
        });
        if (!ok) return res.status(403).send('Unauthorized');

        runDeploy((err, stdout) => {
            if (err) {
                logger.error(`Deploy failed: ${err.message}`);
                return res.status(500).send('Deploy failed');
            }
            if (stdout) logger.info(stdout);
            res.send('Deploy success');
        });
    });

    return true;
};
