#!/usr/bin/env bash
# Run smoke test against the running server. Starts it if not running.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
started_here=0

if ! running_pid >/dev/null; then
  "$SCRIPT_DIR/start.sh"
  started_here=1
fi

PORT="$(port_from_env)"; PORT="${PORT:-8781}"
BASE="http://localhost:$PORT" bash "$BACKEND_DIR/scripts/smoke.sh"
RC=$?

if [ "$started_here" = "1" ]; then
  "$SCRIPT_DIR/stop.sh" >/dev/null
fi

exit "$RC"
