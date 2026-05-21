#!/usr/bin/env bash
# Tail or print server log.
# Usage: ./scripts/logs.sh            -> tail -f
#        ./scripts/logs.sh 200        -> print last 200 lines and exit
set -euo pipefail
source "$(dirname "$0")/_common.sh"

if [ ! -f "$LOG_FILE" ]; then
  echo "No log yet at $LOG_FILE"
  exit 0
fi

if [ -n "${1:-}" ]; then
  tail -n "$1" "$LOG_FILE"
else
  tail -n 100 -f "$LOG_FILE"
fi
