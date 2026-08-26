# Go live on mintofood.com

Target host: EC2 `minto-server` (`i-0da155967af299582`), `3.110.207.151`,
ap-south-1. Ubuntu 26.04, 1 vCPU, 2 GB RAM, 8 GB EBS.

| Host                      | Serves                    | Backed by                              |
| ------------------------- | ------------------------- | -------------------------------------- |
| `api.mintofood.com`       | prod API + socket + files | PM2 `switcheats-*`, ports 5000/5001    |
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

## Blocked

- **RDS instance does not exist.** The backend stops at `DATABASE_URL` and
  cannot start. Needs Postgres with the **postgis** extension — delivery zones
  are polygons.
- **Third-party credentials not supplied.** The server refuses to boot in
  production without them, by design: SMS India Hub (no OTP means nobody can
  log in), Razorpay including the webhook secret (without it customers are
  charged and orders never confirm), and a Firebase service account
  (without it restaurants are never told about new orders).
- **DNS not pointed.** The client holds Cloudflare and redirects it last, so
  certificates cannot be issued yet.
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

## 2. Security group

Inbound 80 and 443 from anywhere; 22 from your address only. 443 is not open
yet — nothing is listening on it.

## 3. Certificates

Only after DNS resolves. The vhosts are HTTP-only on purpose; certbot adds the
`listen 443 ssl` blocks and the redirects itself.

    sudo certbot --nginx \
      -d api.mintofood.com -d admin.mintofood.com \
      -d uat.api.mintofood.com -d uat.admin.mintofood.com
    sudo nginx -t && sudo systemctl reload nginx
    sudo certbot renew --dry-run

## 4. Database

Create the RDS instance, enable postgis, then in `/var/www/Backend/.env`:

    DATABASE_URL=postgresql://USER:PASS@HOST:5432/minto?schema=public

    cd /var/www/Backend && npm run db:migrate

UAT needs its own database and Razorpay **test** keys. A UAT pointed at the
production database takes real payments during a test run.

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
    sudo rsync -a --delete dist/ /srv/minto/admin/
