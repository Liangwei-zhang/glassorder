#!/usr/bin/env bash
# Backup the currently configured runtime database and uploads tree.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP_DIR="${1:-$ROOT_DIR/backups/$STAMP}"
if [ -e "$BACKUP_DIR" ] && [ -n "$(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 2>/dev/null | head -n 1)" ]; then
  echo "Backup directory already exists and is not empty: $BACKUP_DIR" >&2
  exit 1
fi
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
  if BACKEND_DIR="$BACKEND_DIR" DB_PATH="$DB_PATH" BACKUP_DB="$BACKUP_DIR/$(basename "$DB_PATH")" node <<'NODE'
const path = require('path');
const Database = require(path.join(process.env.BACKEND_DIR, 'node_modules/better-sqlite3'));
const db = new Database(process.env.DB_PATH, { readonly: true });
db.backup(process.env.BACKUP_DB)
  .then(() => db.close())
  .catch((err) => {
    try { db.close(); } catch (_) {}
    console.error(err);
    process.exit(1);
  });
NODE
  then
    :
  elif command -v sqlite3 >/dev/null 2>&1; then
    sqlite3 "$DB_PATH" ".backup '$BACKUP_DIR/$(basename "$DB_PATH")'"
  else
    cp "$DB_PATH" "$BACKUP_DIR/$(basename "$DB_PATH")"
    for suffix in -wal -shm; do
      [ -f "$DB_PATH$suffix" ] && cp "$DB_PATH$suffix" "$BACKUP_DIR/$(basename "$DB_PATH")$suffix"
    done
  fi
fi
if [ -d "$UPLOADS_PATH" ]; then
  mkdir -p "$BACKUP_DIR"
  cp -a "$UPLOADS_PATH" "$BACKUP_DIR/"
fi

echo "Backed up runtime to $BACKUP_DIR"
