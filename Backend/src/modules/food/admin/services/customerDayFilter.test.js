import test from 'node:test';
import assert from 'node:assert/strict';

import { dayWindow } from './adminCustomer.service.js';

/**
 * Turning the admin's date box into a range.
 *
 * The panel sends `yyyy-mm-dd`. Compared as an instant that is midnight, so a
 * filter built straight from it matches only customers who happened to register
 * on the stroke of the hour -- which reads as "the filter returns nothing"
 * rather than as a bug.
 */

test('a date covers the whole day, not the instant of midnight', () => {
    const w = dayWindow('2026-09-05');
    assert.equal(w.gte.getHours(), 0);
    assert.equal(w.gte.getMinutes(), 0);
    assert.equal(w.gte.getSeconds(), 0);
    assert.equal(w.gte.getMilliseconds(), 0);
    assert.equal(w.lte.getHours(), 23);
    assert.equal(w.lte.getMinutes(), 59);
    assert.equal(w.lte.getSeconds(), 59);
    assert.equal(w.lte.getMilliseconds(), 999);
});

test('the window is a single day and does not spill into the next', () => {
    const { gte, lte } = dayWindow('2026-09-05');
    assert.equal(gte.getDate(), lte.getDate());
    assert.ok(lte - gte < 24 * 60 * 60 * 1000);
});

test('no date means no filter, not a filter matching nothing', () => {
    // Returning a window here would quietly narrow every unfiltered list.
    for (const empty of ['', '   ', null, undefined]) {
        assert.equal(dayWindow(empty), null, JSON.stringify(empty));
    }
});

test('an unparseable date is ignored rather than returning an empty list', () => {
    for (const junk of ['tomorrow', '05-09-2026-xx', 'dd/mm/yyyy', '{}']) {
        assert.equal(dayWindow(junk), null, junk);
    }
});

test('the boundary instants are inside the window', () => {
    const { gte, lte } = dayWindow('2026-09-05');
    // Prisma compares inclusively on gte/lte, so a customer created at exactly
    // midnight or at the last millisecond of the day still matches.
    assert.ok(gte <= gte && gte <= lte);
    assert.equal(new Date(gte.getTime() - 1) < gte, true);
    assert.equal(new Date(lte.getTime() + 1) > lte, true);
});

test('a full timestamp is accepted and still means that whole day', () => {
    // The panel sends a bare date, but a hand-built request or an export link
    // can carry a time; it should select the day, not a one-millisecond slice.
    const w = dayWindow('2026-09-05T14:32:11.500Z');
    assert.equal(w.gte.getHours(), 0);
    assert.equal(w.lte.getHours(), 23);
});
