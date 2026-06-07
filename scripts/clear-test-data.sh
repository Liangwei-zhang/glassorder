#!/usr/bin/env bash
# Clear business/test data from the current runtime while preserving users and migrations.
set -euo pipefail
source "$(dirname "$0")/_common.sh"

APPLY=0
NO_BACKUP=0
RESTART_AFTER=1
BACKUP_DIR=""
WAS_RUNNING=0
CLEAR_COMPLETED=0

usage() {
  cat <<'EOF'
Usage:
  ./scripts/clear-test-data.sh                 # dry-run only
  CONFIRM_CLEAR_TEST_DATA=1 ./scripts/clear-test-data.sh --apply
  CONFIRM_CLEAR_TEST_DATA=1 ENV_FILE=backend/.env.demo ./scripts/clear-test-data.sh --apply

Options:
  --apply              Actually clear data. Requires CONFIRM_CLEAR_TEST_DATA=1.
  --no-backup          Skip backup. Requires ALLOW_CLEAR_WITHOUT_BACKUP=1.
  --no-restart         Do not restart the backend after clearing.
  --backup-dir <dir>   Backup target directory.
  -h, --help           Show help.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --no-backup) NO_BACKUP=1 ;;
    --no-restart) RESTART_AFTER=0 ;;
    --backup-dir)
      shift
      BACKUP_DIR="${1:-}"
      [ -n "$BACKUP_DIR" ] || { echo "Missing --backup-dir value" >&2; exit 2; }
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

DB_REL="$(awk -F= '/^DB_PATH=/ {print $2; exit}' "$ENV_FILE" 2>/dev/null | tr -d '[:space:]')"
UPLOADS_REL="$(awk -F= '/^UPLOADS_DIR=/ {print $2; exit}' "$ENV_FILE" 2>/dev/null | tr -d '[:space:]')"
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

real_or_abs() {
  local p="$1"
  if [ -e "$p" ]; then
    readlink -f "$p"
  else
    local parent
    parent="$(dirname "$p")"
    printf '%s/%s\n' "$(readlink -f "$parent")" "$(basename "$p")"
  fi
}

DB_PATH="$(real_or_abs "$(resolve_under_backend "$DB_REL")")"
UPLOADS_PATH="$(real_or_abs "$(resolve_under_backend "$UPLOADS_REL")")"
BACKEND_REAL="$(readlink -f "$BACKEND_DIR")"
ROOT_REAL="$(readlink -f "$ROOT_DIR")"
HOME_REAL="$(readlink -f "$HOME")"
export NODE_PATH="$BACKEND_DIR/node_modules${NODE_PATH:+:$NODE_PATH}"

[ -f "$DB_PATH" ] || { echo "DB not found: $DB_PATH" >&2; exit 1; }

DB_BASE="$(basename "$DB_PATH")"
case "$DB_BASE" in
  glass*.db) ;;
  *)
    echo "Refusing to clear DB with unexpected basename: $DB_PATH" >&2
    echo "Expected database basename matching 'glass*.db'." >&2
    exit 1
    ;;
esac

UPLOADS_BASE="$(basename "$UPLOADS_PATH")"
case "$UPLOADS_BASE" in
  uploads|uploads-*) ;;
  *)
    echo "Refusing to clear uploads path with unexpected basename: $UPLOADS_PATH" >&2
    echo "Expected basename 'uploads' or 'uploads-*'." >&2
    exit 1
    ;;
esac

case "$UPLOADS_PATH" in
  "/"|"$HOME_REAL"|"$ROOT_REAL"|"$BACKEND_REAL")
    echo "Refusing unsafe uploads path: $UPLOADS_PATH" >&2
    exit 1
    ;;
esac

BUSINESS_TABLES=(
  pickup_items
  pickup_batches
  pickups
  events
  pieces
  orders
  customers
  pickup_batch_counters
)
PRESERVED_TABLES=(users schema_migrations)
KNOWN_TABLES=(
  "${BUSINESS_TABLES[@]}"
  "${PRESERVED_TABLES[@]}"
)

validate_schema_scope() {
  node - "$DB_PATH" "$BACKEND_DIR" "${KNOWN_TABLES[@]}" <<'NODE'
const path = require('path');
const Database = require(path.join(process.argv[3], 'node_modules/better-sqlite3'));
const db = new Database(process.argv[2], { readonly: true });
const known = new Set(process.argv.slice(4));
const rows = db.prepare(`
  SELECT name
  FROM sqlite_master
  WHERE type = 'table'
    AND name NOT LIKE 'sqlite_%'
  ORDER BY name
`).all().map((row) => row.name);
const unknown = rows.filter((name) => !known.has(name));
db.close();
if (unknown.length) {
  console.error(`Unknown tables found; refusing to clear until script scope is reviewed: ${unknown.join(', ')}`);
  process.exit(1);
}
NODE
}

count_json() {
  node - "$DB_PATH" "$BACKEND_DIR" <<'NODE'
const path = require('path');
const Database = require(path.join(process.argv[3], 'node_modules/better-sqlite3'));
const db = new Database(process.argv[2], { readonly: true });
const tables = [
  'customers', 'orders', 'pieces', 'events', 'pickups',
  'pickup_batches', 'pickup_items', 'pickup_batch_counters',
  'users', 'schema_migrations'
];
const out = {};
for (const table of tables) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
db.close();
console.log(JSON.stringify(out));
NODE
}

upload_count() {
  if [ -d "$UPLOADS_PATH" ]; then
    find "$UPLOADS_PATH" -mindepth 1 -type f | wc -l | tr -d '[:space:]'
  else
    printf '0'
  fi
}

validate_schema_scope
before_json="$(count_json)"
before_uploads="$(upload_count)"

echo "Runtime profile: $ENV_FILE"
echo "DB: $DB_PATH"
echo "Uploads: $UPLOADS_PATH"
echo "Business tables to clear: ${BUSINESS_TABLES[*]}"
echo "Preserved tables: ${PRESERVED_TABLES[*]}"
echo "Counts before: $before_json"
echo "Upload files before: $before_uploads"

if [ "$APPLY" != "1" ]; then
  echo "DRY RUN ONLY. Re-run with --apply to clear business data."
  exit 0
fi

if [ "${CONFIRM_CLEAR_TEST_DATA:-}" != "1" ]; then
  echo "Refusing to clear without CONFIRM_CLEAR_TEST_DATA=1." >&2
  exit 1
fi

if running_pid >/dev/null; then
  WAS_RUNNING=1
fi

cleanup_on_error() {
  local code=$?
  if [ "$code" -ne 0 ] && [ "$APPLY" = "1" ] && [ "$WAS_RUNNING" = "1" ] && [ "$CLEAR_COMPLETED" != "1" ]; then
    echo "Clear failed before completion; attempting to restart previously running profile..." >&2
    "$ROOT_DIR/scripts/start.sh" >/dev/null 2>&1 || true
  fi
}
trap cleanup_on_error EXIT

"$ROOT_DIR/scripts/stop.sh" >/dev/null || true

remaining_pids="$(profile_pids | sort -u | tr '\n' ' ' | sed 's/[[:space:]]*$//')"
if [ -n "$remaining_pids" ]; then
  echo "Refusing to clear while current-profile backend processes are still running: $remaining_pids" >&2
  exit 1
fi

if [ "$NO_BACKUP" != "1" ]; then
  if [ -z "$BACKUP_DIR" ]; then
    BACKUP_DIR="$ROOT_DIR/backups/$(date +%Y%m%d-%H%M%S)-clear"
  fi
  if [ -n "$BACKUP_DIR" ]; then
    "$ROOT_DIR/scripts/backup-runtime.sh" "$BACKUP_DIR"
  fi
  node - "$BACKUP_DIR/$(basename "$DB_PATH")" "$BACKEND_DIR" <<'NODE'
const path = require('path');
const fs = require('fs');
const backupPath = process.argv[2];
const backendDir = process.argv[3];
if (!fs.existsSync(backupPath)) throw new Error(`backup DB missing: ${backupPath}`);
const Database = require(path.join(backendDir, 'node_modules/better-sqlite3'));
const db = new Database(backupPath, { readonly: true });
for (const table of ['users', 'schema_migrations', 'customers', 'orders']) {
  db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
}
  db.close();
NODE
elif [ "${ALLOW_CLEAR_WITHOUT_BACKUP:-}" != "1" ]; then
  echo "Refusing --no-backup unless ALLOW_CLEAR_WITHOUT_BACKUP=1 is set." >&2
  exit 1
fi

node - "$DB_PATH" "$UPLOADS_PATH" "$BACKEND_DIR" <<'NODE'
const fs = require('fs');
const path = require('path');
const Database = require(path.join(process.argv[4], 'node_modules/better-sqlite3'));

const dbPath = process.argv[2];
const uploadsDir = process.argv[3];
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

const businessTables = [
  'pickup_items',
  'pickup_batches',
  'pickups',
  'events',
  'pieces',
  'orders',
  'customers',
  'pickup_batch_counters',
];

const clearDb = db.transaction(() => {
  for (const table of businessTables) db.prepare(`DELETE FROM ${table}`).run();
  for (const table of businessTables.filter((table) => table !== 'pickup_batch_counters')) {
    db.prepare('DELETE FROM sqlite_sequence WHERE name = ?').run(table);
  }
});

clearDb();
db.pragma('wal_checkpoint(TRUNCATE)');
db.exec('VACUUM');
db.close();

fs.mkdirSync(uploadsDir, { recursive: true });
for (const name of fs.readdirSync(uploadsDir)) {
  fs.rmSync(path.join(uploadsDir, name), { recursive: true, force: true });
}
for (const name of ['orders', 'pdfs', 'signatures', 'slips']) {
  fs.mkdirSync(path.join(uploadsDir, name), { recursive: true });
}
NODE

after_json="$(count_json)"
after_uploads="$(upload_count)"
echo "Counts after: $after_json"
echo "Upload files after: $after_uploads"

node - "$after_json" "$after_uploads" <<'NODE'
const counts = JSON.parse(process.argv[2]);
const uploads = Number(process.argv[3]);
const cleared = [
  'customers', 'orders', 'pieces', 'events', 'pickups',
  'pickup_batches', 'pickup_items', 'pickup_batch_counters'
];
for (const table of cleared) {
  if (counts[table] !== 0) throw new Error(`${table} was not cleared: ${counts[table]}`);
}
if (counts.users < 1) throw new Error('users table must be preserved');
if (counts.schema_migrations < 1) throw new Error('schema_migrations table must be preserved');
if (uploads !== 0) throw new Error(`uploads still contains files: ${uploads}`);
NODE

if [ "$RESTART_AFTER" = "1" ]; then
  "$ROOT_DIR/scripts/start.sh"
fi

CLEAR_COMPLETED=1
