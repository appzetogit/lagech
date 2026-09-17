import test from 'node:test';
import assert from 'node:assert/strict';

import { sanitizeAdminMenuPaths } from './permissions.js';

test('sidebar access keeps admin panel paths only, once each', () => {
    assert.deepEqual(
        sanitizeAdminMenuPaths(['/admin/food/orders/all', '/admin/food/orders/all/', '/admin/food', 'javascript:alert(1)', '/elsewhere', 42]),
        ['/admin/food/orders/all', '/admin/food'],
    );
    assert.deepEqual(sanitizeAdminMenuPaths('not a list'), []);
});
