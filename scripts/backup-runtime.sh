#!/usr/bin/env bash
# Backup the currently configured runtime database and uploads tree.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${1:-$ROOT_DIR/backups/$STAMP}"
mkdir -p "$BACKUP_DIR"

DB_REL="$(awk -F= '/^DB_PATH=/ {print $2; exit}' "$ENV_FILE" | tr -d '[:space:]')"
UPLOADS_REL="$(awk -F= '/^UPLOADS_DIR=/ {print $2; exit}' "$ENV_FILE" | tr -d '[:space:]')"
[ -n "$DB_REL" ] || DB_REL="./glass.db"
[ -n "$UPLOADS_REL" ] || UPLOADS_REL="./uploads"

resolve_under_backend() {
  local rel="$1"
  if [[ "$rel" = /* ]]; then
    printf '%s\n' "$rel"
  else
    printf '%s\n' "$BACKEND_DIR/${rel#./}"
  fi
}

DB_PATH="$(resolve_under_backend "$DB_REL")"
UPLOADS_PATH="$(resolve_under_backend "$UPLOADS_REL")"

if [ -f "$DB_PATH" ]; then
  cp "$DB_PATH" "$BACKUP_DIR/$(basename "$DB_PATH")"
fi
if [ -d "$UPLOADS_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  cp -a "$UPLOADS_PATH" "$BACKUP_DIR/"
fi

echo "Backed up runtime to $BACKUP_DIR"
