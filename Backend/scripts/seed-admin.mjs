/**
 * Creates or updates a super admin.
 *
 * Hashes through the application's own hashAdminPassword rather than calling
 * bcrypt here, so the stored value always matches what login verifies against
 * -- including the salt-round count, which is configurable.
 *
 * Credentials come from the environment, never from this file: a password
 * committed to the repository is a password published to everyone with read
 * access, and it long outlives whatever it was created for.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... node scripts/seed-admin.mjs
 *
 * Idempotent: re-running it resets the password of an existing account rather
 * than failing on the unique email.
 */
import 'dotenv/config';
import { prisma } from '../src/config/prisma.js';
import { hashAdminPassword } from '../src/core/auth/adminPassword.util.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || '';
const name = process.env.ADMIN_NAME || 'Administrator';

if (!email || !password) {
    console.error('ADMIN_EMAIL and ADMIN_PASSWORD are both required.');
    process.exit(1);
}

const hash = await hashAdminPassword(password);

// permissions stays {} on purpose: a super_admin's effective permissions are
// computed at login from ADMIN_FULL_PERMISSIONS, so a stored copy would only
// drift as sections are added.
const admin = await prisma.foodAdmin.upsert({
    where: { email },
    create: { email, password: hash, name, adminType: 'super_admin', role: 'ADMIN', isActive: true },
    update: { password: hash, isActive: true, isDeleted: false },
});

console.log(`admin ready: ${admin.email}  type=${admin.adminType}  id=${admin.id}`);
await prisma.$disconnect();
