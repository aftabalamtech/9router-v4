# 9Router V3 — Production Deployment Guide

Single-service deployment: one Node process serves **both** the API (`/api`, `/v1`, `/v1beta`)
and the built dashboard SPA from `frontend/dist`. No separate frontend server in production.

- **Stack:** Node 22 · Express 5 backend (`backend/`, TS compiled to `backend/dist`) · Vite + React dashboard (`frontend/`, built to `frontend/dist`)
- **Container port:** `3001` by default, overridable via `PORT` (PaaS platforms inject it)
- **Health endpoint (no auth):** `GET /api/health` → `{"status":"ok",...}`
- **Database:** SQLite by default (`${DATA_DIR}/db/data.sqlite`), PostgreSQL when `DATABASE_URL` is set. Migrations run automatically at startup (`runMigrationOnce`) — never destructive.

## 1. Requirements

- Docker 24+ (or Docker Desktop) for container runs; any OCI runtime works
- Node.js 20+ only if building/running without Docker
- 1 GB RAM minimum, 2 GB recommended

## 2. Environment variables

Copy `.env.example` to `.env` and set secrets. Never commit `.env`.

| Variable | Required | Purpose |
|---|---|---|
| `INITIAL_PASSWORD` | **Yes (first boot)** | Dashboard password until changed in-app |
| `PORT` | No (default `3001`) | Container listen port; Railway/Render inject automatically |
| `NODE_ENV` | No (`production` set in image) | `production` outside dev |
| `DATA_DIR` | No (default `/data`) | SQLite dir, logs, runtime files |
| `JWT_SECRET` / `API_KEY_SECRET` | Recommended | Auto-generated + persisted under `DATA_DIR` if unset; set explicitly for multi-instance |
| `DATABASE_URL` | No | `postgresql://USER:PASS@HOST:5432/9router` → uses PostgreSQL instead of SQLite |
| `AUTH_COOKIE_SECURE` | No | `true` only when serving HTTPS directly (keep `false` behind a TLS proxy) |
| `REQUIRE_API_KEY` | No | `true` = require API key for `/v1` traffic |
| `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY` | No | Outbound proxy for upstream providers |
| `ENABLE_REQUEST_LOGS`, `OBSERVABILITY_ENABLED` | No | Logging toggles |
| Provider keys | Mostly no | Providers are connected in the dashboard UI (stored in DB); only special cases (`OPENAI_API_KEY`, Azure vars) use env |

## 3. Local Docker build & run

```bash
# Build
docker build -t 9router-v3 .

# Run (SQLite, persistent volume)
docker run -d --name 9router \
  --env-file .env \
  -p 3001:3001 \
  -v 9router-data:/data \
  --restart unless-stopped \
  9router-v3
```

With Compose (same thing, declarative):

```bash
docker compose up -d --build
```

Verify:

```bash
docker ps                          # STATUS should become healthy (~60s)
curl http://localhost:3001/api/health
curl -s http://localhost:3001/ | head -c 200   # dashboard HTML
docker logs 9router | grep -iE "error|secret|key|token"  # no secrets expected
```

Then open `http://localhost:3001`, log in with `INITIAL_PASSWORD`, connect a provider,
and confirm **Playground** (`/dashboard/playground`) and **Models → Test** work.

## 4. Database setup

No migration command is needed — the server migrates automatically on boot
(versioned migrations + `syncSchemaFromTables` for additive changes).

- **SQLite (default):** file at `${DATA_DIR}/db/data.sqlite`. You MUST mount a volume
  at `/data` (`-v 9router-data:/data`), otherwise data is lost on container replace.
  Back up with `docker cp 9router:/data/db/data.sqlite ./backup.sqlite` (stop writes first).
- **PostgreSQL:** start the optional service (`docker compose --profile postgres up -d`),
  set `DATABASE_URL=postgresql://nine:nine@postgres:5432/9router` (compose) or your
  provider's connection string, and recreate the app. To migrate existing SQLite data,
  export from the dashboard (Models/settings) before switching, then import after —
  the two stores don't sync automatically.

## 5. Railway

1. New service → deploy from GitHub repo (detects `Dockerfile` via `railway.toml`).
2. **Variables** tab: copy from `.env.example` (`NODE_ENV=production`,
   `INITIAL_PASSWORD`, `JWT_SECRET`, `API_KEY_SECRET`). `PORT` is injected automatically.
3. Persistence — pick one:
   - Railway **Volume** mounted at `/data` (keeps SQLite), or
   - Railway **PostgreSQL** plugin → set its `DATABASE_URL` on this service.
4. **Settings → Networking → Generate Domain** for the public URL.
5. Logs under **Deployments → View Logs**; redeploy via **Redeploy** or `git push`.
   Health check path is preconfigured (`/api/health`, `railway.toml`).

## 6. Render

1. New **Web Service** → existing repository → runtime **Docker**.
2. Environment: add the variables from `.env.example`. Leave Render's injected `PORT`
   untouched — the server reads it automatically.
3. Health check path: `/api/health`.
4. Storage: Render disks are persistent only on paid instances — mount a disk at
   `/data` for SQLite, or attach Render **PostgreSQL** and set `DATABASE_URL`
   (recommended on Render).
5. Logs in the dashboard **Logs** tab; **Manual Deploy → Redeploy** or push to redeploy.
   Render restarts crashed services automatically.

## 7. VPS (any Docker host)

```bash
# Install Docker (Debian/Ubuntu)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER && newgrp docker

git clone <your-repo-url> 9router-v3 && cd 9router-v3
cp .env.example .env && nano .env   # set INITIAL_PASSWORD + secrets
docker compose up -d --build
curl http://localhost:3001/api/health
```

Reverse proxy (Nginx example, dashboard + streaming API):

```nginx
server {
  listen 80; server_name 9router.example.com;
  location / {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    # SSE streaming needs buffering off + long timeouts
    proxy_buffering off; proxy_cache off; proxy_read_timeout 300s;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

HTTPS: terminate TLS at the proxy (certbot/Caddy/Cloudflare). Keep
`AUTH_COOKIE_SECURE=false` when the proxy talks plain HTTP to the container.

## 8. Logs & troubleshooting

```bash
docker logs -f 9router                 # app logs
docker compose ps                      # health status
docker inspect 9router | grep -A5 Health
```

| Symptom | Cause / fix |
|---|---|
| `EADDRINUSE` / won't start | Host port taken — change `-p HOST:3001` or `HOST_PORT` |
| Login loops / can't log in | `INITIAL_PASSWORD` unset and no password stored — set it and restart |
| Data gone after recreate | `/data` not mounted — add the volume (SQLite is file-based) |
| `/api/health` fails, models 5xx | Upstream/provider issue — check provider connections in dashboard, not fatal to boot |
| `better-sqlite3` install errors in custom builds | Needs musl prebuilds (present for Node 22) — don't strip `package-lock.json` |
| Playground/Test fail with 401/403 | Provider credentials invalid or expired — reconnect in dashboard; app itself is fine |

Logs never print API keys/tokens (error sanitizer redacts `sk-…`, `Bearer …`, key/token fields).

## 9. Backups

- **SQLite:** periodic `docker cp` of `/data/db/data.sqlite` (or volume backup). Keep 7+ daily copies.
- **PostgreSQL:** use the provider's automated backups + occasional `pg_dump`.
- Always back up before version upgrades.

## 10. Updating

```bash
git pull
docker compose up -d --build    # or: docker build -t 9router-v3 . && docker recreate
```

Migrations are additive and automatic; downgrades aren't supported — restore the volume backup if you roll back.
