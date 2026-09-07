import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The window-clipping arithmetic behind hours-based incentives.
 *
 * Mirrors onlineMinutesInWindow in adminEarningAddon.service.js and the same
 * calculation in the rider's progress view. Kept pure here because it decides
 * whether a rider is paid an incentive: counting a shift whole rather than
 * clipped would let time worked before an offer started earn that offer.
 */
const onlineMinutes = (sessions, from, to, now) => {
    const start = from.getTime();
    const end = to.getTime();
    const nowMs = now.getTime();

    const ms = sessions.reduce((sum, session) => {
        const openedAt = Math.max(session.wentOnlineAt.getTime(), start);
        const closedAt = Math.min(
            session.wentOfflineAt ? session.wentOfflineAt.getTime() : nowMs,
            end,
        );
        return sum + Math.max(0, closedAt - openedAt);
    }, 0);

    return Math.round(ms / 60000);
};

const at = (iso) => new Date(iso);
const WINDOW_FROM = at('2026-09-01T00:00:00Z');
const WINDOW_TO = at('2026-09-08T00:00:00Z');
const NOW = at('2026-09-05T12:00:00Z');

test('a shift fully inside the window counts in full', () => {
    const sessions = [{ wentOnlineAt: at('2026-09-02T09:00:00Z'), wentOfflineAt: at('2026-09-02T17:00:00Z') }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 8 * 60);
});

test('shifts add up across days', () => {
    const sessions = [
        { wentOnlineAt: at('2026-09-02T09:00:00Z'), wentOfflineAt: at('2026-09-02T13:00:00Z') },
        { wentOnlineAt: at('2026-09-03T09:00:00Z'), wentOfflineAt: at('2026-09-03T14:30:00Z') },
    ];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 4 * 60 + 5 * 60 + 30);
});

test('a shift that began before the window only counts the part inside it', () => {
    // Starts 6h before the offer, runs 4h into it. Only the 4h should pay.
    const sessions = [{ wentOnlineAt: at('2026-08-31T18:00:00Z'), wentOfflineAt: at('2026-09-01T04:00:00Z') }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 4 * 60);
});

test('a shift that runs past the window end is truncated at the end', () => {
    const sessions = [{ wentOnlineAt: at('2026-09-07T22:00:00Z'), wentOfflineAt: at('2026-09-08T06:00:00Z') }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 2 * 60);
});

test('a shift still open is measured up to now, not treated as zero', () => {
    const sessions = [{ wentOnlineAt: at('2026-09-05T09:00:00Z'), wentOfflineAt: null }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 3 * 60);
});

test('a shift entirely outside the window contributes nothing, not a negative', () => {
    // Max(0, ...) is what stops this subtracting from the total.
    const sessions = [{ wentOnlineAt: at('2026-08-20T09:00:00Z'), wentOfflineAt: at('2026-08-20T17:00:00Z') }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 0);
});

test('one shift outside the window cannot cancel out another inside it', () => {
    const sessions = [
        { wentOnlineAt: at('2026-08-20T09:00:00Z'), wentOfflineAt: at('2026-08-20T17:00:00Z') },
        { wentOnlineAt: at('2026-09-02T09:00:00Z'), wentOfflineAt: at('2026-09-02T17:00:00Z') },
    ];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 8 * 60);
});

test('a shift spanning the whole window counts the window, not the shift', () => {
    const sessions = [{ wentOnlineAt: at('2026-08-01T00:00:00Z'), wentOfflineAt: at('2026-10-01T00:00:00Z') }];
    assert.equal(onlineMinutes(sessions, WINDOW_FROM, WINDOW_TO, NOW), 7 * 24 * 60);
});

test('no shifts is zero minutes', () => {
    assert.equal(onlineMinutes([], WINDOW_FROM, WINDOW_TO, NOW), 0);
});
