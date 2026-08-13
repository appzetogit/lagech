# Database

Postgres 16 + PostGIS. Prisma owns the schema; a few things it cannot express
live in `constraints.sql` and are appended to the init migration.

## Local setup

```bash
docker run -d --name minto-pg \
  -e POSTGRES_USER=minto -e POSTGRES_PASSWORD=minto -e POSTGRES_DB=minto \
  -p 5433:5432 postgis/postgis:16-3.4
```

Port **5433**, not 5432 — a native Postgres service commonly already holds 5432
on Windows, and it answers first, which surfaces as a confusing
`P1000: Authentication failed` rather than a connection refusal.

```
DATABASE_URL="postgresql://minto:minto@localhost:5433/minto?schema=public"
```

Then:

```bash
npx prisma migrate deploy   # apply
npx prisma generate         # regenerate the client
npm test                    # 43 tests; the money ones need this DATABASE_URL
```

The postgis image pre-installs `postgis`, `postgis_topology`,
`postgis_tiger_geocoder` and `fuzzystrmatch`. Prisma reads any extension it did
not create as drift, so a fresh database must have them dropped first — the
init migration creates the two we actually use.

## Changing the schema

```bash
npm run db:migration:new -- add_something   # generate
#   review prisma/migrations/<stamp>_add_something/migration.sql
npm run db:migrate                          # apply + constraints + generate
```

**Do not use `prisma migrate dev`.** It compares against the *live* database,
which carries everything `constraints.sql` adds — GIN and GIST indexes Prisma
did not create. It reads those as drift and will either demand a full reset or
emit `DROP INDEX` for every one of them, leaving the only symptom as queries
quietly getting slower. `db:migration:new` diffs the migration *history* against
the schema instead, so it sees only the real change.

`db:migrate` is `migrate deploy` → `apply-constraints` → `generate`, in that
order. If it fails midway the client is stale — rerun it rather than trusting a
test run, or you get confusing "column does not exist" errors.

## What lives outside schema.prisma

`constraints.sql` holds what Prisma's schema language has no syntax for, and is
appended to the init migration:

- **CHECK constraints** — non-negative balances, positive amounts, rating bounds,
  percentage splits, zone polygons with ≥3 points
- **Geography triggers** — application code writes plain `latitude`/`longitude`;
  a trigger derives the PostGIS point. Six tables, one shared function
- **GIN indexes** on the array columns (`foodIds`, `participants`, `cuisines`, …)
  — these replace Mongo's multikey indexes, and without them every array
  containment lookup is a sequential scan
- **GIST indexes** on the geography columns, replacing the 2dsphere indexes
- **TTL replacements** — Postgres has no TTL index. Four collections expired
  automatically in Mongo; those deletes now have to be driven by the maintenance
  worker. The statements are at the bottom of the file

## Two things worth knowing before you touch this

**`prisma.upsert()` with an empty `update: {}` is not atomic.** It compiles to
`SELECT` then `INSERT` and loses the race under concurrency; with a non-empty
`update` it compiles to `INSERT … ON CONFLICT` and is safe. Wallet creation hit
this — see `insertWalletIfMissing` in `core/payments/transaction.service.js`.

**`updatedAt` has no database default.** Prisma sets it from the client, so any
raw `INSERT` (a data migration, another service, a `psql` session) fails the
NOT NULL. Supply it explicitly in raw SQL.
