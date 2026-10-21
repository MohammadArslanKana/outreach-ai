# Self-hosting Polimatiq (DigitalOcean Droplet + Caddy)

How to run Polimatiq on a single Linux server instead of Vercel. This only
covers what differs from Vercel. Every other environment variable is the same
as in production.

```
Internet ──443──▶ Caddy (TLS, sets X-Forwarded-For) ──▶ 127.0.0.1:3000  next start
Supabase pg_cron ──HTTPS──▶ same hostname /api/cron/*
```

## Billing region detection: why this matters

Indian visitors pay in INR and everyone else pays in USD (`lib/billing/region.ts`).

- **On Vercel**, the country comes from Vercel's `x-vercel-ip-country` header.
  That header is only trusted when `VERCEL=1`, which Vercel sets itself.
- **Self-hosted**, there is no Vercel edge. The app looks up the client IP in a
  local GeoIP country database (`lib/billing/geoip.ts`). Every country header
  a client sends (`x-vercel-ip-country`, `cf-ipcountry`, …) is ignored.
- **When the country can't be determined**, the visitor is treated as
  international (USD). This covers: no database configured, no working
  database loaded (the file was missing or corrupt when the app first tried
  it), no client IP, invalid IP, or an IP not in the database. An unknown
  visitor is never routed to INR.
- **A failed reload doesn't cause that fallback.** If a replacement file is
  missing or corrupt, the app keeps using the last working database, logs the
  failure, and tries again at the next hourly check.

**Never set `VERCEL=1` on a self-hosted server.** It would make the app trust a
client-supplied `x-vercel-ip-country` header.

## Trusted-proxy assumptions

The client IP is the **right-most** `X-Forwarded-For` entry
(`lib/rate-limit/get-client-ip.ts`). Billing and the auth rate limits both use
it. This is only correct when all of the following hold:

1. **Caddy is the only proxy in front of the app, and it replaces the header.**
   Caddy must replace `X-Forwarded-For` with the TCP peer address
   (`header_up X-Forwarded-For {remote_host}`, shown below). Next.js only fills
   the header in when it is absent, so Caddy's value reaches the app unchanged.
2. **The app is unreachable except through Caddy.**
   - `next start` listens on 0.0.0.0 by default, so start it with
     `-H 127.0.0.1`.
   - Allow only 22, 80 and 443 in the firewall.
3. **No other proxy hop sits in front of Caddy.** That rules out a Cloudflare
   proxy, a DigitalOcean Load Balancer, or another CDN. Adding one means
   `{remote_host}` becomes that hop's address. Configure Caddy's
   `trusted_proxies` and use `{client_ip}` instead before adding one.

## GeoIP country database

Polimatiq uses MaxMind's free GeoLite2-Country database (`.mmdb`). The app
reads only `country.iso_code` from it. Point `GEOIP_COUNTRY_DB_PATH` at the
file.

The app re-checks the file's modification time at most once an hour and
reloads it when it changes, so updating the database needs no restart.

### Installing GeoLite2-Country with `geoipupdate`

Free, with no recurring fee. It needs a free MaxMind account, and updates come
from MaxMind's official updater.

1. Create a free account at maxmind.com, then generate a license key. The
   account ID and key are secrets. They go only in `/etc/GeoIP.conf` on the
   server, never in the app's environment or in git.
2. Install the updater and configure it:

   ```bash
   sudo apt-get install -y geoipupdate
   sudo tee /etc/GeoIP.conf >/dev/null <<'EOF'
   AccountID <your-account-id>
   LicenseKey <your-license-key>
   EditionIDs GeoLite2-Country
   DatabaseDirectory /var/lib/GeoIP
   EOF
   sudo chmod 600 /etc/GeoIP.conf
   sudo geoipupdate -v
   ls -l /var/lib/GeoIP/GeoLite2-Country.mmdb
   ```

3. Keep the database current. MaxMind publishes updates twice a week, and the
   GeoLite2 EULA requires using an up-to-date copy:

   ```ini
   # /etc/systemd/system/geoipupdate.service
   [Unit]
   Description=Update GeoLite2 databases
   [Service]
   Type=oneshot
   ExecStart=/usr/bin/geoipupdate

   # /etc/systemd/system/geoipupdate.timer
   [Unit]
   Description=Update GeoLite2 databases twice a week
   [Timer]
   OnCalendar=Wed,Sat 06:00
   RandomizedDelaySec=1h
   Persistent=true
   [Install]
   WantedBy=timers.target
   ```

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now geoipupdate.timer
   ```

4. Set `GEOIP_COUNTRY_DB_PATH=/var/lib/GeoIP/GeoLite2-Country.mmdb`.

### Attribution and licence obligations

Attribution is required before going live.

**MaxMind GeoLite2** ([GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula),
checked against the version "Updated on: February 12, 2026"):
- **Attribution is required (§3: "You must provide attribution of your use to
  MaxMind").** Use the EULA's own example wording, unchanged. The displayed URL
  is `https://www.maxmind.com`, linking to `https://www.maxmind.com/en/home`:

  > This product includes GeoLite Data created by MaxMind, available from
  > [https://www.maxmind.com](https://www.maxmind.com/en/home).

  Ready to paste into a web page:

  ```html
  This product includes GeoLite Data created by MaxMind, available from
  <a href="https://www.maxmind.com/en/home">https://www.maxmind.com</a>.
  ```

- **Where it goes:** the EULA requires attribution but doesn't say where. This
  file carries it for the self-hosted deployment (see "Third-party data
  notices" below). Because the data decides what visitors are charged, also
  show it to end users, e.g. on the privacy policy page next to the description
  of how the billing region is chosen.
- **Notices:** §3 also forbids removing or obscuring any copyright or other
  notice contained in the data, so don't strip anything from the `.mmdb` files.
- **Old data must go (§6.3).** Use a new release promptly, and destroy old
  versions within 30 days of an update. MaxMind's developer docs put it as:
  "you must delete GeoLite databases within 30 days of a new release".
  - `geoipupdate` writes each new release to a temporary file and renames it
    over `GeoLite2-Country.mmdb`, so the old version is gone once the new one
    is in place. Don't keep copies or backups of old `.mmdb` files.
  - The app logs `[geoip] country database is N days old` (at most once a day)
    when the loaded database is more than 30 days old. Age is measured from the
    **build date recorded inside the database** (its `build_epoch` metadata),
    not the file's modification time. A warning means the updater has stopped
    fetching new releases.

## Third-party data notices

Self-hosted deployments of Polimatiq use MaxMind GeoLite2-Country for billing
region detection, under the
[GeoLite End User License Agreement](https://www.maxmind.com/en/geolite/eula).

This product includes GeoLite Data created by MaxMind, available from
[https://www.maxmind.com](https://www.maxmind.com/en/home).

## Caddy

```caddyfile
# /etc/caddy/Caddyfile
your.app.hostname {
	encode zstd gzip

	reverse_proxy 127.0.0.1:3000 {
		# The app reads the client IP from the right-most X-Forwarded-For
		# entry. Replace whatever the client sent with the real TCP peer
		# address, so a client can't choose its own IP or country.
		header_up X-Forwarded-For {remote_host}
		# Defense in depth: the app ignores these off Vercel anyway.
		header_up -X-Vercel-IP-Country
		header_up -CF-IPCountry
		header_up -X-Real-IP
	}
}
```

## systemd service

```ini
# /etc/systemd/system/polimatiq.service
[Unit]
Description=Polimatiq (Next.js)
After=network-online.target
Wants=network-online.target

[Service]
User=polimatiq
WorkingDirectory=/srv/polimatiq/current
EnvironmentFile=/etc/polimatiq/prod.env
Environment=NODE_ENV=production
Environment=NODE_OPTIONS=--max-old-space-size=1024
# -H 127.0.0.1: only Caddy may reach the app (see "Trusted-proxy assumptions").
ExecStart=/srv/polimatiq/current/node_modules/.bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=5
MemoryMax=1600M

[Install]
WantedBy=multi-user.target
```

## Production environment file

`/etc/polimatiq/prod.env` holds the same variables as the Vercel production
environment, plus:

| Variable | Value |
|---|---|
| `GEOIP_COUNTRY_DB_PATH` | Absolute path to the `.mmdb` file, e.g. `/var/lib/GeoIP/GeoLite2-Country.mmdb`. If unset, the app logs `[geoip] GEOIP_COUNTRY_DB_PATH is not set` once and bills everyone in USD. |
| `VERCEL` | **Must not be set** |

**Permissions:**
- The file stays **root-owned, mode 600**, inside a root-only directory.
- The `polimatiq` user never reads it directly.
- systemd reads it as root and passes the variables to the process: the
  service through `EnvironmentFile=`, and the build through `systemd-run`
  (see "Building and releasing").

```bash
sudo install -d -m 700 -o root -g root /etc/polimatiq
sudo install -m 600 -o root -g root /dev/null /etc/polimatiq/prod.env
sudoedit /etc/polimatiq/prod.env
```

**Format:** the service and the build both use systemd's `EnvironmentFile`
parser, so they always see the same values. That format is:
- one `KEY=value` per line, with no `export`;
- quotes are optional;
- no `$VAR` expansion.

## Building and releasing

`NEXT_PUBLIC_*` values are compiled into the client bundle at build time, so
the build must see the production environment. Don't `source` the file in a
shell as `polimatiq`: that user can't read it, by design, and `source` without
`set -a` doesn't export the variables to `next build` anyway.

```bash
SHA=<commit to deploy>
REL=/srv/polimatiq/releases/$SHA

# 1. Check out the release as the app user.
sudo -u polimatiq git clone --no-checkout <repo-url> "$REL"
sudo -u polimatiq git -C "$REL" checkout --detach "$SHA"

# 2. Install dependencies WITHOUT the production secrets in the environment.
#    Package install scripts never see them.
sudo -u polimatiq bash -c "cd '$REL' && npm ci"

# 3. Build as polimatiq. systemd (running as root) reads the root-only env
#    file and passes it to the build, exactly as it does for the service.
sudo systemd-run --uid=polimatiq --gid=polimatiq \
  --working-directory="$REL" \
  --property=EnvironmentFile=/etc/polimatiq/prod.env \
  --setenv=NODE_OPTIONS=--max-old-space-size=1536 \
  --wait --pipe --collect \
  /usr/bin/npm run build

# 4. next build rewrites the tracked next-env.d.ts; keep the checkout clean.
sudo -u polimatiq git -C "$REL" checkout -- next-env.d.ts

# 5. Switch over. Roll back by pointing `current` at the previous release.
sudo ln -sfn "$REL" /srv/polimatiq/current
sudo systemctl restart polimatiq
```

The build needs a swapfile on a 2 GB Droplet.

## Verifying region detection on the server

Run these after deploying, from the server itself.

```bash
# 1. Next is not reachable from outside, only via Caddy:
ss -ltnp | grep 3000          # expect 127.0.0.1:3000, not 0.0.0.0:3000

# 2. The database loads and resolves known addresses.
#    Expect "IN" (an Indian ISP address) then "US":
cd /srv/polimatiq/current && sudo -u polimatiq \
  env GEOIP_COUNTRY_DB_PATH=/var/lib/GeoIP/GeoLite2-Country.mmdb node -e '
const { Reader } = require("mmdb-lib");
const r = new Reader(require("fs").readFileSync(process.env.GEOIP_COUNTRY_DB_PATH));
for (const ip of ["49.36.12.34", "8.8.8.8"]) console.log(ip, r.get(ip)?.country?.iso_code);'

# 3. The app logs a clear line if the database can't be loaded:
journalctl -u polimatiq | grep '\[geoip\]'
```

End to end:

- From a non-Indian network, the pricing section shows USD prices with no
  "Charged as ₹…" line. Sending `-H 'X-Forwarded-For: 49.36.12.34'` or
  `-H 'x-vercel-ip-country: IN'` through Caddy must not change that.
- From an Indian network or VPN exit, the pricing section shows
  "Charged as ₹… via Razorpay".
