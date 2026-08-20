# Database

Postgres 16 + PostGIS. Prisma owns the schema; a few things it cannot express
live in `constraints.sql` and are appended to the init migration.

## Running the database without Docker

Docker Desktop on Windows needs a service that only starts elevated, and it
stopped itself repeatedly during this work — roughly ten times in one session,
sometimes mid-test-run. WSL runs the same Postgres without any of that.

```bash
wsl -d Ubuntu -- sudo apt-get install -y postgresql postgis postgresql-16-postgis-3
wsl -d Ubuntu -- sudo -u postgres psql -c "CREATE ROLE minto LOGIN PASSWORD 'minto' SUPERUSER;"
wsl -d Ubuntu -- sudo -u postgres createdb -O minto minto
wsl -d Ubuntu -- sudo -u postgres psql -d minto -c 'CREATE EXTENSION postgis;'
```

Then set `listen_addresses = '*'` and `port = 5434` in
`/etc/postgresql/16/main/postgresql.conf`, add
`host all all 0.0.0.0/0 scram-sha-256` to `pg_hba.conf`, and restart with
`wsl -d Ubuntu -- sudo service postgresql restart`.

5434 because Windows already has a native Postgres on 5432 and the Docker
container used 5433. WSL2 forwards localhost, so from Windows:

```
DATABASE_URL="postgresql://minto:minto@localhost:5434/minto?schema=public"
```

`wsl -d Ubuntu -- sudo service postgresql start` after a reboot. The container
in docker-compose.yml still works when Docker is behaving; this is the fallback
that does not depend on it.

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

### Planner tuning

```sql
ALTER DATABASE minto SET random_page_cost = 1.1;
```

Postgres defaults this to `4.0`, meaning "a random page read costs four
sequential ones" — true of a spinning disk, wrong by roughly 4x on SSD. The
planner therefore over-prices index access and prefers sequential scans.

Measured on 50,000 orders with `EXPLAIN (ANALYZE, BUFFERS)`:

| report query | 4.0 (default) | 1.1 |
|---|---|---|
| restaurant finance totals | 175 ms, seq scan | **43 ms, index** |
| restaurant analytics money | 16 ms, seq scan | **4 ms, index** |
| tax report, platform-wide | 470 ms | 334 ms |
| tax report, one month | 29 ms | 32 ms |

The per-restaurant queries are the ones that matter: a restaurant owner opening
their finance page and an admin opening an analytics page both joined every
order to a full sequential scan of `food_transactions`. At 1.1 the planner picks
a nested loop over the unique index on `food_transactions.orderId` instead.

Forcing the nested loop by hand gave the same plan and the same time, which is
how we know the query was fine and the cost model was not.

The wide aggregates still scan, correctly — a report that sums every restaurant
on the platform has to read every row.

Set this on production too, adjusted for the storage: 1.1 suits local and cloud
SSD; network-attached disks sit nearer 2.0. It is a server-level setting, not
schema, so it is not applied by `db:migrate`.


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
`update` it compiles to `INSERT … ON CONFLICT` and is safe.

This has bitten twice. Wallet creation hit it first — see
`insertWalletIfMissing` in `core/payments/transaction.service.js`, which uses an
explicit `ON CONFLICT DO NOTHING`. `findOrCreateUserByPhone` hit it again and
fixes it by writing an existing column back to itself (`update: { phone }`),
which is enough to get the atomic path without changing any data.

If an upsert genuinely has nothing to update, one of those two shapes is
required — `update: {}` is never correct on a path that can run concurrently.

**`updatedAt` has no database default.** Prisma sets it from the client, so any
raw `INSERT` (a data migration, another service, a `psql` session) fails the
NOT NULL. Supply it explicitly in raw SQL.
