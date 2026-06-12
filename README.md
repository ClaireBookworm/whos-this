# whos-this

Group contact sharing: create a group → share one link → everyone adds
their info → anyone downloads all of it as one `.vcf` file.

One file (`server.js`), express + better-sqlite3, no accounts, no build step.

## Run locally

```sh
npm install
npm start            # http://localhost:3000
```

Env vars: `PORT` (default 3000), `TRUST_PROXY=1` (set when behind a
reverse proxy so rate limiting sees real client IPs), and either
`TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (hosted Turso database) or
`DB_PATH` (local sqlite file, default `./whos-this.db`). With no env
vars set it just uses the local file — fine for development.

## Hosting

### Option 0: Render free tier + Turso (free)

Render's free filesystem is wiped on every deploy/restart/spin-down,
so the database lives in Turso (hosted SQLite) instead:

1. `turso db tokens create whos-this` (or dashboard → your database →
   Generate Token) to get an auth token.
2. In the Render service → Environment, set:
   - `TURSO_DATABASE_URL` = `libsql://<your-db>.turso.io`
   - `TURSO_AUTH_TOKEN` = the token from step 1
   - `TRUST_PROXY` = `1`
3. Push / redeploy.

Caveat: the free web service still spins down after 15 idle minutes,
so the first visit after a quiet period takes ~50s to load — but the
data now survives it.

The self-hosted options below keep the database as a plain local file
(no Turso account needed):

### Option A: a small VPS + Caddy (most control, ~$5/mo)

Hetzner / DigitalOcean / Lightsail, smallest box, Ubuntu:

```sh
# on the server
git clone <your repo> && cd whos-this && npm install
sudo tee /etc/systemd/system/whos-this.service <<'EOF'
[Unit]
Description=whos-this
After=network.target
[Service]
WorkingDirectory=/home/you/whos-this
ExecStart=/usr/bin/node server.js
Environment=PORT=3000 TRUST_PROXY=1 DB_PATH=/home/you/whos-this/whos-this.db
Restart=always
[Install]
WantedBy=multi-user.target
EOF
sudo systemctl enable --now whos-this

# HTTPS: install caddy, then /etc/caddy/Caddyfile is just:
#   whosthis.yourdomain.com {
#     reverse_proxy localhost:3000
#   }
```

Caddy gets and renews the TLS certificate automatically. HTTPS is not
optional here — the links ARE the passwords (see security below), and
the contact-card picker only works on secure origins.

### Option B: Fly.io (no server to manage)

```sh
fly launch --no-deploy          # generates fly.toml, pick a region
fly volumes create data --size 1
# in fly.toml add:
#   [mounts]
#     source = "data"
#     destination = "/data"
#   [env]
#     DB_PATH = "/data/whos-this.db"
#     TRUST_PROXY = "1"
fly deploy
```

The volume is what keeps the SQLite file alive across deploys. Railway
and Render work the same way (attach a persistent disk, point DB_PATH
at it). Run exactly one instance — SQLite doesn't share across machines.

### Backup

The entire state is one file. `cp` it somewhere on a cron:

```sh
sqlite3 whos-this.db ".backup /backups/whos-this-$(date +%F).db"
```

## How auth works (there are no accounts)

Every secret is a **link or token you hold**, checked server-side:

| you hold              | what it grants                          |
|-----------------------|-----------------------------------------|
| share link (`/g/slug`)| see members, add yourself, download vcf |
| edit token            | edit/delete *your own* entry (stored in your browser's localStorage automatically) |
| admin link (`?admin=`)| lock the group, remove anyone           |

Slugs and tokens are generated with `crypto.randomBytes` — far too
random to guess. The trade-off: anyone you forward the link to has the
same access you do, and a lost admin link is unrecoverable.

## Limits

500 members/group, 20 writes/min/IP, groups untouched for 12 months
are deleted by a daily sweep.
