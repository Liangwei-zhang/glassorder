#!/usr/bin/env bash
# Create a dedicated demo env/profile so demo and QA data don't share the default runtime.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BACKEND_DIR="$ROOT_DIR/backend"
TARGET_ENV="${1:-$BACKEND_DIR/.env.demo}"

if [ -f "$TARGET_ENV" ]; then
  echo "Exists: $TARGET_ENV"
  exit 0
fi

SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
cat > "$TARGET_ENV" <<EOF
PORT=8782
DB_PATH=./glass-demo.db
UPLOADS_DIR=./uploads-demo
JWT_SECRET=$SECRET
SEED_DEMO_USERS=1

SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM=
EOF

echo "Created demo env: $TARGET_ENV"
echo "Use with: ENV_FILE=$TARGET_ENV ./scripts/start.sh"
