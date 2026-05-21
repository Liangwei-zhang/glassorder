#!/usr/bin/env bash
# Report status and health.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

PORT="$(port_from_env)"; PORT="${PORT:-8781}"
URL="$(health_url "$PORT")"

if pid=$(running_pid); then
  echo "RUNNING  pid=$pid  port=$PORT"
else
  echo "STOPPED  (no live pid)"
fi

if curl -fsS "$URL" >/dev/null 2>&1; then
  echo "HEALTH   $URL -> $(curl -fsS "$URL")"
else
  echo "HEALTH   $URL -> unreachable"
fi

# show what's listening on the port
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | awk -v p=":$PORT" 'index($4, p) {print "LISTEN  " $0}' || true
fi

echo "PID_FILE $PID_FILE"
echo "LOG_FILE $LOG_FILE"
