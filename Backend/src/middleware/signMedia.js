import { signMediaUrls, signingEnabled } from '../services/mediaSigning.service.js';

/**
 * Signs S3 media urls in every JSON response.
 *
 * This wraps res.json rather than sitting in sendResponse because only about a
 * sixth of the responses in this codebase go through that helper -- the other
 * three hundred call res.json directly. Wrapping the method catches both, and
 * anything added later, without touching a single controller.
 *
 * Mount it before the routes.
 */
export const signMediaResponses = (req, res, next) => {
    if (!signingEnabled()) return next();

    const original = res.json.bind(res);

    res.json = (body) => {
        // Signing is async and res.json is not, so the send is deferred by a
        // tick. Express does not care, and callers only ever use the return
        // value for chaining, which still works because `res` is returned now.
        signMediaUrls(body)
            .then((signed) => original(signed))
            // Never let a signing problem cost the client its response; the
            // service already logs, and an unsigned url still renders.
            .catch(() => original(body));
        return res;
    };

    return next();
};
