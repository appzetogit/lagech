/**
 * Prints a DATABASE_URL carrying a freshly signed Aurora IAM token.
 *
 * The Prisma CLI -- `migrate deploy`, `db pull`, `studio` -- connects from the
 * URL and knows nothing about driver adapters, so it cannot sign its own token
 * the way the running server does. It gets one minted here instead, valid for
 * 15 minutes, which is ample for a migration and expires on its own afterwards.
 *
 * Nothing is written to disk. Use it for the length of one command:
 *
 *   DATABASE_URL="$(node scripts/iam-database-url.mjs)" npm run db:migrate
 *
 * Credentials come from the EC2 instance role, so this only works on the server.
 */
import 'dotenv/config';
import { Signer } from '@aws-sdk/rds-signer';

const raw = process.env.DATABASE_URL;
if (!raw) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
}

const url = new URL(raw);
const port = Number(url.port) || 5432;
const username = decodeURIComponent(url.username);

const signer = new Signer({
    region: process.env.AWS_REGION || 'ap-south-1',
    hostname: url.hostname,
    port,
    username,
});

// The token contains '&', '=' and '/', every one of which would otherwise be
// read as URL structure rather than as part of the password.
url.password = encodeURIComponent(await signer.getAuthToken());

process.stdout.write(url.toString());
