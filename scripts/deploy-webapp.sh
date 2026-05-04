#!/usr/bin/env bash
# Deploy Mini App (calendar) bundle to the production droplet.
#
# Builds apps/webapp/ via Vite and rsyncs the dist/ to /var/www/dating-app/
# on the DO droplet, where Caddy serves it under
# https://dating-calendar.gennety.com.
#
# Usage:
#   ./scripts/deploy-webapp.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="root@167.172.178.229"
REMOTE_PATH="/var/www/dating-app/"

cd "$REPO_ROOT"

echo "→ Building @gennety/webapp..."
pnpm --filter @gennety/webapp build

echo "→ Rsyncing dist/ to $SERVER:$REMOTE_PATH..."
rsync -avz --delete \
  apps/webapp/dist/ \
  "$SERVER:$REMOTE_PATH"

echo "→ Done. Smoke test:"
echo "   curl -sI https://dating-calendar.gennety.com | head -1"
