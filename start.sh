#!/usr/bin/env bash
# One-command launcher for the Glass Order app.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${ENV_FILE:-backend/.env}"
export ENV_FILE

"$ROOT_DIR/scripts/start.sh"

ENV_PATH="$ENV_FILE"
case "$ENV_PATH" in
  /*) ;;
  *) ENV_PATH="$ROOT_DIR/$ENV_PATH" ;;
esac

PORT="$(awk -F= '/^PORT=/ {print $2; exit}' "$ENV_PATH" 2>/dev/null | tr -d '[:space:]' || true)"
PORT="${PORT:-8781}"
URL="http://localhost:$PORT"

echo
echo "Glass Order is ready:"
echo "  $URL"
echo
echo "Accounts:"
echo "  admin   admin / admin123"
echo "  worker  worker / worker123"
echo
echo "Useful commands:"
echo "  ./scripts/status.sh"
echo "  ./scripts/logs.sh"
echo "  ./scripts/stop.sh"

if [ "${OPEN_BROWSER:-1}" != "0" ] && [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ]; then
  if command -v xdg-open >/dev/null 2>&1; then
    (xdg-open "$URL" >/dev/null 2>&1 &)
  elif command -v gio >/dev/null 2>&1; then
    (gio open "$URL" >/dev/null 2>&1 &)
  fi
fi
