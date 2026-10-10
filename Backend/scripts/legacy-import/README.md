# Importing the previous system (6amMart) into Lagech

Reads a MySQL copy of the old database and writes into this system's Postgres.
Every step is idempotent: a re-run updates what it imported before (tracked in
`legacy.id_map`) instead of duplicating it. Once the new system is in use,
catch up with `--sync` instead (below), which keeps what was edited here. The run ends with a list of
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
| `zones` | Delivery zones and their boundaries, the Cash On Delivery / Digital Payment switches and the default flag |
| `categories` | Categories and sub-categories, with images |
| `restaurants` | Restaurants, approval state, per-day hours, commission, logo and cover |
| `foods` | Dishes, variations as variants, other option groups as add-ons |
| `nutrition` | Each dish's nutrition tags (`nutritions` / `item_nutrition`) and allergens (`allergies` / `item_allergy`, when present) |
| `customers` | Customers (10-digit phones, as login matches) and addresses |
| `riders` | Riders; riders the old admin deleted become deactivated placeholders |
| `payment-details` | Restaurant and rider bank/UPI details (fills blanks only) |
| `withdrawal-methods` | Payout method types and their fields; each restaurant's and rider's chosen method (keeps a choice made here) |
| `orders` | Orders as `FOD-<old id>`, items, history, reviews, the old ledger's split |
| `balances` | Rider cash collections, withdrawals and payouts; restaurant withdrawals and payouts; opening-balance adjustments so every wallet equals the old one |
| `ratings` | Restaurant and rider star ratings recomputed from rated orders |
| `coupons` | Food-module coupons with their type (default, store wise, zone wise, free delivery, first order), title, dates (whole IST days), per-customer limit and customer restriction; store/zone/customer ids mapped through `legacy.id_map`. A vendor's coupon becomes a restaurant-funded store wise coupon. Imported orders that used a code are linked so Total Uses counts them (run after `orders`). A coupon whose restaurants, zones or customers were not imported comes in switched off |
| `banners` | Food-module home banners (`banners`) with title, zone, type (store wise → restaurant, item wise → dish, default → link), target, Featured and status; images from `legacy/banner` (run after `zones restaurants foods`) |
| `newsletter` | Newsletter subscribers (Subscribed Mail List), emails lower-cased |
| `settings` | Restaurant subscriptions off (old system was commission-only); rider cash limit |
| `social-media` | Social media links (name, link, on/off) |

## Running it

On the server, from `Backend/`:

```sh
LEGACY_MYSQL_URL='mysql://legacy_ro:<pass>@127.0.0.1:3306/legacy_lagech' \
DATABASE_URL='postgresql://<user>:<pass>@127.0.0.1:5432/<database>?schema=public' \
UPLOAD_STORAGE_ROOT=/srv/lagech/uploads UPLOAD_BASE_URL=/uploads \
REDIS_URL= NODE_ENV=development \
node scripts/legacy-import/index.mjs zones categories restaurants foods nutrition customers riders \
  payment-details orders balances ratings coupons settings
```

Copy the old `storage/app/public/{category,product,store,profile,delivery-man}`
folders into `$UPLOAD_STORAGE_ROOT/legacy/` first (stores' covers under
`legacy/store/cover`), or images are reported missing and imported without.

## Sync: catching up with a newer copy (`--sync`)

Once this system is in use, a plain re-run would overwrite what admins have
edited here. `--sync` brings in only what the old system added or changed
since the previous import. It compares two copies of the old database: the
newer one (`LEGACY_MYSQL_URL`) and the one the previous import read
(`LEGACY_BASELINE_MYSQL_URL`).

| Data | What a sync does |
|---|---|
| New rows (not in `legacy.id_map`) | Imported exactly as the full import would, images included |
| Orders imported before | Status, timestamps, payment status, cancellation, rider, ratings, and the ledger split that follows from them, when the old system changed them. Items, address and amounts never move. History and item ratings are replaced only if nobody edited them here |
| Customers, riders imported before | Blanks filled; nothing set here is overwritten. Active/blocked (customers) and approval status (riders) follow the old system only while this system still has the value originally imported |
| Restaurants, categories, dishes, nutrition, zones, coupons, banners, settings, social media, withdrawal methods, cancel reasons, ads/reels, addresses | Never modified. A change in the old system is counted as "left alone" |
| Money | Only ledger rows new since the last import (cash collections, rider withdrawals and payouts, admin payments of rider earnings (`provide_d_m_earnings`; an "adjustment" there settles earnings against cash, so it is also a cash deposit), restaurant withdrawals and payouts, order transactions), by legacy id. Opening-balance adjustments are never recomputed, so balances move by exactly those rows. A withdrawal imported before follows the old status only while untouched here |
| Ratings | Recomputed for the restaurants and riders whose orders were added or changed |
| Favourites | Only those added in the old system since the baseline copy, so one a customer removed here does not come back |

Run all the steps together: later steps rely on what earlier ones brought in
during the same run (new dishes get nutrition, new restaurants get payout
details, new orders get linked to coupons).

```sh
LEGACY_MYSQL_URL='mysql://legacy_ro:<pass>@127.0.0.1:3306/legacy_lagech_new' \
LEGACY_BASELINE_MYSQL_URL='mysql://legacy_ro:<pass>@127.0.0.1:3306/legacy_lagech' \
DATABASE_URL=... UPLOAD_STORAGE_ROOT=/srv/lagech/uploads UPLOAD_BASE_URL=/uploads \
REDIS_URL= NODE_ENV=development \
node scripts/legacy-import/index.mjs --sync --dry-run zones categories restaurants foods \
  nutrition customers riders payment-details withdrawal-methods orders balances ratings \
  banners cancel-reasons promotions coupons favorites newsletter social-media settings
```

`--dry-run` runs everything inside one Postgres transaction and rolls it back:
every import of the Prisma client (the steps' and the app services' alike)
is routed into that transaction, nested transactions included, and outside it
the client refuses writes. It ends by comparing every table's row count and
newest `updatedAt` before and after. It does hold row locks on what it would
change (a few seconds to a minute) and waits at most 10 s for a lock itself.

The summary has, per entity, add / update / unchanged / left alone /
skipped, the columns behind every update and every "left alone", and a wallet
table: each rider's cash in hand and withdrawable and each restaurant's
balance, before and after here, against the old wallet at the baseline copy
and now. "Moved here" and "moved old" should match. The known reason they do not: the
old system's daily restaurant payouts that are scheduled but not paid
(`disbursement_details` pending). The old balance already excludes them; here
they arrive once paid and a later sync brings them in (column "old unpaid").
Anything left under "unexplained" is worth a look before a real run.

Running a sync twice writes nothing the second time. After a real sync, use
the copy it read as the baseline for the next one: rows it imported are not in
the older baseline, and changes to them could not be told apart otherwise
(they are counted under "not in the baseline copy").

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
