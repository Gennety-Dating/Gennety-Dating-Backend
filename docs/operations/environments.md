<!-- WHEN_TO_READ: You need production facts: droplet/host, paths, PM2 process, Caddy, where env files and credentials live, the dev<->prod isolation rules, or the public endpoints. Read BEFORE any deploy and before touching any env var. -->
<!-- SOURCE: deploy.md (lines 11535-11778, 11501-11534) — migrated 2026-09-01 -->

# Production environment & inventory

Deploy procedures live in [deployment-runbook.md](./deployment-runbook.md).

This file is the production runbook for the DigitalOcean deployment. It
contains the real hostnames, paths, service names, and deploy commands. Raw
secret values are intentionally not duplicated here: keep them only in the
gitignored env files and provider dashboards listed below.

## Production Inventory

| Item | Value |
|---|---|
| Droplet | DigitalOcean droplet `Gennety-Dating` |
| Public IP | `167.172.178.229` |
| SSH user | `root` |
| SSH key on this Mac | `~/.ssh/id_rsa` |
| Local repo | `/Users/pro/Desktop/Gennety Dating` |
| GitHub remote | `https://github.com/Gennety-Dating/Gennety-Dating-Backend.git` |
| Production code path | `/opt/gennety` |
| Production env file | `/opt/gennety/.env` |
| Mini App static path | `/var/www/dating-app` |
| Caddy config | `/etc/caddy/Caddyfile` |
| PM2 process | `gennety-bot` |
| PM2 cwd | `/opt/gennety` |
| PM2 command | `cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts` |
| PM2 startup service | `pm2-root.service` |

**PM2 command gotcha (2026-07-17):** the process must launch tsx via the
explicit workspace binary (`./apps/bot/node_modules/.bin/tsx`), NOT `npx tsx`.
`tsx` is a devDependency of `apps/bot` only; after the 2026-07-16 lockfile
change, `pnpm install` no longer hoists a root `node_modules/.bin/tsx`, so
`npx tsx` from `/opt/gennety` hits `tsx: not found` and PM2 crash-loops
(observed live on the 2026-07-17 deploy). Keep the cwd at `/opt/gennety` —
`.env` resolution is file-relative and unaffected, but stay consistent.

## Autonomous Deploy Rule

When asked to deploy, use this file as the canonical source and proceed without
asking for hostnames, paths, service names, Caddy routes, env-file locations, or
credential locations. Pick the deploy path from the user's wording:

- "deploy everything", "full deploy", "deploy server", or backend/code changes:
  use **Deploy Full Server Code**.
- "deploy Mini App", "deploy webapp", "calendar", or frontend-only changes:
  use **Deploy Mini App Only**.
- "env", "token", "secret", "port", or config-only changes:
  use **Deploy Env-Only Changes**.
- Prisma schema changes: run the schema step in **Deploy Full Server Code**.

Only stop to ask when access is blocked, required secrets are missing from the
documented locations, or the requested action is destructive beyond the rollback
steps documented here.

Production runtime versions verified on the droplet:

- Node.js `v20.20.2`
- pnpm `10.33.0`
- npm `10.8.2`
- PM2 `6.0.14`
- Caddy `2.6.2`

## Required Production System Dependency

Profile photo/video validation launches `ffmpeg` and `ffprobe` as operating
system processes. They are not JavaScript packages, so `pnpm install` does not
install them. The Ubuntu/Debian package named `ffmpeg` provides both commands.

Install it once on the current droplet, and repeat this step for every
replacement/rebuilt production host:

```sh
ssh root@167.172.178.229 '
  if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
  fi
  ffmpeg -version | head -n 1
  ffprobe -version | head -n 1
'
```

The long local Homebrew build on Intel macOS is not the expected production
path. Ubuntu normally installs a prebuilt `apt` package. Never set
`PROFILE_MEDIA_VALIDATION_ENABLED=true` until both production version checks
succeed.

## Dev ↔ Prod Isolation

Production is the controlled environment with real users; local dev is for
testing. Nothing may flow between them. Audited 2026-07-25 — current state:

| Resource | Dev | Prod | Isolated? |
|---|---|---|---|
| Postgres | local Docker `localhost:5434/gennety_dev` (`pnpm dev:db:up`) | Supabase `aws-0-eu-west-1.pooler…/postgres` | ✅ separate servers |
| Telegram bot | `@gennetytestbot` (token `8627…`) | `@gennetybot` (token `8707…`) | ✅ separate tokens — mandatory, long polling delivers each update to exactly one consumer |
| Supabase Storage | `selfies-dev` / `profile-photos-dev` / `chat-attachments-dev` | `selfies` / `profile-photos` / `chat-attachments` | ✅ since 2026-07-25 (same project, separate buckets) |
| OpenAI / Resend / AWS / Places | shared keys | shared keys | ⚪ stateless — no cross-contamination |
| Founder ops bot | shared `FOUNDER_BOT_TOKEN` + chat, feed OFF | same token/chat, feed ON | ✅ since 2026-07-25 — see below |
| Identity liveness | shared AWS creds; sessions are per-request | same | ✅ since 2026-07-26 — AWS Face Liveness sessions carry no shared server-side config and no webhook, so dev and prod cannot reach each other (this row used to be Persona's ⚠️) |

**Fixed 2026-07-25 — founder-feed leak (dev registrations in the real ops
DM).** There is only ONE founder bot and ONE founder chat, and `.env.local`
carried `FOUNDER_NOTIFY_ENABLED=true` with the same `FOUNDER_BOT_TOKEN` /
`FOUNDER_TELEGRAM_ID` as prod, so local test accounts were announced to the
founder exactly like real users. Confirmed: the dev DB has 2 users with
`founderNotifiedAt` set (2026-07-25 11:42 / 12:12) — both fired from
`@gennetytestbot`. Two locks now: `.env.local` (+ `.env.local.example`) sets
`FOUNDER_NOTIFY_ENABLED=false`, and `services/founder-notify.ts` hard-suppresses
the feed whenever `NODE_ENV=development` (the value `scripts/dev-bot.mjs` sets;
prod leaves `NODE_ENV` unset, and ONLY an explicit `development` mutes the
feed, so a missing value can never silence production). Everything reaching the
founder DM is therefore prod-only: new activations, freeze/delete snapshots,
weekly-match reports, scheduled-date cards, and ops alerts.

**Fixed 2026-07-25 — Supabase Storage leak.** `.env.local` overrides
`BOT_TOKEN` and `DATABASE_URL` but used to leave `SUPABASE_*` to `.env` (the
prod-like copy), so the dev bot wrote Persona selfies, mobile profile photos,
and chat images straight into the **production** buckets. Confirmed: dev user
ids `5607aa76…` / `1a357d89…` had objects in prod `selfies`. `.env.local` now
pins `SUPABASE_SELFIE_BUCKET=selfies-dev`, `SUPABASE_PHOTO_BUCKET=
profile-photos-dev`, `SUPABASE_CHAT_BUCKET=chat-attachments-dev`
(`.env.local.example` carries the same block). The URL and service key stay
shared, so a stronger isolation would be a second Supabase project for dev.

**Known residue — orphaned dev objects in the prod `selfies` bucket.** 6 of
its 8 user-id prefixes belong to no prod user row (`6efffed1…`, `5a61bdad…`,
`5607aa76…`, `4ce48f96…`, `29ed79a8…`, `1a357d89…`); only `d9731286…` and
`2a899ad8…` are real prod selfies. Deleting the six is a destructive prod
storage operation — do it deliberately, not as part of a deploy.

**Resolved 2026-07-26 — the Persona webhook cross-talk is gone.** Dev and prod
used to share one Persona template whose webhook target pointed at prod, so a
**dev** verification fired a webhook at **production** (it no-op'd on an unknown
reference-id, but it polluted the prod error log, and the dev bot never received
a webhook at all). AWS Face Liveness has no webhook and no shared template: each
session is created and read within one request, by whichever process created it.
Dev and prod share only the stateless AWS credentials, so a dev check is
invisible to prod. Billing is shared — a dev liveness check costs the same
$0.015 as a real one, which is worth remembering during test loops.

**Never** point local code at prod: keep `.env.local` present (deleting it
makes the local process load `.env`, i.e. the **production** bot token and
database), and never rsync `.env.local` to the droplet.

## Credentials And Secrets

Do not paste raw tokens, passwords, private keys, or database URLs into this
file. This repo explicitly forbids committing secrets. The deployment still has
all credential locations documented here:

| Credential | Where to get it |
|---|---|
| SSH private key | Local machine: `~/.ssh/id_rsa` |
| Production bot/env secrets | Droplet: `/opt/gennety/.env` |
| Local production env copy | Local repo: `.env` |
| Local dev overrides | Local repo: `.env.local` |
| DigitalOcean access | DigitalOcean dashboard for droplet `Gennety-Dating` |
| DNS | Hostinger DNS for `gennety.com` |
| Telegram production bot | BotFather entry for `@gennetybot`; token is `BOT_TOKEN` |
| Telegram dev bot | BotFather entry for `@gennetytestbot`; token is in `.env.local` |
| Supabase Postgres/storage | Supabase dashboard; URL/key values are in `.env` / `/opt/gennety/.env` |
| OpenAI | OpenAI dashboard; key is `OPENAI_API_KEY` |
| Resend | Resend dashboard; key is `RESEND_API_KEY` |
| AWS Face Liveness | Same IAM user as Rekognition (`gennety-bot-rekognition`) plus the `GennetyLivenessClient` role — see "Verification production gate" |
| AWS Rekognition | AWS IAM user `gennety-bot-rekognition` |
| Google Places | Google Cloud API key `PLACES_API_KEY` |
| APNs push (native iOS) | Apple Developer → Certificates → Keys: `.p8` APNs Auth Key (`APNS_KEY_PATH` on the droplet) + Key ID + Team ID |
| Twilio Verify (primary phone rail) | Twilio console; `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` |
| Telegram Gateway (optional secondary) | gateway.telegram.org (login with the founder's Telegram); token is `TELEGRAM_GATEWAY_TOKEN` |

SSH connect:

```sh
ssh root@167.172.178.229
```

SSH connect with explicit key:

```sh
ssh -i ~/.ssh/id_rsa root@167.172.178.229
```

List configured production env keys without printing values:

```sh
ssh root@167.172.178.229 'cut -d= -f1 /opt/gennety/.env'
```

Edit production env:

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
```

Important: production and local development must never share `BOT_TOKEN`.
Telegram long polling sends each update to only one consumer, so a local
process using the production token can steal updates from production.

## Production Endpoints

| Endpoint | Target | Purpose |
|---|---|---|
| `https://dating-api.gennety.com` | Caddy -> `localhost:3101` | Public `/v1/*` API for the mobile app and the Telegram Mini Apps |
| `https://api-admin.gennety.com` | Caddy -> `localhost:3100` | Admin analytics API, `ADMIN_API_KEY` bearer auth |
| `https://dating-calendar.gennety.com` | `/var/www/dating-app` | Telegram Mini App static bundles |
| `@gennetybot` | PM2 process `gennety-bot` | Production Telegram bot, long polling |

There is no identity-provider webhook any more: Face Liveness verdicts are read
server-to-server inside the client's `/event` request (the session expires 3
minutes after it is minted). `/v1/webhooks/persona` was removed — Persona's
dashboard webhook can be deleted on their side.

Known Caddy config:

```caddyfile
api-admin.gennety.com {
    reverse_proxy localhost:3100
}

dating-api.gennety.com {
    reverse_proxy /v1/* localhost:3101
}

dating-calendar.gennety.com {
    root * /var/www/dating-app
    file_server
    encode gzip zstd
    try_files {path} /index.html

    header {
        Strict-Transport-Security "max-age=31536000; includeSubDomains"
        X-Content-Type-Options "nosniff"
        Referrer-Policy "strict-origin-when-cross-origin"
        -Server
    }

    @assets path *.js *.css *.svg *.png *.woff2
    header @assets Cache-Control "public, max-age=31536000, immutable"
    header /index.html Cache-Control "no-cache"
}
```


## Deploy history (most recent full deploys)

Prior full deploy: 2026-07-21 (**Gennety Premium launch**:
recurring Telegram Stars + StoreKit subscription, venue-change premium tier.
`PREMIUM_FEATURE_ENABLED=true` + `PREMIUM_STARS=500` / `PREMIUM_PRICE_USD_DISPLAY=$10`
/ `PREMIUM_APPSTORE_PRODUCT_ID=premium_monthly` added; Mini App redeployed
(`premium.html` + reworked `venue-change.html`); Kyiv premium catalog imported
(70 premium venues, 14/domain × 5 domains); `features.premium: true` live,
`/v1/premium/state` → 401 (mounted+on). **Schema applied additively via
`prisma db execute`, NOT `db:push`:** the prod DB still carries the obsolete
`web_registration_links` table (6 rows) + `WebRegistrationPurpose` enum from the
2026-07-19 web-registration removal, so a plain `db:push` demands
`--accept-data-loss` to drop them. To keep the Premium launch additive-only, the
five premium ALTER/CREATE statements (`users.premium_*`, `curated_venues.tier`,
`matches.venue_change_tier`, `subscription_ledger`) were generated with
`prisma migrate diff` and run via `prisma db execute`, filtering out the two
DROP statements. **Follow-up (separate, founder-approved):** run
`prisma db push --accept-data-loss` to drop the dead `web_registration_links`
table + enum once you're comfortable — no code reads them (PRODUCT_SPEC §1.1).
Prior full deploys: 2026-07-18 (iOS Stage 0 backend slice:
`/v1/app/config`, phone rail `/v1/auth/phone/*` (Gateway/Twilio creds not yet
set → clean 503), direct APNs transport with the live `.p8` key at
`/opt/gennety/keys/AuthKey_JTLFAQ8RM2.p8` (sandbox probe returned
`BadDeviceToken` = provider auth verified), additive `db:push` of
`phone_otps` + `live_activity_tokens`, and the advisory-lock P2010 hotfix —
see the Prisma gotcha below). Prior full deploys: 2026-07-17 (security/i18n
+ `ALLOW_SANDBOX_PERSONA=true`; PM2 command changed to the explicit tsx
binary path — see the PM2 gotcha in Production Inventory), 2026-07-15,
2026-07-13.

**Prisma raw-SQL gotcha (2026-07-18):** `pg_advisory_xact_lock(...)` returns
`void`, and Prisma 6.19+ throws P2010 ("Failed to deserialize column of type
'void'") when it is run through `$queryRawUnsafe`. Use `$executeRawUnsafe`
for lock/side-effect statements — it skips result deserialization. This bit
the phone rail's first live probe and was latent in the email-OTP path.
