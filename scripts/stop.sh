#!/usr/bin/env bash
# Stop the Glass Order backend.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

if pid=$(running_pid); then
  echo "Stopping pid=$pid..."
  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "Force killing pid=$pid"
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  stale="$(profile_pids | sort -u | grep -v "^$pid$" | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [ -n "$stale" ]; then
    echo "Stopping additional current-profile processes: $stale"
    echo "$stale" | xargs -r kill 2>/dev/null || true
    sleep 0.2
    echo "$stale" | xargs -r kill -9 2>/dev/null || true
  fi
  echo "Stopped."
else
  # best-effort cleanup for this profile even if pidfile is missing
  stale="$(profile_pids | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
  if [ -n "$stale" ]; then
    echo "No pidfile but found stale node processes: $stale — killing."
    echo "$stale" | xargs -r kill 2>/dev/null || true
  else
    echo "Not running."
  fi
  rm -f "$PID_FILE"
fi
