/**
 * Module hooks for --dry-run: every import of src/config/prisma.js -- by the
 * import steps and by the app services they call -- resolves to the dry-run
 * client instead, so all of it runs inside the one transaction that is rolled
 * back. Registered before anything that touches the database is loaded.
 */
let shimUrl;

export async function initialize(data) {
    shimUrl = data.shimUrl;
}

export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    // The shim's own import of the real client carries "?real" and passes through.
    if (shimUrl && result.url.endsWith('/src/config/prisma.js')) {
        return { ...result, url: shimUrl, shortCircuit: true };
    }
    return result;
}
