#!/usr/bin/env bash
# Start the Glass Order backend in the background.
# Usage: ./scripts/start.sh [--foreground]
set -euo pipefail
source "$(dirname "$0")/_common.sh"

FG=0
if [ "${1:-}" = "--foreground" ] || [ "${1:-}" = "-f" ]; then
  FG=1
fi

if pid=$(running_pid); then
  echo "Already running (pid=$pid). Use ./scripts/restart.sh to restart."
  exit 0
fi

# Kill any orphan 'node server.js' tied to this backend dir (no pidfile match)
orphans=$(pgrep -af "node server.js" 2>/dev/null | awk -v d="$BACKEND_DIR" '
  $0 ~ d {print $1}
' || true)
# Fallback: pgrep may not match; check cwd of every node server.js process
for p in $(pgrep -f "node server.js" 2>/dev/null || true); do
  cwd=$(readlink -f "/proc/$p/cwd" 2>/dev/null || true)
  if [ "$cwd" = "$BACKEND_DIR" ]; then
    orphans+=$'\n'"$p"
  fi
done
orphans=$(echo "${orphans:-}" | sort -u | grep -E '^[0-9]+$' || true)
if [ -n "${orphans:-}" ]; then
  echo "Killing orphan backend processes: $(echo "$orphans" | tr '\n' ' ')"
  echo "$orphans" | xargs -r kill 2>/dev/null || true
  sleep 0.4
  echo "$orphans" | xargs -r kill -9 2>/dev/null || true
fi

# Install deps only if missing
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "Installing dependencies (first run)..."
  (cd "$BACKEND_DIR" && npm install --no-audit --no-fund)
fi

# Create .env if missing, with a random JWT_SECRET
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  cat > "$ENV_FILE" <<EOF
PORT=8781
DB_PATH=./glass.db
JWT_SECRET=$SECRET

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF
  echo "Created $ENV_FILE with random JWT_SECRET and PORT=8781"
fi

PORT="$(port_from_env)"; PORT="${PORT:-8781}"
URL="$(health_url "$PORT")"

if [ "$FG" = "1" ]; then
  echo "Starting in foreground on port $PORT..."
  exec env -C "$BACKEND_DIR" npm start
fi

echo "Starting on port $PORT..."
cd "$BACKEND_DIR"
setsid node server.js >> "$LOG_FILE" 2>&1 < /dev/null &
NODE_PID=$!
disown "$NODE_PID" 2>/dev/null || true

if wait_health "$URL" 40; then
  LISTENER_PID=$(listening_pid "$PORT")
  [ -n "$LISTENER_PID" ] && NODE_PID="$LISTENER_PID"
  if [ -z "$NODE_PID" ]; then
    # fallback: any node server.js rooted in BACKEND_DIR
    for p in $(pgrep -f "node server.js" 2>/dev/null || true); do
      cwd=$(readlink -f "/proc/$p/cwd" 2>/dev/null || true)
      if [ "$cwd" = "$BACKEND_DIR" ]; then
        NODE_PID="$p"; break
      fi
    done
  fi
  [ -n "$NODE_PID" ] && echo "$NODE_PID" > "$PID_FILE"
  echo "OK running pid=${NODE_PID:-unknown}  $URL"
else
  echo "ERROR server did not become healthy within 12s. Check $LOG_FILE" >&2
  tail -n 20 "$LOG_FILE" >&2 || true
  exit 1
fi
