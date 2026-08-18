import bcrypt from 'bcryptjs';

import { prisma } from '../src/config/prisma.js';
import { config } from '../src/config/env.js';
import { ADMIN_FULL_PERMISSIONS } from '../src/constants/permissions.js';

/**
 * Creates or repairs the first super admin.
 *
 * A fresh database has no admin and no way to sign in and make one, so this is
 * the way in. It replaces a Mongo script that stopped working when the last
 * model was dropped, and which took the password as argv[2] — where it stayed
 * in the shell history of whoever ran it.
 *
 * Re-running it on an existing email resets that admin's password and restores
 * their access, which is the other reason to reach for it.
 *
 *   ADMIN_PASSWORD='…' node scripts/create-admin.mjs you@example.com "Your Name"
 */
const [, , emailArg, nameArg = 'Admin User'] = process.argv;
const email = (emailArg || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';

const fail = (message) => {
    console.error(message);
    process.exit(1);
};

if (!email || !password) {
    fail(
        'Usage: ADMIN_PASSWORD=\'…\' node scripts/create-admin.mjs <email> [name]\n\n'
        + 'The password comes from the environment so it stays out of the shell history.',
    );
}
// Short enough to brute force is short enough to refuse, and this account can
// see every order and every payout in the system.
if (password.length < 12) fail('Choose a password of at least 12 characters.');

const hash = await bcrypt.hash(password, config.bcryptSaltRounds);

const existing = await prisma.foodAdmin.findUnique({ where: { email }, select: { id: true } });

const admin = await prisma.foodAdmin.upsert({
    where: { email },
    // An admin who is locked out is usually why someone runs this, so the
    // update clears the flags that lock them out as well as the password.
    update: { password: hash, isActive: true, isDeleted: false },
    create: {
        email,
        password: hash,
        name: nameArg.trim(),
        adminType: 'super_admin',
        permissions: ADMIN_FULL_PERMISSIONS,
    },
    select: { id: true, email: true, adminType: true },
});

console.log(`${existing ? 'Updated' : 'Created'} ${admin.adminType} ${admin.email} (${admin.id})`);
await prisma.$disconnect();
