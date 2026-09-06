import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The ordering half of hydrateRestaurants.
 *
 * `WHERE id IN (...)` has no inherent order, so the rows come back from
 * Postgres in an arbitrary one and have to be put back into the order the
 * admin arranged. Extracted here as the pure sort so it can be checked without
 * a database -- getting it wrong shuffles the Recommended For You rail on the
 * customer home page, which is what it used to do.
 */
const orderByIds = (rows, wanted) => {
    const position = new Map(wanted.map((id, index) => [id, index]));
    return rows.sort(
        (a, b) => (position.get(String(a.id)) ?? 0) - (position.get(String(b.id)) ?? 0),
    );
};

const ids = (rows) => rows.map((r) => r.id);

test('rows come back in the order the ids were given, not the order the database returned', () => {
    const wanted = ['a', 'b', 'c', 'd'];
    // Deliberately scrambled, the way an unordered IN query can return them.
    const fromDb = [{ id: 'c' }, { id: 'a' }, { id: 'd' }, { id: 'b' }];

    assert.deepEqual(ids(orderByIds(fromDb, wanted)), ['a', 'b', 'c', 'd']);
});

test('an already-correct order is left alone', () => {
    const wanted = ['a', 'b', 'c'];
    const fromDb = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];

    assert.deepEqual(ids(orderByIds(fromDb, wanted)), ['a', 'b', 'c']);
});

test('ids that returned no row simply close the gap', () => {
    // A restaurant can be unapproved or deleted since it was picked, so the
    // query drops it. The ones that survive keep their relative order.
    const wanted = ['a', 'gone', 'b', 'alsogone', 'c'];
    const fromDb = [{ id: 'c' }, { id: 'b' }, { id: 'a' }];

    assert.deepEqual(ids(orderByIds(fromDb, wanted)), ['a', 'b', 'c']);
});

test('a single row is unchanged', () => {
    assert.deepEqual(ids(orderByIds([{ id: 'only' }], ['only'])), ['only']);
});

test('an empty list stays empty', () => {
    assert.deepEqual(ids(orderByIds([], ['a', 'b'])), []);
});

test('a row not in the wanted list sorts first rather than throwing', () => {
    // Should not happen -- the query filters by these very ids -- but a missing
    // position must not produce NaN and scramble the whole comparison.
    const wanted = ['a', 'b'];
    const fromDb = [{ id: 'b' }, { id: 'stranger' }, { id: 'a' }];

    const result = ids(orderByIds(fromDb, wanted));
    assert.equal(result.length, 3);
    // 'a' still precedes 'b'; that is the guarantee that matters.
    assert.ok(result.indexOf('a') < result.indexOf('b'));
});

test('numeric-looking ids are compared as strings, not coerced', () => {
    const wanted = ['10', '9', '100'];
    const fromDb = [{ id: '100' }, { id: '10' }, { id: '9' }];

    assert.deepEqual(ids(orderByIds(fromDb, wanted)), ['10', '9', '100']);
});
