#!/usr/bin/env bash
# 9Router V3 — one-command local startup.
# Usage:
#   ./start.sh              # backend + frontend on http://localhost:5177
#   ./start.sh --public     # + public Cloudflare Quick Tunnel URL
#   ./start.sh --no-install # skip automatic npm install
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKEND_PORT="${PORT:-3001}"
FRONTEND_PORT=5177
DO_INSTALL=1
DO_PUBLIC=0
for arg in "$@"; do
  case "$arg" in
    --no-install) DO_INSTALL=0 ;;
    --public) DO_PUBLIC=1 ;;
    -h|--help)
      echo "Usage: ./start.sh [--public] [--no-install]"
      echo "  --public     expose the dashboard via a temporary Cloudflare Quick Tunnel URL"
      echo "  --no-install skip automatic 'npm install' when binaries are missing"
      exit 0 ;;
    *) echo "Unknown arg: $arg (see --help)"; exit 1 ;;
  esac
done

PIDS=()
cleanup() {
  echo ""
  echo "Stopping 9Router..."
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  exit 0
}
trap cleanup INT TERM EXIT

fail() { echo "ERROR: $1" >&2; exit 1; }

# 1. Runtime checks -----------------------------------------------------------
command -v node >/dev/null || fail "node not found. Install Node.js 20+ (https://nodejs.org)."
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 20+ required (found $(node -v))."
command -v npm >/dev/null || fail "npm not found (comes with Node.js)."

# 2. Dependencies (only installs when missing; never touches existing files) --
# (npm workspaces hoist binaries to the root node_modules/.bin)
if [ ! -x "$ROOT/node_modules/.bin/tsx" ] || [ ! -x "$ROOT/node_modules/.bin/vite" ]; then
  if [ "$DO_INSTALL" -eq 1 ]; then
    echo "Installing dependencies (npm install --no-audit --no-fund)..."
    (cd "$ROOT" && npm install --no-audit --no-fund) || fail "npm install failed."
  else
    fail "required binaries missing. Run without --no-install once."
  fi
fi

# 3. Environment config -------------------------------------------------------
# NOTE: plain `npm run dev` does NOT read backend/.env (no dotenv loader), so
# export it here to keep local, Docker, and production behavior identical.
if [ -f "$ROOT/backend/.env" ]; then
  set -a; . "$ROOT/backend/.env"; set +a
elif [ ! -f "$ROOT/backend/.env" ]; then
  if [ -f "$HOME/.9router-v3/db/data.sqlite" ]; then
    echo "NOTE: backend/.env not found, but ~/.9router-v3 has data — keeping defaults so your existing data is used."
    echo "      Create backend/.env (see backend/.env.example) to take control of DATA_DIR and secrets."
  elif [ -f "$ROOT/backend/.env.example" ]; then
    echo "Creating backend/.env from example with generated secrets..."
    node -e "
const fs = require('fs'), crypto = require('crypto');
let s = fs.readFileSync('$ROOT/backend/.env.example', 'utf8');
s = s.replace(/\\\$\{\{secret\(32\)\}\}/g, () => crypto.randomBytes(32).toString('hex'));
s = s.replace(/^PORT=.*$/m, 'PORT=$BACKEND_PORT');
fs.writeFileSync('$ROOT/backend/.env', s);
" || fail "could not generate backend/.env"
    set -a; . "$ROOT/backend/.env"; set +a
    echo "  (edit backend/.env to change INITIAL_PASSWORD and secrets)"
  else
    fail "backend/.env.example missing."
  fi
fi
# Honor backend/.env PORT if set, else the startup PORT env, else 3001.
BACKEND_PORT="${PORT:-3001}"
# 4. No duplicate instances ----------------------------------------------------
for spec in "$BACKEND_PORT:backend" "$FRONTEND_PORT:frontend"; do
  port="${spec%%:*}"; name="${spec##*:}"
  if (exec 3<>/dev/tcp/127.0.0.1/$port) 2>/dev/null; then
    exec 3>&-; exec 3<&-
    fail "port $port already in use ($name may already be running). Stop it first."
  fi
done

# 5. Start (documented local command: backend + frontend dev servers) ----------
echo "Starting 9Router V3..."
(cd "$ROOT" && npm run dev) &
PIDS+=($!)

# 6. Wait until ready ----------------------------------------------------------
echo -n "Waiting for backend (port $BACKEND_PORT)"
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/$BACKEND_PORT) 2>/dev/null; then exec 3>&-; exec 3<&-; break; fi
  echo -n "."; sleep 1
  if [ "$i" -eq 60 ]; then fail "backend did not start in 60s. Check backend logs above."; fi
done
echo " OK"
HEALTH="$(curl -s -m 8 "http://127.0.0.1:$BACKEND_PORT/api/health" || true)"
echo "$HEALTH" | grep -q '"status":"ok"' || fail "backend health check failed: $HEALTH"
echo -n "Waiting for frontend (port $FRONTEND_PORT)"
for i in $(seq 1 60); do
  if (exec 3<>/dev/tcp/127.0.0.1/$FRONTEND_PORT) 2>/dev/null; then exec 3>&-; exec 3<&-; break; fi
  echo -n "."; sleep 1
  if [ "$i" -eq 60 ]; then fail "frontend did not start in 60s."; fi
done
echo " OK"

# 7. Optional public URL via Cloudflare Quick Tunnel ---------------------------
TUNNEL_PID=""
if [ "$DO_PUBLIC" -eq 1 ]; then
  if ! command -v cloudflared >/dev/null; then
    echo "cloudflared not found — downloading official binary..."
    CFDIR="$ROOT/.local/bin"; mkdir -p "$CFDIR"
    CFOS="linux"; CFARCH="amd64"
    case "$(uname -s)" in Darwin) CFOS="darwin";; esac
    case "$(uname -m)" in arm64|aarch64) CFARCH="arm64";; esac
    CFURL="https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-${CFOS}-${CFARCH}"
    (curl -fsSL --max-time 120 -o "$CFDIR/cloudflared" "$CFURL" && chmod +x "$CFDIR/cloudflared") \
      || fail "cloudflared download failed. Install manually: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
    export PATH="$CFDIR:$PATH"
  fi
  echo "Starting Cloudflare Quick Tunnel (temporary public URL)..."
  TUNLOG="$(mktemp)"
  cloudflared tunnel --no-autoupdate --url "http://localhost:$FRONTEND_PORT" >"$TUNLOG" 2>&1 &
  TUNNEL_PID=$!
  PIDS+=($TUNNEL_PID)
  URL=""
  for i in $(seq 1 45); do
    URL="$(grep -a -o -E 'https://[a-z0-9-]+\.trycloudflare\.com' "$TUNLOG" | head -1)"
    [ -n "$URL" ] && break
    kill -0 "$TUNNEL_PID" 2>/dev/null || fail "cloudflared exited early. Log: $(tail -5 "$TUNLOG")"
    sleep 1
  done
  [ -n "$URL" ] || fail "tunnel URL did not appear within 45s. Log tail: $(tail -5 "$TUNLOG")"
  echo "Public URL: $URL"
  echo "(Temporary Quick Tunnel URL — not a permanent domain. Keep this terminal open.)"
fi

# 8. Done ----------------------------------------------------------------------
echo ""
echo "9Router V3 is running:"
echo "  Dashboard: http://localhost:$FRONTEND_PORT"
echo "  API:       http://localhost:$BACKEND_PORT  (health: /api/health)"
echo "Press Ctrl+C to stop."
wait
