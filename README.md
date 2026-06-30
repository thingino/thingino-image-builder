# thingino-web-builder

A public, rate-limited **web firmware builder** for
[thingino](https://github.com/themactep/thingino-firmware). Pick a camera
defconfig in the browser, submit, and it builds on **GitHub Actions** — no build
compute on the server. A small Rust broker orchestrates; the heavy lifting is
done by the CI.

## How it works

```
browser ──POST /api/build──▶ Rust broker ──repository_dispatch──▶ GitHub Actions
  ▲  pick a defconfig          rate-limit · queue · dedup ·         build thingino@<commit>
  │  poll status               pin commit · hold the token          upload <build_id>.bin
  └───────────── download ◀── rolling `web-builds` pre-release ◀─────┘   (anonymous CDN)
```

- The broker **never builds** — it validates the request, enforces limits, mints a
  `build_id`, pins thingino's current commit, and fires a `repository_dispatch`.
- The workflow checks out that commit, runs `make fast`, and publishes
  `<build_id>.bin` to a rolling pre-release for anonymous download.
- Finished images are downloadable for **30 minutes**, then a reaper deletes the
  release asset **and** the Actions run (logs included).

## Features

- **Defconfig picker** over every thingino camera profile; shows the exact
  commit being built.
- **Dedup** — an identical `(defconfig, commit)` that's in flight or built within
  the window is reused, not rebuilt.
- **Limits** — per-user **2/hr**, per-IP **3/hr** (IPv6 bucketed by /64), global
  **20/hr**, and **6** concurrent with a FIFO queue.
- **Live status** — queue position, build progress, cancel (persisted
  "cancelling" state until the run stops), 30-minute download window.
- **Admin panel** (`/admin.html`) — live stats, recent builds/events with
  requester uid + IP, a global **kill switch**, behind **TOTP 2FA**.
- **Audit log**, **IPv6** end to end, **singleton** broker (flock + pidfile),
  self-hosted frontend assets (no CDN).

## Layout

| Path | What |
|---|---|
| `broker/` | Rust control plane + scheduler (axum + SQLite) |
| `web/` | static UI (Bootstrap; self-hosted assets in `web/vendor/`) |
| `.github/workflows/build.yml` | the CI build worker (`repository_dispatch`) |
| `Containerfile` | broker image |
| `deploy/quadlet/`, `deploy.sh` | Podman + systemd (Quadlet) deployment |
| `setup.sh`, `creds.sh` | generate / rotate the admin token + TOTP |
| `DEPLOY.md` | full deployment guide |

## Deploy

Podman + Quadlet (systemd); TLS via Caddy (auto Let's Encrypt or BYO certs). Full
guide in **[DEPLOY.md](DEPLOY.md)** — short version:

```bash
sudo git clone https://github.com/thingino/thingino-web-builder.git /opt/thingino-web-builder
cd /opt/thingino-web-builder
sudo ./setup.sh          # generate admin token + TOTP (prints a QR)
# edit .env: DOMAIN, GITHUB_REPO, GITHUB_TOKEN
sudo ./deploy.sh         # build image, install Quadlet units, start
```

## Local dev

```bash
cd broker && cargo build
GITHUB_TOKEN=$(gh auth token) GITHUB_REPO=<owner>/<repo> \
  ADMIN_TOKEN=secret ADMIN_TOTP_SECRET=$(head -c 20 /dev/urandom | base32 | tr -d =) \
  DEFCONFIGS_PATH=../defconfigs.json STATIC_DIR=../web \
  ./target/debug/thingino-build-broker      # serves http://[::]:8080
```

`defconfigs.json` is the build allowlist (one entry per `configs/cameras/*`);
regenerate it from a thingino checkout when boards change.
