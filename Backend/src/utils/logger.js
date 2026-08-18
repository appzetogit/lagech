// Node sets this in every `node --test` child. Those children talk to the
// runner over their own stdout, and heavy interleaved logging from concurrent
// work corrupts that stream ("Unable to deserialize cloned data"), failing a
// whole file that otherwise passes. Tests assert on behaviour, not on logs.
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);
const stamp = () => new Date().toLocaleTimeString();

// Variadic, because the usual call is a message and the error that caused it.
// Taking a single argument meant `logger.error('upload failed:', err)` printed
// the message and dropped the error — which is the half worth having.
export const logger = {
    info: (...args) => { if (!quiet) console.log(`✅ [INFO] ${stamp()}:`, ...args); },
    error: (...args) => { if (!quiet) console.error(`❌ [ERROR] ${stamp()}:`, ...args); },
    warn: (...args) => { if (!quiet) console.warn(`⚠️ [WARN] ${stamp()}:`, ...args); }
};
