import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { io as connect } from 'socket.io-client';
import { initSocket, rooms } from './socket.js';
import { signAccessToken } from '../core/auth/token.util.js';

/**
 * The admin panel's realtime path, over a real Socket.IO server: the admin
 * Orders page and the layout-level alert connect exactly like this. Before the
 * fix they sent no token and used <origin>/api/v1, and never connected.
 */

let server;
let origin;
let io;

test.before(async () => {
    server = http.createServer();
    io = await initSocket(server);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
    await new Promise((resolve) => io.close(() => resolve()));
});

/** Connects like the admin page; resolves with the socket or the connect error. */
const connectAs = (url, auth) => new Promise((resolve) => {
    const socket = connect(url, { transports: ['websocket'], reconnection: false, timeout: 3000, ...(auth ? { auth } : {}) });
    socket.on('connect', () => resolve({ socket }));
    socket.on('connect_error', (err) => { socket.close(); resolve({ error: err.message }); });
});

const nextEvent = (socket, name, ms = 2000) => new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    socket.once(name, (payload) => { clearTimeout(timer); resolve(payload); });
});

test('the old admin socket (no token) is refused', async () => {
    const { error } = await connectAs(origin);
    assert.equal(error, 'AUTH_MISSING');
});

test('the old admin socket URL (/api/v1) is a namespace the server does not have', async () => {
    const token = signAccessToken({ userId: 'admin-1', role: 'ADMIN' });
    const { error } = await connectAs(`${origin}/api/v1`, { token });
    assert.match(error, /Invalid namespace/);
});

test('an admin socket gets admin_new_order and order_status_update; a restaurant socket does not', async () => {
    const adminToken = signAccessToken({ userId: 'admin-1', role: 'ADMIN' });
    // A function, as the admin page passes it, so reconnects send the current token.
    const admin = await connectAs(origin, (cb) => cb({ token: adminToken }));
    assert.ok(admin.socket, `admin connected: ${admin.error}`);
    const restaurant = await connectAs(origin, { token: signAccessToken({ userId: 'r-1', role: 'RESTAURANT' }) });
    assert.ok(restaurant.socket);

    try {
        const gotNew = nextEvent(admin.socket, 'admin_new_order');
        const leaked = nextEvent(restaurant.socket, 'admin_new_order', 500);
        io.to(rooms.admin()).emit('admin_new_order', { orderId: 'FOD-1', restaurantName: 'Test' });
        assert.deepEqual(await gotNew, { orderId: 'FOD-1', restaurantName: 'Test' });
        assert.equal(await leaked, null, 'not sent to restaurants');

        // Status updates go to the customer and the admin room in one emit, as the order services do.
        const gotStatus = nextEvent(admin.socket, 'order_status_update');
        io.to([rooms.user('u-1'), rooms.admin()]).emit('order_status_update', { orderId: 'FOD-1', orderStatus: 'confirmed' });
        assert.equal((await gotStatus)?.orderStatus, 'confirmed');
    } finally {
        admin.socket.close();
        restaurant.socket.close();
    }
});
