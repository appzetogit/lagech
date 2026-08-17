// Node sets this in every `node --test` child. Those children talk to the
// runner over their own stdout, and heavy interleaved logging from concurrent
// work corrupts that stream ("Unable to deserialize cloned data"), failing a
// whole file that otherwise passes. Tests assert on behaviour, not on logs.
const quiet = Boolean(process.env.NODE_TEST_CONTEXT);
const stamp = () => new Date().toLocaleTimeString();

export const logger = {
    info: (msg) => { if (!quiet) console.log(`✅ [INFO] ${stamp()}: ${msg}`); },
    error: (msg) => { if (!quiet) console.error(`❌ [ERROR] ${stamp()}: ${msg}`); },
    warn: (msg) => { if (!quiet) console.warn(`⚠️ [WARN] ${stamp()}: ${msg}`); }
};
