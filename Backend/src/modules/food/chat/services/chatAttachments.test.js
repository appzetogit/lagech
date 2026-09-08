import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * What a message is allowed to carry.
 *
 * Mirrors cleanAttachments in chat.service.js, which cannot be imported here
 * without a database connection behind it. The rule that matters is the path:
 * it is the only field taken from the client, it is joined onto the uploads
 * root, and the url every party in the conversation clicks is built from it.
 */
const MAX_ATTACHMENTS = 5;
const buildPublicUrl = (p) => `/uploads/${String(p).replace(/^\/+/, '')}`;

const cleanAttachments = (raw) => {
    if (raw === undefined || raw === null) return [];
    if (!Array.isArray(raw)) throw new Error('attachments must be a list');
    if (raw.length > MAX_ATTACHMENTS) throw new Error(`At most ${MAX_ATTACHMENTS} attachments per message`);

    return raw.map((item) => {
        const path = String(item?.path || '').trim();
        if (!/^[A-Za-z0-9][A-Za-z0-9._\-/]{0,200}$/.test(path) || path.includes('..')) {
            throw new Error('Attachment path is not one this server issued');
        }
        return {
            url: buildPublicUrl(path),
            path,
            mimeType: String(item?.mimeType || ''),
            size: Number(item?.size) || 0,
            name: String(item?.name || '').slice(0, 120),
        };
    });
};

const rejects = (raw) => {
    try {
        cleanAttachments(raw);
        return null;
    } catch (err) {
        return err.message;
    }
};

test('no attachments is not an error', () => {
    // Most messages are text, and an absent field must not become a failure.
    assert.deepEqual(cleanAttachments(undefined), []);
    assert.deepEqual(cleanAttachments(null), []);
    assert.deepEqual(cleanAttachments([]), []);
});

test('a path that climbs out of the uploads root is refused', () => {
    for (const path of ['../secrets/key.pem', 'chat/../../etc/passwd', 'chat/..%2f']) {
        assert.ok(rejects([{ path }]), path);
    }
});

test('an absolute path or a url in the path field is refused', () => {
    for (const path of ['/etc/passwd', 'http://evil.test/x.png', '//evil.test/x.png']) {
        assert.ok(rejects([{ path }]), path);
    }
});

test('the url is rebuilt from the path, never taken from the client', () => {
    // Otherwise a message becomes a way to put an arbitrary link, styled as an
    // image from the platform, in front of a customer.
    const [out] = cleanAttachments([
        { path: 'chat/abc123.webp', url: 'https://evil.test/phish.png' },
    ]);
    assert.equal(out.url, '/uploads/chat/abc123.webp');
});

test('only the fields we store survive', () => {
    const [out] = cleanAttachments([
        { path: 'chat/a.webp', mimeType: 'image/webp', size: 1234, name: 'a.webp', isAdmin: true },
    ]);
    assert.deepEqual(Object.keys(out).sort(), ['mimeType', 'name', 'path', 'size', 'url']);
});

test('a long filename is cut rather than stored whole', () => {
    const [out] = cleanAttachments([{ path: 'chat/a.webp', name: 'x'.repeat(500) }]);
    assert.equal(out.name.length, 120);
});

test('a size that is not a number becomes zero', () => {
    const [out] = cleanAttachments([{ path: 'chat/a.webp', size: 'lots' }]);
    assert.equal(out.size, 0);
});

test('more than five attachments is refused', () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ path: `chat/${i}.webp` }));
    assert.match(rejects(many) || '', /At most 5/);
});

test('something that is not a list is refused', () => {
    assert.ok(rejects('chat/a.webp'));
    assert.ok(rejects({ path: 'chat/a.webp' }));
});

test('an ordinary upload passes through', () => {
    const [out] = cleanAttachments([
        { path: 'chat/1788866748-abc.webp', mimeType: 'image/webp', size: 84213, name: 'photo.jpg' },
    ]);
    assert.equal(out.url, '/uploads/chat/1788866748-abc.webp');
    assert.equal(out.mimeType, 'image/webp');
    assert.equal(out.size, 84213);
});
