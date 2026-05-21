#!/usr/bin/env bash
# Archive picked_up orders older than N days.
# Usage:
#   ./scripts/archive-old-orders.sh           # dry-run, default 90 days
#   ./scripts/archive-old-orders.sh --apply   # actually archive
#   ./scripts/archive-old-orders.sh --days 30 --apply
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND="$ROOT/backend"
ORDERS_DIR="$BACKEND/uploads/orders"
ARCHIVE_DIR="$BACKEND/uploads/archive"
DB="$BACKEND/glass.db"

DAYS=90
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --days) DAYS="$2"; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ ! -d "$ORDERS_DIR" ]; then
  echo "no orders dir, nothing to archive"; exit 0
fi
mkdir -p "$ARCHIVE_DIR"

# List candidates: picked_up and last pickup older than N days.
# Output: id<TAB>order_number<TAB>dir_name
CANDIDATES=$(DAYS_ARG="$DAYS" DB_PATH="$DB" BACKEND_PATH="$BACKEND" node -e '
const Database = require(process.env.BACKEND_PATH + "/node_modules/better-sqlite3");
const db = new Database(process.env.DB_PATH, { readonly: true });
const days = Number(process.env.DAYS_ARG);
const rows = db.prepare(
  "SELECT o.id, o.order_number, COALESCE(MAX(p.picked_at), o.created_at) AS pivot " +
  "FROM orders o LEFT JOIN pickups p ON p.order_id = o.id " +
  "WHERE o.status = @status " +
  "GROUP BY o.id " +
  "HAVING (julianday(@now) - julianday(pivot)) > @days " +
  "ORDER BY o.id"
).all({ status: "picked_up", now: "now", days });
for (const r of rows) console.log([r.id, r.order_number, r.order_number + "-" + r.id].join("\t"));
')

if [ -z "$CANDIDATES" ]; then
  echo "no eligible orders (status=picked_up older than $DAYS days)"
  exit 0
fi

count=0
archived=0
missing=0

while IFS=$'\t' read -r ID ORDNUM DIRNAME; do
  count=$((count + 1))
  SRC="$ORDERS_DIR/$DIRNAME"
  ZIP="$ARCHIVE_DIR/$DIRNAME.zip"
  if [ ! -d "$SRC" ]; then
    echo "  [skip] id=$ID dir not found: $DIRNAME"
    missing=$((missing + 1))
    continue
  fi
  if [ "$APPLY" = "1" ]; then
    if [ -f "$ZIP" ]; then
      echo "  [skip] zip already exists: $ZIP"
      continue
    fi
    (cd "$ORDERS_DIR" && zip -qr "$ZIP" "$DIRNAME")
    rm -rf "$SRC"
    # Insert event
    DB_PATH="$DB" BACKEND_PATH="$BACKEND" ID_ARG="$ID" DIR_ARG="$DIRNAME" node -e '
      const Database = require(process.env.BACKEND_PATH + "/node_modules/better-sqlite3");
      const db = new Database(process.env.DB_PATH);
      db.prepare("INSERT INTO events (order_id, piece_id, actor_id, action, details) VALUES (?, NULL, NULL, ?, ?)")
        .run(Number(process.env.ID_ARG), "order_archived", JSON.stringify({ zip_path: "/uploads/archive/" + process.env.DIR_ARG + ".zip" }));
    '
    echo "  [archive] id=$ID -> $ZIP"
    archived=$((archived + 1))
  else
    SIZE=$(du -sh "$SRC" 2>/dev/null | awk '{print $1}')
    echo "  [dry] id=$ID dir=$DIRNAME size=$SIZE"
  fi
done <<<"$CANDIDATES"

if [ "$APPLY" = "1" ]; then
  echo "DONE archived=$archived missing=$missing total=$count"
else
  echo "DRY-RUN total=$count missing=$missing  (use --apply to archive)"
fi
