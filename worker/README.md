# Cloudflare Worker broker (no-VPS, free tier)

A drop-in alternative to the VPS Rust broker (`../broker`). Same GitHub Actions
build pipeline and rolling-release downloads — but the control plane runs as a
**Cloudflare Worker** ($0), with state in **D1** (SQLite) and the scheduler on a
**1-minute Cron Trigger**.

```
GitHub Pages (static UI) ──fetch (CORS)──▶ Worker (this) ──▶ D1 + Cron ──▶ GitHub Actions
```

## Deploy (one-time)

```bash
npm i -g wrangler && wrangler login

# 1. Create D1, paste the printed database_id into wrangler.toml
wrangler d1 create thingino-builder

# 2. Apply the schema to the remote DB
wrangler d1 execute thingino-builder --remote --file schema.sql

# 3. Set the GitHub token (fine-grained PAT: Contents R/W + Actions R/W)
wrangler secret put GITHUB_TOKEN

# 4. Edit wrangler.toml: set ALLOW_ORIGIN to your Pages origin
#    (e.g. https://thingino.github.io)

# 5. Deploy → prints the Worker URL
wrangler deploy
```

### CI deploy (git push = deploy)

`.github/workflows/deploy-worker.yml` runs `wrangler deploy` on every push that
touches `worker/`. It needs two repo secrets — set once:

```bash
gh secret set CLOUDFLARE_API_TOKEN   # Workers Scripts:Edit + D1:Edit
gh secret set CLOUDFLARE_ACCOUNT_ID  # your account id
```

The Worker's own `GITHUB_TOKEN` is a **Cloudflare** secret (`wrangler secret put`)
and persists across deploys — it is never stored in the repo.

## Frontend on GitHub Pages

The static site is `../web`. Host it on GitHub Pages (repo **Settings → Pages**).
One change: point it at the Worker. In `web/index.html` (and `admin.html`) add an
API base and prepend it to the `fetch()` calls:

```js
const API='https://thingino-web-builder.<you>.workers.dev';
// fetch(API + path, ...)  instead of fetch(path, ...)
```

The frontend already sends `X-Builder-Uid` and reads `uid` from the JSON body, so
identity works **cross-origin without cookies**. The Worker returns matching CORS
headers — just set `ALLOW_ORIGIN` to your Pages URL. (Prefer no CORS at all? Host
the static site on **Cloudflare Pages** and route `/api/*` to this Worker → same
origin.)

## Local smoke test (no Cloudflare account needed)

```bash
wrangler dev --local
curl -s localhost:8787/api/health        # -> ok
curl -s localhost:8787/api/defconfigs | head
```

`--local` uses a local D1; `/api/defconfigs` fetches the thingino board list from
GitHub (unauthenticated) and caches it.

## Test a real build

```bash
curl -s -X POST https://<worker-url>/api/build \
  -H 'content-type: application/json' -H 'X-Builder-Uid: testuser12345' \
  -d '{"defconfig":"atom_cam2_t31x_gc2053_atbm6031"}'
# within ~1 min the cron dispatches it; then poll:
curl -s https://<worker-url>/api/status/<build_id>
```

## Ported vs not

**Ported:** server-issued identity, per-user / per-IP (/64, via `CF-Connecting-IP`)
/ global hourly limits, FIFO queue + concurrency cap, `(defconfig, commit)` dedup,
`repository_dispatch`, run correlation, cancel, retention reaper + DB pruning,
audit events.

**Not in this PoC (straightforward follow-ups, both Workers-compatible):** admin
panel + **TOTP 2FA** (Web Crypto HMAC-SHA1) and **GitHub App auth** (Web Crypto
RS256 JWT). For now the Worker uses a static `GITHUB_TOKEN` secret.

## Trade-offs vs the VPS

- Scheduler runs **every 1 min** (Cloudflare cron minimum) vs the VPS's 10 s loop —
  build status can lag up to a minute.
- Rate-limit checks are count-then-insert on D1 (no single-mutex serialization), so
  a burst can exceed a cap by 1–2. Use a **Durable Object** if you need strict caps.
- No container to self-update — "update" is `wrangler deploy` (or a deploy Action).
