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

# Install deps only if missing
if [ ! -d "$BACKEND_DIR/node_modules" ]; then
  echo "Installing dependencies (first run)..."
  (cd "$BACKEND_DIR" && npm install --no-audit --no-fund)
fi

# Create env file if missing, with a random JWT_SECRET
if [ ! -f "$ENV_FILE" ]; then
  SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  DB_FILE="./glass.db"
  UPLOADS_DIR="./uploads"
  case "$ENV_FILE" in
    *demo*.env|*.demo.env)
      DB_FILE="./glass-demo.db"
      UPLOADS_DIR="./uploads-demo"
      ;;
  esac
  cat > "$ENV_FILE" <<EOF
PORT=8781
DB_PATH=$DB_FILE
UPLOADS_DIR=$UPLOADS_DIR
JWT_SECRET=$SECRET

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF
  if [[ "$ENV_FILE" = *demo*.env || "$ENV_FILE" = *.env.demo ]]; then
    perl -0pi -e 's/^PORT=8781$/PORT=8782/m' "$ENV_FILE"
  fi
  echo "Created $ENV_FILE with random JWT_SECRET and PORT=8781"
fi

PORT="$(port_from_env)"; PORT="${PORT:-8781}"
URL="$(health_url "$PORT")"

existing_profile_pids="$(profile_pids | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
if [ -n "$existing_profile_pids" ]; then
  for p in $existing_profile_pids; do
    if pid_listens_on_port "$p" "$PORT"; then
      echo "$p" > "$PID_FILE"
      echo "Already running (pid=$p). Use ./scripts/restart.sh to restart."
      exit 0
    fi
  done
  echo "Killing stale current-profile backend processes: $existing_profile_pids"
  echo "$existing_profile_pids" | xargs -r kill 2>/dev/null || true
  sleep 0.4
  echo "$existing_profile_pids" | xargs -r kill -9 2>/dev/null || true
fi

existing_listener="$(listening_pid "$PORT")"
if [ -n "$existing_listener" ]; then
  echo "ERROR port $PORT is already used by pid=$existing_listener and it is not this profile." >&2
  exit 1
fi

if [ "$FG" = "1" ]; then
  echo "Starting in foreground on port $PORT..."
  exec env ENV_FILE="$ENV_FILE" -C "$BACKEND_DIR" node server.js
fi

echo "Starting on port $PORT..."
cd "$BACKEND_DIR"
setsid env ENV_FILE="$ENV_FILE" node server.js >> "$LOG_FILE" 2>&1 < /dev/null &
NODE_PID=$!
disown "$NODE_PID" 2>/dev/null || true

if wait_health "$URL" 40; then
  LISTENER_PID=$(listening_pid "$PORT")
  if [ -n "$LISTENER_PID" ]; then
    if pid_matches_profile "$LISTENER_PID"; then
      NODE_PID="$LISTENER_PID"
    else
      echo "ERROR health check responded on $URL, but listener pid=$LISTENER_PID is not this profile." >&2
      exit 1
    fi
  fi
  if [ -z "$NODE_PID" ]; then
    # fallback: any node server.js rooted in BACKEND_DIR with this ENV_FILE
    for p in $(pgrep -f "node server.js" 2>/dev/null || true); do
      if pid_matches_profile "$p"; then
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
