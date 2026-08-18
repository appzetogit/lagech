/**
 * Refuses to run the suite when it cannot actually test anything, with one
 * message instead of forty-five stack traces.
 *
 * Almost every test here exercises real SQL against real Postgres — that is the
 * point of them, and it is how the migration's wrong-column bugs were caught.
 * They used to carry a `{ skip: !live }` guard that implied the suite would
 * quietly skip without a database. It never did: config/prisma.js throws while
 * the module is still loading, so each file failed before a single test body
 * ran.
 *
 * Making that skip real would have been worse. A CI job with no DATABASE_URL
 * would then report every test skipped and exit 0 — green, and covering
 * nothing. A suite that cannot run should say so and stop.
 */
const fail = (problem, hint) => {
    console.error(`\n${problem}\n\n${hint}\n`);
    process.exit(1);
};

if (!process.env.DATABASE_URL) {
    fail(
        'DATABASE_URL is not set, and these tests run against a real Postgres.',
        [
            '  docker compose up -d          (or see Backend/prisma/README.md)',
            '  export DATABASE_URL="postgresql://minto:minto@localhost:5433/minto?schema=public"',
        ].join('\n'),
    );
}

// scripts/test-env.mjs defaults this to true, so it can only be false if
// someone set it so deliberately. The OTP tests assert on the fixed code that
// switch enables, and would otherwise fail for a reason nothing explains.
if (process.env.USE_DEFAULT_OTP === 'false') {
    fail(
        'USE_DEFAULT_OTP is false, which the OTP tests cannot work against.',
        '  unset USE_DEFAULT_OTP         (the suite defaults it to true)',
    );
}
