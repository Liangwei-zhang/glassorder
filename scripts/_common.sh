#!/usr/bin/env bash
# Shared helpers for start/stop/status/logs. Sourced, not executed directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
LOG_DIR="$BACKEND_DIR/logs"
PID_FILE="$BACKEND_DIR/logs/server.pid"
LOG_FILE="$BACKEND_DIR/logs/server.log"
ENV_FILE="$BACKEND_DIR/.env"

mkdir -p "$LOG_DIR"

port_from_env() {
  if [ -f "$ENV_FILE" ]; then
    awk -F= '/^PORT=/ {print $2; exit}' "$ENV_FILE" | tr -d '[:space:]'
  fi
}

running_pid() {
  if [ -f "$PID_FILE" ]; then
    local pid
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

health_url() {
  local port="${1:-$(port_from_env)}"
  port="${port:-8781}"
  echo "http://localhost:$port/api/health"
}

wait_health() {
  local url="$1"
  local tries="${2:-20}"
  for _ in $(seq 1 "$tries"); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.3
  done
  return 1
}

listening_pid() {
  # Return the PID listening on the given TCP port (IPv4 or IPv6, LISTEN state)
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -tlnpH 2>/dev/null | awk -v p=":$port" '
      index($4, p) && match($0, /pid=[0-9]+/) {
        s = substr($0, RSTART+4, RLENGTH-4); print s; exit
      }'
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -n1
  fi
}
