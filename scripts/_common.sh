#!/usr/bin/env bash
# Shared helpers for start/stop/status/logs. Sourced, not executed directly.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
LOG_DIR="$BACKEND_DIR/logs"
ENV_FILE="${ENV_FILE:-$BACKEND_DIR/.env}"
case "$ENV_FILE" in
  /*) ;;
  *) ENV_FILE="$ROOT_DIR/$ENV_FILE" ;;
esac
ENV_BASENAME="$(basename "$ENV_FILE")"
PROFILE_SUFFIX=""
if [ "$ENV_BASENAME" != ".env" ]; then
  profile_name="$(printf '%s' "$ENV_BASENAME" | sed -E 's/^\.env[._-]?//; s/\.env$//; s/[^A-Za-z0-9._-]+/-/g; s/^-+|-+$//g')"
  [ -n "$profile_name" ] && PROFILE_SUFFIX="-$profile_name"
fi
PID_FILE="$BACKEND_DIR/logs/server${PROFILE_SUFFIX}.pid"
LOG_FILE="$BACKEND_DIR/logs/server${PROFILE_SUFFIX}.log"

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
    if [ -n "${pid:-}" ] && kill -0 "$pid" 2>/dev/null && pid_matches_profile "$pid"; then
      echo "$pid"
      return 0
    fi
  fi
  return 1
}

pid_env_file() {
  local pid="$1"
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | awk -F= '/^ENV_FILE=/ {print $2; exit}' || true
}

pid_cwd() {
  local pid="$1"
  readlink -f "/proc/$pid/cwd" 2>/dev/null || true
}

pid_matches_profile() {
  local pid="$1"
  [ -n "$pid" ] || return 1
  [ "$(pid_cwd "$pid")" = "$BACKEND_DIR" ] || return 1
  [ "$(pid_env_file "$pid")" = "$ENV_FILE" ] || return 1
}

profile_pids() {
  local p
  for p in $(pgrep -f "node server.js" 2>/dev/null || true); do
    if pid_matches_profile "$p"; then
      echo "$p"
    fi
  done
}

pid_listens_on_port() {
  local pid="$1"
  local port="$2"
  [ -n "$pid" ] && [ -n "$port" ] || return 1
  if command -v ss >/dev/null 2>&1; then
    ss -tlnpH 2>/dev/null | awk -v p=":$port" -v pid="pid=$pid" '
      index($4, p) && index($0, pid) { found = 1 }
      END { exit found ? 0 : 1 }
    '
  elif command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | grep -qx "$pid"
  else
    return 1
  fi
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
