#!/usr/bin/env bash
# Deploy Telegram Mini App static bundles to the production droplet.
#
# Canonical production deploy/runbook: ../deploy.md
# This script is only the Mini App static-bundle deploy path.
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

echo "→ Done. Smoke tests:"
echo "   curl -sI https://dating-calendar.gennety.com | head -1"
echo "   curl -sI https://dating-calendar.gennety.com/onboarding.html | head -1"
