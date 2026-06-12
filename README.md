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

## How auth works

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
