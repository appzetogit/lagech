# Go live on mintofood.com

Target host: EC2 `minto-server` (`i-0da155967af299582`), `3.110.207.151`,
ap-south-1. Ubuntu 26.04, 1 vCPU, 2 GB RAM, 8 GB EBS.

| Host                      | Serves                    | Backed by                              |
| ------------------------- | ------------------------- | -------------------------------------- |
| `api.mintofood.com`       | prod API + socket + files | PM2 `minto-*`, ports 5000/5001    |
| `admin.mintofood.com`     | prod web app (SPA)        | static build in `/srv/minto/admin`     |
| `uat.api.mintofood.com`   | UAT API + socket + files  | PM2 `uat-minto-*`, ports 5100/5101     |
| `uat.admin.mintofood.com` | UAT web app (SPA)         | static build in `/srv/minto-uat/admin` |

The repo is checked out at `/var/www`. Served content lives under `/srv`
instead: serving out of a working tree exposes `.git` to anyone who guesses
the path, and a redeploy that touches the tree would take the uploads with it.

## Done

- Swap (1 GB) added — 2 GB RAM with none OOM-kills the Vite build.
- nginx reverse proxy for all four hosts, installed and validated. The stock
  `default_server` is removed, so the bare IP no longer answers.
- certbot 4.0.0 installed.
- Frontend built and deployed to `/srv/minto/admin`, with
  `https://api.mintofood.com/api/v1` baked in.
- `Backend/.env` written with generated JWT secrets, CORS, and upload paths.
- TLS live on all four hosts, renewing over DNS-01, dry run passing.
- Production origin refuses requests that did not come through Cloudflare.
- Rebranded to Minto Foods; `admin.mintofood.com/` lands on `/admin`.

## Blocked

- **No database password.** The RDS instance exists and port 5432 is reachable
  from this box, but `DATABASE_URL` is empty, so the backend will not start.
  The console offers an IAM auth token; those expire every 15 minutes and
  cannot back a long-lived pool. It needs a password user. See section 4.
- **Third-party credentials not supplied.** The server refuses to boot in
  production without them, by design: SMS India Hub (no OTP means nobody can
  log in), Razorpay including the webhook secret (without it customers are
  charged and orders never confirm), and a Firebase service account
  (without it restaurants are never told about new orders).
- **Disk.** 1.2 GB free on an 8 GB volume with no unallocated space. Grow the
  volume in the console before the database and uploads start filling it.

## 1. DNS (client, in Cloudflare)

    api.mintofood.com          A   3.110.207.151
    admin.mintofood.com        A   3.110.207.151
    uat.api.mintofood.com      A   3.110.207.151
    uat.admin.mintofood.com    A   3.110.207.151

Confirm before running certbot — it fails on a name that has not propagated:

    dig +short api.mintofood.com

**Ask whether these are proxied (orange cloud) or DNS-only (grey).** Proxied,
every request arrives from a Cloudflare edge address, `$remote_addr` stops
being the visitor, and the API's rate limiting silently buckets the whole
internet into a handful of IPs. If proxied, run
`deploy/scripts/update-cloudflare-ips.sh` and set the Cloudflare SSL/TLS mode
to **Full (strict)** — "Flexible" leaves Cloudflare→origin as plain HTTP.

## 2. Origin access

Ports 80 and 443 are open to the internet at the security group; 22 is
restricted. Production is instead restricted **in nginx**, per vhost -- see
"Restricting the origin" below for why a security group rule cannot do this
while UAT is DNS-only.

## 3. Certificates -- done

Issued 2026-08-26, reissued over DNS-01 on 2026-08-31, expiring 2026-11-29.
One certificate covers all four names. The vhosts in this repo stay HTTP-only
on purpose: certbot owns the `listen 443 ssl` blocks and the redirects and
rewrites them in `/etc/nginx/sites-enabled/` on renewal, so keeping a second
copy here would guarantee the two drift apart.

### Renewal uses DNS-01, not HTTP-01

Renewal revalidates every name on the certificate. Two of them are DNS-only, so
under HTTP-01 Let's Encrypt had to reach the origin directly for those -- meaning
any firewall allowing only Cloudflare would fail those two challenges and, since
it is a single certificate, take production's TLS down with them. Around sixty
days after the lockdown, with no symptom in the meantime.

DNS-01 removes the inbound dependency: validation is a TXT record.

    /root/.secrets/cloudflare.ini       mode 600, Cloudflare API token
    authenticator = dns-cloudflare      in /etc/letsencrypt/renewal/
    renew_hook = systemctl reload nginx

The hook matters: `certonly` does not install, so without it a renewed
certificate sits on disk while nginx keeps serving the old one. Check any change
with `sudo certbot renew --dry-run`.

To rotate the token, replace it in `cloudflare.ini` and re-run the dry run.
Nothing else refers to it.

### Restricting the origin to Cloudflare

A security group cannot express this. Production and UAT share one instance and
one pair of ports, and UAT is DNS-only by request, so a rule allowing only
Cloudflare on 443 blocks UAT as well.

It is done in nginx instead. `update-cloudflare-ips.sh` emits a `geo` block
setting `$from_cloudflare` from `$realip_remote_addr` -- the address that opened
the connection, since `$remote_addr` has by then been rewritten to the visitor --
plus a guard snippet returning 403. Only the two production vhosts include it,
through a wildcard, because the variable exists only once the generator has run
and nginx will not start on an unknown one.

Verified: direct to origin 403, through Cloudflare 200/302, UAT unaffected.

This is application layer, so a direct connection still completes TCP and TLS
before being refused -- weaker than a network block. Once UAT testing finishes
and those hosts can be proxied or limited to office addresses, move it down to
the security group, using a managed prefix list rather than forty raw rules.

## 4. Database (RDS)

Instance: `database-1-instance-1.cno8qkoa4p2p.ap-south-1.rds.amazonaws.com`.
Port 5432 is reachable from the EC2 instance.

    DATABASE_URL=postgresql://USER:PASS@HOST:5432/minto?schema=public&sslmode=require

    cd /var/www/Backend && npm run db:migrate

Four things that will bite otherwise:

- **Use password authentication, not IAM.** The console offers an
  `rds generate-db-auth-token` snippet; those tokens expire after 15 minutes.
  Prisma is handed one connection URL at startup and holds a pool open for the
  life of the process, with no hook to re-sign a password, so an IAM-auth setup
  works for one smoke test and then fails every reconnect. Give the app a
  password user.
- **Run the migration as the RDS master user.** The first migration issues
  `CREATE EXTENSION postgis`, `pgcrypto` and `btree_gist`; a plain application
  user has no privilege to do that and the migration fails partway through.
- **`sslmode=require` is not optional.** RDS presents a TLS certificate but
  Prisma will not negotiate TLS unless asked, and with `rds.force_ssl` set the
  connection is simply refused.
- **`npm run db:migrate` is three steps, not one** -- `prisma migrate deploy`,
  then `prisma/apply-constraints.mjs`, then `prisma generate`. The middle step
  is not optional: the money guards, the geography sync triggers and every GIN
  and GIST index live in `constraints.sql`, because Prisma's schema language
  cannot express them. Running only `migrate deploy` produces a schema that
  looks correct and silently permits negative wallet balances.

The app also wants its own database rather than the default `postgres` one:

    CREATE DATABASE minto;

### Connection pool sizing

Prisma opens one pool **per process**, and PM2 runs several, so
`DATABASE_POOL_SIZE` is a per-process number that has to be multiplied out:

    processes x DATABASE_POOL_SIZE  <  max_connections - superuser reserve

With queues off that is api (one per vCPU, `instances: 'max'`) + socket +
scheduler = 3 on this box, so 3 x 20 = 60. `max_connections` on the small RDS
classes is lower than people expect -- about 112 on a 1 GiB `db.t4g.micro`.
Prisma's own default of 25 across five processes is 125, which would not fit.

**Recompute after any instance resize.** More vCPUs means more API workers means
more pools, and the failure mode is an opaque `pool_timeout` rather than a
message about running out of connections.

UAT needs its own database and Razorpay **test** keys. A UAT pointed at the
production database takes real payments during a test run.

## 4a. Load balancing and redundancy: what actually exists

Worth stating plainly, because "load balanced" is doing less work here than it
sounds:

- **Within the box:** PM2 cluster mode balances across API workers and nginx
  fronts them. On the current 1 vCPU instance `instances: 'max'` resolves to
  **one** worker, so nothing is being balanced today. It starts working on a
  larger instance with no config change.
- **Across boxes: none.** One EC2, one nginx, one upstream -- a single point of
  failure. Real redundancy means an ALB in front of two instances in separate
  availability zones.
- **Socket.IO is deliberately a single process** and cannot be clustered as-is.
  Multiple socket processes need the Redis adapter, or a client lands on a
  worker that does not hold its room and quietly stops receiving events.
- **Queue workers are off** (`BULLMQ_ENABLED` unset, no Redis). The ecosystem
  files leave them out of the process list while queues are disabled: started
  anyway they exit immediately, and PM2 reads a clean exit as success and
  restarts them forever.

Before adding an ALB: point health checks at `/health`; the API is JWT-based so
it needs no stickiness, but websockets need sticky sessions or the Redis adapter.

## 4b. CORS

The app and the API are on different hosts, so every browser request is
cross-origin and `CORS_ORIGINS` decides whether it is allowed. It must list
**every** origin the SPA is served from -- the apex and the admin host serve the
same build, so both call the same API:

    CORS_ORIGINS=https://mintofood.com,https://www.mintofood.com,https://admin.mintofood.com,https://uat.admin.mintofood.com

Worth knowing how this fails, because the error points somewhere else: when the
backend is down, nginx answers with its own 502 page, and that page carries no
`Access-Control-Allow-Origin` header. The browser reports a CORS violation. The
actual problem is that nothing is running -- check `/health` before touching the
CORS list.

## 4c. Uploads (S3)

Media goes to the `minto-media` bucket in ap-south-1, written by the EC2
instance role -- no access keys anywhere. Set in `Backend/.env`:

    UPLOAD_DRIVER=s3
    UPLOAD_S3_BUCKET=minto-media
    UPLOAD_S3_REGION=ap-south-1
    UPLOAD_BASE_URL=https://minto-media.s3.ap-south-1.amazonaws.com

`UPLOAD_DRIVER=local` switches back to disk; the code path is still there and
nginx still serves `/uploads/` for anything written before the move.

Two separate AWS settings are needed for customers to see the images, and
turning off only the first leaves you with a 403 that looks like a broken
policy: **Block Public Access off** removes the veto, and a **bucket policy**
granting `s3:GetObject` on `arn:aws:s3:::minto-media/*` is what actually
grants the read. Neither works alone.

Worth doing later: CloudFront in front of the bucket, on `cdn.mintofood.com`.
Cheaper egress and edge caching, and it needs no application change -- only a
different `UPLOAD_BASE_URL`.

## 5. Start

    cd /var/www
    pm2 start deploy/ecosystem.config.cjs
    pm2 save && pm2 startup

## 6. Verify

    curl -sS https://api.mintofood.com/health

    # CORS: header present on the first, absent on the second
    curl -sSI -H 'Origin: https://admin.mintofood.com' https://api.mintofood.com/api/v1/health
    curl -sSI -H 'Origin: https://evil.example.com'    https://api.mintofood.com/api/v1/health

Then at `https://admin.mintofood.com`: load `/admin`, sign in, open an order.
The console should show a `/socket.io/` upgrade and no CORS or mixed-content
errors, and images should load from `api.mintofood.com/uploads/`.

## Redeploying the frontend

`VITE_*` values are inlined at build time — changing one means rebuilding, not
restarting nginx.

    cd /var/www/Frontend
    NODE_OPTIONS=--max-old-space-size=1536 npm run build
    # Use the script: it keeps the previous build's hashed chunks so tabs that
    # are already open do not 404 on their next lazy route (a --delete sync here
    # is what made the admin panel hard-reload on every sidebar click after a
    # deploy). It also sets the heap size the 2 GB box needs to finish a build.
    deploy/scripts/deploy-frontend.sh
