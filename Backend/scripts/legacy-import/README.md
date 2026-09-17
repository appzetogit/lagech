# Importing the previous system (6amMart) into Lagech

Reads a MySQL copy of the old database and writes into this system's Postgres.
Every step is idempotent: a re-run updates what it imported before (tracked in
`legacy.id_map`) instead of duplicating it. The run ends with a list of
everything skipped or changed on the way in, and exits with code 2 if anything
was skipped.

## Never against the live site

The importer only ever reads a **copy** loaded into a local MySQL, through a
read-only user (`legacy_ro`). It holds no credentials for the live Hostinger
database. For the real switch-over, one fresh dump is taken from live, once,
with the owner's go-ahead, and loaded into that local copy.

## Steps, in order

Steps run in this order whatever order they are named in.

| Step | What it brings over |
|---|---|
| `zones` | Delivery zones and their boundaries |
| `categories` | Categories and sub-categories, with images |
| `restaurants` | Restaurants, approval state, per-day hours, commission, logo and cover |
| `foods` | Dishes, variations as variants, other option groups as add-ons |
| `customers` | Customers (10-digit phones, as login matches) and addresses |
| `riders` | Riders; riders the old admin deleted become deactivated placeholders |
| `payment-details` | Restaurant and rider bank/UPI details (fills blanks only) |
| `orders` | Orders as `FOD-<old id>`, items, history, reviews, the old ledger's split |
| `balances` | Rider cash collections, withdrawals and payouts; restaurant withdrawals and payouts; opening-balance adjustments so every wallet equals the old one |
| `ratings` | Restaurant and rider star ratings recomputed from rated orders |
| `settings` | Restaurant subscriptions off (old system was commission-only); rider cash limit |

## Running it

On the server, from `Backend/`:

```sh
LEGACY_MYSQL_URL='mysql://legacy_ro:<pass>@127.0.0.1:3306/legacy_lagech' \
DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:5432/<database>?schema=public' \
UPLOAD_STORAGE_ROOT=/srv/lagech/uploads UPLOAD_BASE_URL=/uploads \
REDIS_URL= NODE_ENV=development \
node scripts/legacy-import/index.mjs zones categories restaurants foods customers riders \
  payment-details orders balances ratings settings
```

Copy the old `storage/app/public/{category,product,store,profile,delivery-man}`
folders into `$UPLOAD_STORAGE_ROOT/legacy/` first (stores' covers under
`legacy/store/cover`), or images are reported missing and imported without.

## Switch-over checklist

1. Put the old site in maintenance so no new orders arrive after the dump.
2. Take the one read-only dump from live and load it into the local MySQL copy.
3. Stop the scheduler (`pm2 stop lagech-scheduler`) before importing. Left
   running, it bills subscriptions and runs the daily payout against a
   half-imported database.
4. Run all steps into a fresh database with every migration applied
   (`prisma migrate deploy`, then `prisma/constraints.sql`).
5. Check the summary: skipped rows, open orders imported as cancelled, paid
   orders cancelled without a refund.
6. Copy the admin logins and business settings across if the database is new.
7. Clear the API response cache, or restaurant lists and menus serve the
   pre-import copy for up to ten minutes:
   `redis-cli --scan --pattern 'restaurant*' | xargs -r redis-cli del`
   (also `public_foods:*`).
8. Start everything again, then set the delivery fee bands in Fee Settings.

When packaging code on a Windows machine, use
`git -c core.autocrlf=false archive`, or shell scripts arrive with CRLF line
endings and fail on the server.
