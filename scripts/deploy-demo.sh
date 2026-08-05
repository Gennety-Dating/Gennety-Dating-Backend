#!/usr/bin/env bash
# Deploy the demo-mode bot + its Mini App bundle to the production droplet.
#
# Canonical runbook: ../deploy.md → "Deploy Demo Mode". Design: ../DEMO_MODE.md
#
# This is a SECOND deployment of the same source tree, into its own directory,
# with its own .env (own bot token, own database, own port). Running it is what
# keeps the demo in step with production — same code, same Mini App, one extra
# command per release.
#
# Run it AFTER the production deploy has been verified.
#
# Usage:
#   ./scripts/deploy-demo.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER="root@167.172.178.229"
REMOTE_PATH="/opt/gennety-demo"
WEBAPP_PATH="/var/www/demo-app/"
DEMO_API_BASE="https://demo-api.gennety.com"

cd "$REPO_ROOT"

echo "→ Dry-run rsync (every line below is a file that WOULD be deleted)…"
# Same exclude list as production. `.env*` covers the demo's own .env and its
# .bak rollback snapshots; `keys/` holds server-only Apple secrets. Both would
# otherwise be destroyed by --delete.
RSYNC_EXCLUDES=(
  --exclude '.git/'
  --exclude 'node_modules/'
  --exclude 'dist/'
  --exclude 'tmp/'
  --exclude '.env*'
  --exclude 'keys/'
  --exclude '*-backup-*.json'
  --exclude 'prod-backup-*.json'
  --exclude '*.bak.*'
  --exclude '.claude/'
  --exclude '.agents/'
  --exclude '.codex/'
  --exclude '.gstack/'
)
rsync -az --delete --dry-run --itemize-changes "${RSYNC_EXCLUDES[@]}" \
  ./ "$SERVER:$REMOTE_PATH/" | grep '^\*deleting' || echo "   (nothing to delete)"

echo "→ Syncing source to $SERVER:$REMOTE_PATH…"
rsync -az --delete "${RSYNC_EXCLUDES[@]}" ./ "$SERVER:$REMOTE_PATH/"

echo "→ Installing, generating Prisma client, building…"
ssh "$SERVER" "cd $REMOTE_PATH && pnpm install --frozen-lockfile && pnpm --filter @gennety/db db:generate && pnpm build"

# The demo runs the same Prisma schema against its own database, so a schema
# change has to be pushed to BOTH. `db:drift-check` is the gate: a demo database
# missing a column throws P2022 at runtime, which surfaces as a PM2 crash loop
# rather than a clean error.
echo "→ Pushing schema to the demo database and checking for drift…"
ssh "$SERVER" "cd $REMOTE_PATH && export DATABASE_URL=\"\$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '\"')\" && pnpm --filter @gennety/db db:push && pnpm db:drift-check"

echo "→ Restarting the demo process…"
ssh "$SERVER" "cd $REMOTE_PATH && pm2 restart gennety-demo --update-env && pm2 save"

# The Mini App bakes its API base at build time (apps/webapp/src/api.ts), so the
# demo needs its own build pointed at the demo API. Same source, same components
# — a visual change ships to both from one checkout.
echo "→ Building the demo Mini App bundle (API base: $DEMO_API_BASE)…"
VITE_API_BASE_URL="$DEMO_API_BASE" pnpm --filter @gennety/webapp build

echo "→ Syncing the Mini App bundle to $SERVER:$WEBAPP_PATH…"
rsync -avz --delete apps/webapp/dist/ "$SERVER:$WEBAPP_PATH"

# Leave the working tree's dist/ matching PRODUCTION, so a later
# ./scripts/deploy-webapp.sh run can never ship a demo-pointed bundle to the
# real Mini App host if someone skips its build step.
echo "→ Rebuilding dist/ back to the production API base…"
pnpm --filter @gennety/webapp build

echo
echo "→ Done. Smoke tests:"
echo "   ssh $SERVER 'pm2 logs gennety-demo --lines 40 --nostream'"
echo "   curl -s $DEMO_API_BASE/v1/ping"
echo "   curl -sI https://demo-app.gennety.com/onboarding.html | head -1"
echo "   # The first log lines must carry the DEMO MODE banner naming the"
echo "   # demo bot and the demo database. If they name production — stop."
