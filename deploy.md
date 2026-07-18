# Gennety Dating Deploy

Last verified: 2026-07-17 (full server deploy — the 2026-07-16 security/i18n
series + `ALLOW_SANDBOX_PERSONA=true` interim override; no schema change. The
PM2 command changed to the explicit tsx binary path — see the PM2 gotcha in
Production Inventory). Prior full deploys: 2026-07-15 (server + Mini App +
additive schema push), 2026-07-13.

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
| Persona | Persona dashboard; current env comments say sandbox credentials |
| AWS Rekognition | AWS IAM user `gennety-bot-rekognition` |
| Google Places | Google Cloud API key `PLACES_API_KEY` |
| APNs push (native iOS) | Apple Developer → Certificates → Keys: `.p8` APNs Auth Key (`APNS_KEY_PATH` on the droplet) + Key ID + Team ID |
| Telegram Gateway | gateway.telegram.org (login with the founder's Telegram); token is `TELEGRAM_GATEWAY_TOKEN` |
| Twilio Verify | Twilio console; `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` |

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
| `https://dating-api.gennety.com` | Caddy -> `localhost:3101` | Public `/v1/*` API for mobile app and Persona webhook |
| `https://api-admin.gennety.com` | Caddy -> `localhost:3100` | Admin analytics API, `ADMIN_API_KEY` bearer auth |
| `https://dating-calendar.gennety.com` | `/var/www/dating-app` | Telegram Mini App static bundles |
| `@gennetybot` | PM2 process `gennety-bot` | Production Telegram bot, long polling |

Persona production webhook target:

```text
https://dating-api.gennety.com/v1/webhooks/persona
```

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

## Preflight Before Deploy

Run from the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
git status --short
pnpm install
pnpm test
pnpm build
```

Identity and profile-media validation preflight:

```sh
ffmpeg -version
ffprobe -version
# The process must refuse to boot unless all of these are production-ready:
grep -E '^(MANDATORY_VERIFICATION_ENABLED|ENABLE_PERSONA_VERIFICATION|FACE_MATCH_PROVIDER|PROFILE_MEDIA_VALIDATION_ENABLED)=' .env
```

These local checks do not prove that the production droplet has the package.
Run the server-side installation/check in **Required Production System
Dependency** during the production rollout.

Verify the three narrow Rekognition actions and run consenting/synthetic QA
media before deployment. Production must have
`MANDATORY_VERIFICATION_ENABLED=true`, `ENABLE_PERSONA_VERIFICATION=true`, a
non-sandbox Persona key, `FACE_MATCH_PROVIDER=rekognition`, and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. The process now fails closed before
starting if any trust boundary is weakened. An identity-provider outage is not
rolled back by disabling verification; pause new onboarding or roll back code
while keeping existing verified users safe.

For narrow code changes, file-scoped tests are acceptable before the full build:

```sh
pnpm vitest run path/to/file.test.ts
pnpm tsc --noEmit --project apps/bot/tsconfig.json
```

Check production is reachable before changing it:

```sh
ssh root@167.172.178.229 'pm2 status'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Expected smoke results:

- `dating-api.gennety.com/v1/ping` returns JSON with `"ok": true`.
- `dating-calendar.gennety.com` returns HTTP `200`.
- `dating-calendar.gennety.com/onboarding.html` returns HTTP `200`.
- `dating-calendar.gennety.com/verification.html` returns HTTP `200`.
- `dating-calendar.gennety.com/ticket.html` returns HTTP `200`.
- `dating-calendar.gennety.com/venue-change.html` returns HTTP `200`.
- `api-admin.gennety.com` returns HTTP `401` without bearer auth.

## Deploy Full Server Code

The droplet path `/opt/gennety` is not a git checkout. Deploy by syncing the
local working tree to the server while preserving remote env files.

From the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"

rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'tmp/' \
  --exclude '.env' \
  --exclude '.env.local' \
  --exclude '.env.test' \
  ./ root@167.172.178.229:/opt/gennety/
```

Then install, validate, and restart on the droplet:

```sh
ssh root@167.172.178.229
cd /opt/gennety

# Required once per production host. Safe to keep in the deploy checklist:
# installation is skipped when both commands already exist.
if ! command -v ffmpeg >/dev/null || ! command -v ffprobe >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ffmpeg
fi
ffmpeg -version | head -n 1
ffprobe -version | head -n 1

pnpm install --frozen-lockfile
pnpm --filter @gennety/db db:generate
pnpm build
```

If `packages/db/prisma/schema.prisma` changed, update the production database
schema before restarting the bot. The Prisma CLI runs inside `packages/db` and
does **not** read the root `/opt/gennety/.env`, so `DATABASE_URL` must be passed
in explicitly — without it `db:push` fails with `P1012: Environment variable not
found: DATABASE_URL`:

```sh
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm --filter @gennety/db db:push
```

There is no Prisma migrations directory in this repo at the moment, so the
current workflow is Prisma `db:push`. Before risky schema changes, take a
Supabase backup from the Supabase dashboard. The droplet currently does not
have `pg_dump` installed.

Prisma refuses to add a `@unique` column without `--accept-data-loss`, even when
the column is brand new (it cannot know the column will be all-`NULL`). Before
reaching for that flag, confirm the change is genuinely additive — the deploy is
only safe if **both** hold:

```sh
# 1. No column/model removals in the schema diff (empty output = additive only):
diff -u <(ssh root@167.172.178.229 'cat /opt/gennety/packages/db/prisma/schema.prisma') \
        packages/db/prisma/schema.prisma | grep '^-' | grep -v '^---' | grep -vE '^-\s*(///)?\s*$'
# 2. The new unique columns do not yet exist in the *public* schema (Supabase's
#    auth.users has its own `phone` column — always filter on table_schema).
```

Then run `pnpm --filter @gennety/db db:push --accept-data-loss`.

**Schema drift is a real failure mode here.** A production DB missing a column
the code reads throws `P2022` as an *unhandled rejection*, which kills the
process — an unnoticed drift shows up as a PM2 restart loop, not as a clean
error. If `pm2 status` shows a climbing restart count, check
`grep P2022 /root/.pm2/logs/gennety-bot-error.log` before anything else; a
`db:push` is the fix.

Restart after the code and any required schema update are both in place:

```sh
pm2 restart gennety-bot --update-env
pm2 save
```

## Deploy Mini App Only

Use the existing script:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
./scripts/deploy-webapp.sh
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
```

The script builds `apps/webapp` with Vite and rsyncs:

```text
apps/webapp/dist/ -> root@167.172.178.229:/var/www/dating-app/
```

Vite is configured for multiple entries (`vite.config.ts`), so the same rsync
deploys the Mini Apps together — `index.html` (calendar), `feedback.html`
(post-date feedback), `location.html` (venue handoff), `onboarding.html`
(full-screen Telegram onboarding), `verification.html` (Persona
Embedded SDK KYC flow), `ticket.html` (Date Ticket, feature-flagged
premium post-accept gate), `tickets.html` (ticket store / wallet,
feature-flagged pre-purchase bundles), and `venue-change.html` (feature-flagged
female-exclusive venue swap). Caddy's `try_files {path} /index.html` resolves
direct hits like `/feedback.html` and `/onboarding.html` before the SPA
fallback.

Persona embedded flow needs two one-time setup steps on the provider side
(they don't affect rsync output, but skipping either breaks the Mini App):
1. **BotFather** `/setdomain` → `dating-calendar.gennety.com` for
   `@gennetybot`. Without this, the Mini App can't request camera
   permissions inside the Telegram WebView.
2. **Persona Dashboard** → Embedded flow → Allowed origins must include
   `https://dating-calendar.gennety.com`. Without this, the SDK rejects
   the iframe mount with a CORS error.

The webapp production build bakes in:

```text
VITE_API_BASE_URL=https://dating-api.gennety.com
```

## Deploy Env-Only Changes

```sh
ssh root@167.172.178.229
cd /opt/gennety
cp .env ".env.bak.$(date +%Y%m%d-%H%M%S)"
nano .env
pm2 restart gennety-bot --update-env
pm2 save
pm2 logs gennety-bot --lines 80 --nostream
curl -s https://dating-api.gennety.com/v1/ping
```

### Production flag state last observed (2026-07-13)

Every product feature is now **on** in `/opt/gennety/.env`: tickets + Telegram
Stars, Registration v2's phone track, the fact collector (which is what actually
feeds the matching engine's vibe axes), Elo vision seed, pre-date coordination,
venue change v2, the date card, the match card, and Rekognition face-match.

`ENABLE_PERSONA_VERIFICATION` was on, while
`MANDATORY_VERIFICATION_ENABLED` was still off. After the identity trust-gate
hardening that state stopped booting; as of 2026-07-17
`MANDATORY_VERIFICATION_ENABLED=true` is set and production runs the sandbox
Persona key behind the explicit `ALLOW_SANDBOX_PERSONA=true` override (see
"Verification production gate" below).

**Provider credentials, verified by probing each one from the droplet** (a flag
is worthless without its provider):

| Credential | State | Consequence |
|---|---|---|
| Supabase (DB + Storage) | **migrated 2026-07-13 to a new project** — see below | Storage works for the first time (the old project's keys were never filled in — they were the literal `your_supabase_…` placeholders from `.env.example`, so uploads 403'd with `Invalid Compact JWS`). |
| `PERSONA_API_KEY` | **works, but it is a SANDBOX key** (`persona_sand…`) | The API answers 200 on the endpoints the pipeline actually calls (`GET /inquiries/:id`). Identity checks run against Persona's sandbox, i.e. they are test flows, not real KYC. A production key is needed before liveness *means* anything. (A 403 on `/inquiry-templates` is a red herring — that endpoint is outside the key's scope and the product never calls it.) |
| `PLACES_API_KEY` | **empty** | Google Places: the venue fallback when no curated venue is in range, the Location Mini App autocomplete, the venue-change catalog beyond curated rows, and the date card's venue photo. The curated base still covers Kyiv/Kharkiv/Odesa, so scheduling degrades rather than dies. |
| `EXPO_ACCESS_TOKEN` | retired 2026-07-18 (Expo rail removed; native push is direct APNs via `APNS_*`) | Can be deleted from `/opt/gennety/.env`; the process no longer reads it. |

Re-probe any credential from the droplet before trusting a flag flip; the probes
are cheap and each one of these was wrong in a different way.

### Supabase project migration (2026-07-13)

Production moved to a **new Supabase project** because the credentials for the
old one were lost. Current project ref: **`ophztqjrabwemkqwidkq`**
(`eu-west-1`); the old one was `junbjqkdhdjrpennczib` (`eu-north-1`), and it is
left **untouched and intact** as the rollback path — restoring it is a matter of
putting the old `DATABASE_URL` / `SUPABASE_*` values back from an `.env.bak.*`
and restarting.

The migration was cheap because the data was tiny (14 MB) and the schema is
code. If it ever has to be repeated:

1. Create the project, then set `DATABASE_URL`, `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_ANON_KEY` in `/opt/gennety/.env`.
   `SUPABASE_URL` is always `https://<project-ref>.supabase.co` — the ref is in
   the DB connection string's username **and** inside the JWT keys, so it never
   has to be looked up in the dashboard.
2. `pnpm --filter @gennety/db db:push` (with `DATABASE_URL` exported — see the
   schema section above). This creates every table **and** the `vector`
   extension, since the Prisma datasource declares `extensions = [vector]`.
   The functional `matches_pair_canonical_idx` is created by the bot at boot.
3. Copy the data with a Prisma script, users first (everything else FKs to
   them), then `profiles` / `onboarding_progress` / `no_match_notices` /
   `bot_sessions` / `system_knowledge` / `curated_venues`. `Profile.embedding`
   is `Unsupported("vector(1536)")` and cannot be copied through the Prisma
   client — set `embeddingDirty = true` on the copied profiles instead and let
   the `embedding-refresh` cron rebuild the vectors from OpenAI.
4. Create the three **private** buckets: `selfies`, `profile-photos`,
   `chat-attachments`.
5. Restart, then prove it: row counts match, `/v1/ping` is `ok`, and a probe
   upload into `SUPABASE_SELFIE_BUCKET` returns 200 (that upload is step 1 of
   `verification-pipeline.ts` and is exactly what used to fail).

### Verification production gate

Storage works, but the Persona credential is still sandbox-only and no user has
reached a production `verified` outcome. The end state remains: obtain a live
Persona key, walk one consenting end-to-end verification through staging, and
set the mandatory production values. The service intentionally refuses to start
rather than admit unverified users.

**Deliberate interim state (since 2026-07-17):** production runs with
`ALLOW_SANDBOX_PERSONA=true` — a founder-approved override that waives ONLY the
sandbox-key startup check so the current sandbox Persona flow can serve the
early-launch window. Every other identity requirement
(`MANDATORY_VERIFICATION_ENABLED`, Rekognition, profile-media validation, no
OTP bypasses) still fails closed, and the bot logs a loud warning at boot while
the override is active. Consequences to keep in mind: verifications are Persona
TEST flows (not real KYC), and every `verified` granted during this window
persists after switching to a live key — plan to audit/re-verify that cohort.
When the live key lands: set `PERSONA_API_KEY`, remove `ALLOW_SANDBOX_PERSONA`,
restart.

Matching admits only verified users and the persisted pre-flip skip cohort. The
AI vision Elo seed runs inside the verification pipeline, so live verification
also restores meaningful league calibration for new users.

Required/high-impact env keys:

- Telegram: `BOT_TOKEN`, `BOT_USERNAME`, `WEBAPP_URL`,
  `WEBAPP_FEEDBACK_URL` (optional — defaults to `${WEBAPP_URL}/feedback.html`,
  which Caddy already serves from the same `/var/www/dating-app` root),
  `CUSTOM_EMOJI_MENU_ID`, `CUSTOM_EMOJI_ACCEPT_ID`,
  `CUSTOM_EMOJI_DECLINE_ID`, `CUSTOM_EMOJI_VERIFIED_ID` (optional —
  animated checkmark next to a verified partner in the match-pitch caption;
  empty falls back to a static `✓` glyph),
  `CUSTOM_EMOJI_DATE_ID` (optional — animated icon on the conditional
  primary-styled "My Date" main-menu row; empty → the 💫 label still renders,
  just without an `icon_custom_emoji_id`), `MESSAGE_EFFECT_MATCH_ID`,
  `MESSAGE_EFFECT_FEEDBACK_ID` (optional — Bot API 7.6 effect on the T+24 h
  feedback DM; empty = no effect)
- **My Date hub + scheduled-date banner (always-on — no feature flag).** The
  conditional "My Date" main-menu row and its hub (PRODUCT_SPEC §2.1) plus the
  status-banner countdown-to-your-date are always active; they degrade to the
  parts each sub-feature enables (the cached/re-rendered date card respects
  `DATE_CARD_FEATURE_ENABLED`, Change venue `VENUE_CHANGE_FEATURE_ENABLED`, Enter
  chat `COORDINATION_FEATURE_ENABLED`). **Requires `db:push` of the additive
  `matches.date_card_file_id_a` / `date_card_file_id_b` columns first**
  (non-destructive; they cache the rendered date-card `file_id` for instant hub
  re-open). No new system dependency; the only optional env is
  `CUSTOM_EMOJI_DATE_ID` above.
- Database/storage: `DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SELFIE_BUCKET`,
  `SUPABASE_PHOTO_BUCKET`, `SUPABASE_CHAT_BUCKET`
- AI/email/onboarding: `OPENAI_API_KEY`, `RESEND_API_KEY`, `SMTP_FROM`,
  `OTP_LOG_TO_CONSOLE`, `ONBOARDING_FACT_COLLECTOR_ENABLED` (default `false`;
  enable only after schema push and backfill verification)
  - **Vibe onboarding questions (no flag of their own).** The two §1.3 vibe
    questions (`friday_vibe` / `vibe_focus`) and their matching signal live in
    the collector, so they are active only when
    `ONBOARDING_FACT_COLLECTOR_ENABLED=true`. Requires `db:push` of the new
    `Profile.friday_vibe_text` / `vibe_focus_text` / `energy_axis` /
    `orientation_axis` / `social_role` / `anchor_tags` / `vibe_extracted_at`
    columns first (additive, non-destructive; missing columns → P2022
    crash-loop). No new system dependency — extraction reuses `OPENAI_API_KEY`.
    The matching weight re-split (`V_explicit` 0.65 / `V_research` 0.35) and the
    new vibe quadrant factor are code-only and need no env; `V_league` (and
    `MALE_REACH_ELO`) are unchanged.
- Chat progress streams: no production env flag. Do not set or reintroduce a
  `RICH_THINKING_ENABLED` live toggle — the rich path is hard-coded per call site
  (`rich: true`), never a global default, because Telegram draft/rich-draft APIs
  are treated by clients as generated AI replies and can reserve scroll space
  below the preview, and that tradeoff must be chosen deliberately per flow.
  Two categories of stream exist:
  - **Thinking-status beats** (`runStatusSequence`, the "agent is analysing /
    working" lines): AI-memory analysis, Persona verify check, verification
    soft-skip, profile-video upload check, concierge venue selection, date-card
    render + share, plus the Profiler batch boundary, the Profiler in-batch
    questions (PRODUCT_SPEC §Phase 1b), and the periodic profile-survey
    "thinking" pause (PRODUCT_SPEC §1.3). These all call with `rich: true` so
    they render as the native `<tg-thinking>` shimmer + AI Actions `<tg-emoji>`
    draft, degrading to the classic `sendMessage` + `editMessageText` stream when
    a client can't render rich drafts. No env toggle gates this — nothing to
    configure at deploy time.
  - **Content streams** (`streamDraftsToChat(..., { rich: true })` →
    `streamRichDraftsToChat`): the match pitch, no-match notice, and ice-breaker
    DMs also stream via the native rich AI-compose draft path (lead "thinking"
    chunk = `<tg-thinking>` shimmer), but their **final persisted message is a
    plain `sendMessage`, never a rich message** — it must stay a normal text
    message, and the proposal-countdown worker live-edits the pitch's final
    message via `editMessageText`. Same degrade-to-classic fallback. Also no env
    toggle.
  The AI Actions `<tg-emoji>` glyphs are the baked `AI_EMOJI` ids in
  `services/ai-emoji.ts` (no env).
- Admin API: `ADMIN_API_KEY`, `ADMIN_PORT`, `ADMIN_DASHBOARD_ORIGIN`
- Public API: `JWT_SECRET`, `JWT_ACCESS_TTL`, `JWT_REFRESH_TTL`,
  `PUBLIC_PORT`, `PUBLIC_CORS_ORIGIN` (comma-separated browser origins allowed to
  call `/v1/*`; empty now **denies** cross-origin instead of wildcarding — native
  mobile clients send no `Origin` header and are unaffected. Prefer listing the
  concrete browser origins — the Mini App host `https://dating-calendar.gennety.com`
  plus any web signup site — over `*`, which still works but logs a warning.)
- Native iOS app: `IOS_MIN_SUPPORTED_APP_VERSION` (optional, default empty →
  no forced update). Served pre-auth by `GET /v1/app/config` as
  `minSupportedIosVersion`; set e.g. `1.2.0` only to retire a broken/insecure
  old build — every older client blocks behind an "update the app" screen.
  Toggled live with `pm2 restart gennety-bot --update-env`; no schema change.
- Native-app phone rail (`/v1/auth/phone/*`, shares the Registration v2
  `PHONE_AUTH_ENABLED` gate — 404 while off): `TELEGRAM_GATEWAY_TOKEN`
  (primary rail — gateway.telegram.org account token; empty → Gateway
  skipped) and `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` /
  `TWILIO_VERIFY_SERVICE_SID` (SMS fallback via Twilio Verify — no phone
  number purchase needed). Either rail alone works; with neither set the
  endpoints answer 503 and the Telegram one-tap flow is unaffected.
  **Requires `db:push` of the additive `phone_otps` table first**
  (non-destructive). Anti-SMS-pumping: per-phone+IP express limits plus a
  durable per-phone cooldown (60 s) and daily cap (6/day) in the table.
- Push (native iOS, direct APNs — the Expo rail was retired 2026-07-18):
  `APNS_KEY_PATH` (path to the `.p8` APNs Auth Key on the droplet, e.g.
  `/opt/gennety/keys/AuthKey_XXXXXX.p8` — NOT committed; scp it manually),
  `APNS_KEY_ID` (the key's 10-char id), `APNS_TEAM_ID` (Apple Developer
  Team ID), `APNS_BUNDLE_ID` (default `com.gennety.ios`),
  `APNS_ENVIRONMENT` (`sandbox` default — dev/TestFlight builds use the
  sandbox host; set `production` for App Store builds). With any of the
  first three empty, pushes are dropped with a warning and everything else
  works. **Requires `db:push` of the additive `live_activity_tokens` table
  first** (non-destructive). `EXPO_ACCESS_TOKEN` is retired and can be
  removed from `/opt/gennety/.env`.
- Persona: `ENABLE_PERSONA_VERIFICATION`, `PERSONA_TEMPLATE_ID`,
  `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`,
  `PERSONA_WEBHOOK_SECRET`, `PERSONA_HOSTED_URL_BASE`,
  `ALLOW_SANDBOX_PERSONA` (deliberate interim override — see "Verification
  production gate" above; remove once a live Persona key is configured)
- Face match: `FACE_MATCH_PROVIDER`, `FACE_MATCH_THRESHOLD_VERIFY`
  (default 0.85), `FACE_MATCH_THRESHOLD_REVIEW` (default 0.75),
  `FACE_MATCH_MIN_VERIFIED_PHOTOS` (default 1), `AWS_REGION`,
  `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `ELO_VISION_SEED_ENABLED`
- Profile media validation: `PROFILE_MEDIA_VALIDATION_ENABLED` (default **`true`**
  — `config.ts` reads `!== "false"`, so strict upload-time validation is on
  unless it is explicitly disabled; this doc previously claimed `false`),
  `PROFILE_MEDIA_VALIDATION_FAIL_OPEN` (must remain `false` in
  production), `PROFILE_VIDEO_MAX_ANALYSIS_FRAMES` (default `24`), and
  `PROFILE_VIDEO_VALIDATION_TIMEOUT_MS` (default `60000`). Requires local
  `ffmpeg` + `ffprobe`, OpenAI, and an IAM policy containing exactly
  `rekognition:CompareFaces`, `rekognition:DetectFaces`, and
  `rekognition:DetectModerationLabels`. No new AWS access key is required.
- App-wide theme (light/dark, **always-on — no feature flag**): users pick a
  theme in onboarding (after the city gate; default `dark`) or change it later
  via Settings → Change theme. Every Mini App renders it (shared `theme.css`
  tokens + a pre-paint boot snippet in each `*.html`, which also honors a
  `?theme=` deep-link) and both server PNG cards (date + match) render in the
  recipient's `User.theme`. **Requires `db:push` of the additive `users.theme`
  (enum `Theme`, default `dark`) / `theme_chosen_at` columns first** (additive,
  non-destructive), and redeploy the Mini App bundle so all screens ship the
  theme system. No new env, no new system dependency.
- Registration v2 (phone rail feature-flagged; identity gate mandatory):
  `PHONE_AUTH_ENABLED` (default `false`) turns on the sign-up fork + the
  general-track phone rail (Mini App PathGate/PhoneGate, `POST
  /v1/telegram-onboarding/track`, the trusted `message.contact` handler);
  `MANDATORY_VERIFICATION_ENABLED=true` removes the verification
  Skip button, refuses legacy skip callbacks, and adds the verification-stall
  re-engagement sweep. Production-like startup refuses any other verification
  setting. **Requires `db:push` of the additive `users.phone`
  (unique) / `phone_verified_at` / `registration_track` columns first**
  (non-destructive; deploy code + push schema BEFORE flipping either flag —
  the new columns are read unconditionally by matching and `/state`). Also
  redeploy the Mini App bundle (`onboarding.html`) so the fork screens exist.
  The student ticket bonus (+2 at uni-email verification, `student_bonus`
  ledger reason) rides `TICKET_FEATURE_ENABLED` — no flag of its own, no
  schema beyond the wallet tables. `PHONE_AUTH_ENABLED` can be rolled back to
  the email-only flow; mandatory identity verification must remain enabled.
- Matching: `MALE_REACH_ELO` (default `36` Elo ≈ 6 attractiveness points) —
  one-directional "reach up" allowance that lets a less-attractive man match a
  somewhat more-attractive woman without the `V_league` penalty (hetero pairs
  only; matching down and same-gender pairs unaffected). Raise for a stronger
  male lift, lower toward `0` to disable. No restart side effects beyond the
  standard `pm2 restart`.
- Matching — stated age-band preference: `AGE_RANGE_PREF_FLOOR` (default `0.6`)
  and `AGE_RANGE_PREF_DECAY_PER_YEAR` (default `0.1`). The soft `V_agePref`
  multiplier dampens (never excludes) a candidate whose actual age is outside
  the seeker's stated preferred-**partner** age band (`Profile.ageRangeMin/Max`,
  edited via the **Search Prefs → Partner age range** menu / the menu-agent
  `update_age_range` tool / mobile `PATCH /v1/me`). Neutral (1.0) for users who
  never set a band, so it's inert for most users. Set
  `AGE_RANGE_PREF_FLOOR=1.0` to disable entirely; lower the floor / raise the
  decay for a stronger preference. **Requires `db:push` of the additive
  `match_score_logs.score_age_pref` column first** (non-destructive, defaults to
  `1`). No new system dependency; toggled live with `pm2 restart gennety-bot
  --update-env`.
- Venue picker: `PLACES_API_KEY`
- Anti-spam / LLM token budget (always-on, in-memory; no schema, no new dep):
  the Telegram bot meters text/voice per user (flood + daily token budget) in
  `bot-rate-limit.ts`, and the JWT LLM routers (`/v1/chat`, `/v1/assistant`,
  `/v1/onboarding`) gain `usageGuard`. Tokens are counted from the exact
  `usage.total_tokens` OpenAI returns, attributed via an `AsyncLocalStorage`
  context that `services/openai-fetch.ts` reads (call sites only swapped their
  default `fetch` for `openaiFetch`). Env (all optional, safe defaults):
  `BOT_RATE_LIMIT_ENABLED` (default `true`), `BOT_FLOOD_BURST_LIMIT` (`40`) /
  `BOT_FLOOD_BURST_WINDOW_MS` (`60000`), `BOT_FLOOD_SUSTAINED_LIMIT` (`300`) /
  `BOT_FLOOD_SUSTAINED_WINDOW_MS` (`3600000`), `LLM_TOKEN_BUDGET_ENABLED`
  (default `true`), `LLM_USER_DAILY_TOKEN_BUDGET` (`180000`),
  `LLM_GLOBAL_HOURLY_TOKEN_BUDGET` (`0` = global breaker off). Thresholds are
  deliberately loose so normal fast use never trips them. Counters are in-memory
  (single PM2 process) and reset on restart — no `db:push`, toggled live with
  `pm2 restart gennety-bot --update-env`. Whisper (audio) stays under the
  existing per-request voice limiter, not the token budget.
- Date Ticket (feature-flagged monetization): `TICKET_FEATURE_ENABLED`
  (default `false` — leave off until launch), `TICKET_PAYMENT_MODE`
  (`mock` default / `stripe`), `TICKET_PRICE_CENTS` (default `699`),
  `TICKET_PAYMENT_WINDOW_HOURS` (default `24`).
  - **Real payments = Telegram Stars (XTR), the production rail.**
    `TICKET_STARS_ENABLED` (default `false`) makes the date gate **and** the
    store pay natively in Telegram Stars via `WebApp.openInvoice` +
    `pre_checkout_query` + `successful_payment` (`handlers/payments.ts`). Needs
    **no** merchant account / provider token (empty provider token +
    `currency: "XTR"`); Stars→TON withdrawal is a Telegram-side setting.
    `TICKET_BUNDLE_STARS` (default `1:350,3:830,6:1350`, `<count>:<stars>` pairs)
    sets the per-bundle Star price; the gate derives its per-scope price from the
    1-ticket entry (self/partner 1×, both 2×). **Requires the additive unique
    `ticket_ledger.external_payment_id` column to be deployed first** (the
    Telegram charge id — exactly-once store credit and durable date-gate
    refunds; non-destructive). Gate payments are recorded before settlement;
    the hourly expiry worker retries `gate_refund_pending` rows and opens free
    scheduling only after Telegram confirms the refund. When Stars
    is on, the mock `/{ticket,tickets/store}/{intent,confirm}` routes 404 (PAY-1)
    so Stars is the sole purchase rail; the free wallet "Use a ticket" path is
    unaffected. Redeploy the Mini App bundle (`ticket.html` + `tickets.html`) so
    the ⭐-priced `openInvoice` buttons ship. Rollback: flip
    `TICKET_STARS_ENABLED` back to `false` — the mock returns exactly as before;
    the additive column may stay. Star prices are env-tunable at launch without
    a code change. The famine single-ticket discount is USD-only and is inert on
    Stars purchases.
  - Going live with **Stripe** instead (alternate path) additionally needs
    `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
  `STRIPE_WEBHOOK_SECRET` + `TICKET_PAYMENT_MODE=stripe` (see the
  `// TODO: Stripe Production Mode` branches in
  `services/ticket-payment.ts`). Requires `db:push` of the new `Match`
  ticket columns first — including the additive `partner_paid_seen_at` /
  `partner_paid_nudged_at` columns backing the §3.5b goodwill-cover read-receipt
  (the payer's "she saw it ❤️" DM + the guaranteed completion nudge). The
  read-receipt DMs reuse the existing `MESSAGE_EFFECT_TICKET_ID` heart on the
  payer's confirmation; no new env. Redeploy the Mini App bundle (`ticket.html`)
  so his success screen shows the "you covered {name}'s ticket 💛" copy.
  - **Ticket wallet + store (same flag).** `TICKET_FEATURE_ENABLED` also turns
    on the user ticket wallet: onboarding bonuses (6+ photos, profile video),
    the **My Tickets** menu, the store Mini App (`tickets.html`, bundles
    1/3/6), and the "Use a ticket" gate path. `MESSAGE_EFFECT_TICKET_ID`
    (optional — Bot API 7.6 effect on the reward DM; empty = no effect).
    Requires `db:push` of the new `User.ticket_balance`,
    `Profile.photo_bonus_ticket_at` / `video_bonus_ticket_at` columns and the
    new `ticket_ledger` table first, and `tickets.html` deployed with the Mini
    App bundle.
  - **Welcome gift (same flag).** Every new user is gifted 1 free Date Ticket as
    a pre-roll before their first match pitch — an optional founder **video
    note** (кружок) + a gift DM. `MATCH_PREROLL_DELAY_MS` controls the pause
    between a delivered gift pre-roll and the match card reveal (default 2 min).
    `MESSAGE_EFFECT_GIFT_ID` is optional — Bot API 7.6 effect on the gift DM;
    empty = no effect; pick a celebratory id like 🎉/❤️. Video assets are bundled
    at `apps/bot/src/assets/welcome-gift/<gender>-<lang>.mp4` (square video-note
    MP4, ≤60s, e.g. `male-ru.mp4`, `female-en.mp4`); they ride the standard code
    rsync, no ffmpeg needed (the bot just sends a ready
    file). A missing asset for a (gender, language) pair degrades gracefully to
    the gift DM only, so partial coverage is safe — drop in more MP4s over time.
    Idempotent via a `welcome_gift` `ticket_ledger` row (no extra schema beyond
    the wallet columns above).
  - **Famine discount (same flag).** On the 2nd consecutive no-match week
    (tier ≥ 2) the no-match DM grants a one-time **77% discount on a single
    ticket**, valid 30 days, applied to the date gate's `self` scope and the
    store's "1 ticket" bundle (`services/ticket-discount.ts`). Optional env
    overrides `FAMINE_DISCOUNT_PCT` (default `77`) and `FAMINE_DISCOUNT_TTL_DAYS`
    (default `30`). Requires `db:push` of the new
    `User.ticket_discount_pct` / `ticket_discount_granted_at` /
    `ticket_discount_expires_at` / `ticket_discount_consumed_at` columns first
    (additive, non-destructive). No new system dependency; runs inside the
    existing no-match cron + ticket Mini App routes. Inert unless
    `TICKET_FEATURE_ENABLED`.
- Pre-date coordination (feature-flagged): `COORDINATION_FEATURE_ENABLED`
  (default `false` — leave off until launch). When on, the bot offers matched
  users a way to find each other ~1h before the date (share Telegram, request
  partner's, or an anonymous bot-relayed chat). Requires `db:push` of the new
  `User.telegramUsername`, `Match.coord*`/`proxy*` columns, and the
  `proxy_messages` table first. Runs on the existing date-lifecycle
  `setInterval` — no new cron schedule. Variant C (anonymous proxy) is a
  documented, narrow carve-out to the no-in-app-chat invariant
  (PRODUCT_SPEC.md §Core Principles): post-match, time-boxed, text-only,
  fully logged, with an in-line Report button.
- Venue change v2 (feature-flagged, paid): `VENUE_CHANGE_FEATURE_ENABLED`
  (default `false` — leave off until launch) + `VENUE_CHANGE_STARS` (default
  `150`, the flat Telegram Stars price of one settled change). When on, BOTH
  sides' scheduled cards carry a "Change venue" button into the shared likes
  board (3 km catalog, hearts with ~4 s live sync, overlap = agreement —
  calendar mechanics); a settled change costs `VENUE_CHANGE_STARS` paid
  natively in Stars (hetero: the man pays + the female-only express unilateral
  swap; same-sex: the initiator). Decline/lapse NEVER cancels the match — the
  original venue stands. No free text anywhere (the v1 mandatory-comment
  carve-out is gone). Telegram-only. **Requires `db:push` of the additive v2
  `Match` columns first** (`venue_likes_a/b`, `venue_change_photo_url/name`,
  `venue_change_paid_by_id/paid_at`, `venue_change_pay_declined_at`,
  `venue_change_offer_pay_sent_at`, `venue_change_ping_sent_to_a/b_at`,
  `venue_change_express_at` — non-destructive), and redeploy the Mini App
  bundle (`venue-change.html`, fully reworked board UI). Payments ride the
  Stars rails (`venue:<matchId>:<mode>` payload in `handlers/payments.ts`; no
  merchant account — same XTR mechanics as tickets, independent of
  `TICKET_STARS_ENABLED`); a lost parallel-pay race is auto-refunded via
  `refundStarPayment`. The wish-card PNG reuses the date-card satori stack +
  bundled fonts (no new system dependency); Places venue photos stream through
  `GET /v1/venue-change/photo`, so `PLACES_API_KEY` is needed (already required
  for the venue picker). Runs on the existing date-lifecycle `setInterval`
  (lapse/express-revert sweep) — no new cron schedule. Rollback: flip the flag
  off; the additive columns may stay.
- Date card (feature-flagged): `DATE_CARD_FEATURE_ENABLED` (default `false` —
  leave off until launch). When on, each side's `scheduled` confirmation is a
  rendered PNG date card (partner photo + venue photo + details) sent
  screenshot/forward-protected, with a Share button that re-sends a copy with
  the partner's face blurred (PRODUCT_SPEC.md §3.7a). Telegram-only in v1.
  Requires `db:push` of the new `Match.venuePhotoUrl` / `venuePhotoName`
  columns first. No new system dependency: rendering uses `satori`,
  `@resvg/resvg-js`, and `@napi-rs/canvas` (prebuilt binaries pulled by
  `pnpm install --frozen-lockfile`, **not** ffmpeg/Chromium), and the bundled
  Roboto + Archivo Black TTFs in `apps/bot/src/assets/fonts/` ride the standard
  code rsync.
  Venue photos come from `CuratedVenue.photoUrl` first, else the Google Places
  cover photo (needs `PLACES_API_KEY`; fetched at render, credited on the card,
  never persisted). Runs inline at venue finalization — no new cron. Any render
  failure degrades to the existing plain-text scheduled DM, so the flag is safe
  to toggle live with `pm2 restart gennety-bot --update-env`.
- Match card (feature-flagged): `MATCH_CARD_FEATURE_ENABLED` (default `false`).
  When on, the match-pitch photo album is replaced by the rendered collage
  card set (card 1 = photo + name/vibe panel, following cards = one full-bleed
  photo each; PRODUCT_SPEC.md §3.3). Uses the same satori/resvg/canvas stack
  and bundled fonts as the date card plus `apps/bot/src/assets/brand/butterfly-logo.svg`
  and the Unbounded woffs in `assets/fonts/` (all ride the code rsync), and one
  extra OpenAI call per side for the short card copy. Any copy/render/send
  failure falls back to the plain protected media group, so the flag is safe to
  toggle live with `pm2 restart gennety-bot --update-env`. No schema change.
- Founder notifications (feature-flagged private ops feed): `FOUNDER_NOTIFY_ENABLED`
  — **ON in production since 2026-07-16** (founder bot `@sverkausbot`, chat id set).
  When on, a SEPARATE founder bot DMs the founder four things: (1) each new user's
  full profile + photos on first activation (no AI-memory dump), (2) a tokenized
  weekly-matches report link after the Thursday batch, (3) both date cards + venue
  when a date locks in, (4) the full profile + **phone number** + photos when a
  user freezes or hard-deletes their account (bot Settings→Delete/Freeze and mobile
  `DELETE /v1/me`; the delete path snapshots the row before the Prisma cascade).
  Requires `FOUNDER_BOT_TOKEN` (a bot from BotFather —
  kept distinct from `BOT_TOKEN`; `file_id`s are per-bot so the founder bot uploads
  raw bytes), `FOUNDER_TELEGRAM_ID` (the founder's numeric chat id — they must
  `/start` the founder bot once), and `PUBLIC_BASE_URL` (default
  `https://dating-api.gennety.com`, used to build the report link). **Requires
  `db:push` of the additive `users.founder_notified_at` column and the new
  `founder_reports` table first** (non-destructive; the idempotency marker +
  report snapshots). The report page (`GET /v1/founder/report/:token`) is served
  by the existing public API — no Caddy/DNS change. Photos in the report stream
  through the main bot, so no `PLACES_API_KEY` dependency. Runs inline at
  activation / venue-finalize / the weekly cron — no new cron schedule. The
  founder-facing dashboard "Weekly matches" tab lives in the separate
  `gennety-dating-dashboard` repo and consumes `GET /admin/analytics/weekly-matches`.
  Rollback: flip the flag off; the additive column/table may stay.
- Optional cron overrides: `MATCH_CRON_SCHEDULE`, `CRON_TIMEZONE`,
  `EXPIRY_CRON_SCHEDULE`, `NO_MATCH_NOTICE_CRON_SCHEDULE`,
  `PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `RE_ENGAGEMENT_CRON_SCHEDULE`,
  `MATCH_NUDGE_CRON_SCHEDULE`, `PRE_MATCH_ANNOUNCE_CRON_SCHEDULE`,
  `STATUS_TIMER_CRON_SCHEDULE`, `AUTO_UNSUSPEND_CRON_SCHEDULE`,
  `EMBEDDING_REFRESH_CRON_SCHEDULE`, `SELFIE_RETENTION_CRON_SCHEDULE`,
  `VENUE_REVALIDATION_CRON_SCHEDULE`, `TICKET_EXPIRY_CRON_SCHEDULE`,
  `PROFILER_CRON_SCHEDULE`, `DATE_LIFECYCLE_TICK_MS`, `DISPATCH_DELAY_MS`,
  `MATCH_PREROLL_DELAY_MS`
- Onboarding funnel analytics (always-on, no feature flag): step-level
  drop-off + hesitation telemetry feeding `GET /admin/analytics/onboarding-funnel`
  and the weekly `GET /admin/analytics/founder-digest` (consumed by the external
  **Hermes** agent — see `HERMES_AGENT_PROMPT.md`). Requires `db:push` of the new
  additive `onboarding_step_events` table first (non-destructive; missing table →
  the collector's best-effort telemetry just logs a warning and onboarding still
  works, but the endpoint returns empty until the table exists). No new env, no
  new system dependency; writes ride the existing onboarding collector.
- Profiler (Phase 1b, always-on): post-onboarding Q&A batches that fuel
  icebreakers + date-planning hints (NOT matching). No feature flag —
  `PROFILER_CRON_SCHEDULE` (default `*/15 * * * *`) only tunes cadence; set it
  far-future to effectively pause. Requires `db:push` of the new
  `profiler_answers` table, `ProfilerPriority` enum, and the
  `Profile.time_zone` / `profiler_*` columns first (additive, non-destructive).

Production safety checks:

- `DEV_OTP_BYPASS_TELEGRAM_IDS` must be empty in production; startup refuses
  any non-empty value outside the explicit development runtime.
- Keep `ONBOARDING_FACT_COLLECTOR_ENABLED=false` during the first production
  deploy. Before enabling it: back up PostgreSQL, run
  `pnpm --filter @gennety/db db:push`, run `pnpm onboarding:backfill` and
  inspect aggregate counts, then run `pnpm onboarding:backfill:apply`.
  Enable Development first and complete the two-account E2E. Production
  rollback is the env flag; the additive `onboarding_progress` table may stay.
- `OTP_LOG_TO_CONSOLE` must be `false` or unset in production. It only relaxes
  local identity checks when `NODE_ENV=development`; otherwise startup fails.
- `JWT_SECRET` must contain at least 32 cryptographically random bytes (the
  template uses 64 hex characters), otherwise the public API refuses to start.
  Access tokens are accepted only as HS256 tokens issued by
  `gennety-public-api` for the `gennety-mobile` audience; changing these claims
  is an API migration, not a deploy-time toggle.
- `PUBLIC_PORT` should remain `3101` unless Caddy is changed too.
- `ADMIN_PORT` should remain `3100` unless Caddy is changed too.
- `WEBAPP_URL` should point to `https://dating-calendar.gennety.com`.

## Logs And Operations

PM2:

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 describe gennety-bot'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 200 --nostream'
ssh root@167.172.178.229 'pm2 monit'
```

PM2 log files:

```text
/root/.pm2/logs/gennety-bot-out.log
/root/.pm2/logs/gennety-bot-error.log
```

Warning: bot error logs can include Telegram context objects. Do not paste raw
logs into public issues or commits without checking for tokens/user data.

Caddy:

```sh
ssh root@167.172.178.229 'systemctl status caddy --no-pager'
ssh root@167.172.178.229 'journalctl -u caddy -n 200 --no-pager'
ssh root@167.172.178.229 'caddy validate --config /etc/caddy/Caddyfile'
ssh root@167.172.178.229 'systemctl reload caddy'
```

PM2 startup:

```sh
ssh root@167.172.178.229 'systemctl status pm2-root --no-pager'
ssh root@167.172.178.229 'pm2 save'
```

Manual bot restart:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 restart gennety-bot --update-env
pm2 logs gennety-bot --lines 100 --nostream
```

If the PM2 process is missing:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pm2 start bash --name gennety-bot -- -c "cd /opt/gennety && ./apps/bot/node_modules/.bin/tsx apps/bot/src/index.ts"
pm2 save
systemctl status pm2-root --no-pager
```

## Database Operations

Generate Prisma client:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:generate
```

Push current Prisma schema to production:

```sh
ssh root@167.172.178.229
cd /opt/gennety
pnpm --filter @gennety/db db:push
```

Check Prisma version/config:

```sh
ssh root@167.172.178.229 'pnpm --dir /opt/gennety --filter @gennety/db exec prisma --version'
```

Current production logs showed this schema drift pattern:

```text
Prisma P2022: The column `users.referral_source` does not exist in the current database.
```

If that appears after deploying code that references a new column, run
`pnpm --filter @gennety/db db:push` on the droplet and restart PM2.

## Curated Venue Seeding

The concierge venue picker is curated-first (`curated_venues` table; Google
Places is the fallback). After the `CuratedVenue` schema reaches a DB (via
`db:push`), populate the base with the two-phase seeder. It needs `PLACES_API_KEY`
in env and writes to whichever DB `DATABASE_URL` points at — run it with prod env
to seed production.

```sh
# 1. Fill in scripts/curated-venues.config.json (university domain + centre lat/lng).
# 2. Pull candidates from Google Places under the production quality gate:
pnpm seed-venues:pull
# 3. Hand-edit scripts/curated-venues.candidates.json:
#    flip "approved": true on keepers, tweak "priority" (1 best … 3 ok) + "vibeTags".
# 4. Dry-run, then apply:
pnpm seed-venues:import
pnpm seed-venues:import --apply
```

Re-running `--pull` overwrites the candidates file; `--import --apply` is
idempotent (upsert on domain+Place id, with name/address fallback) so it's safe
to re-run after edits.
The import also deletes rows matching the operator brand blocklist.

For the reviewed Kyiv expansion, refresh and validate the committed approved
catalog before importing:

```sh
pnpm sync-venues:kyiv
pnpm sync-venues:kyiv --apply
pnpm sync-venues:kyiv --check
pnpm seed-venues:import --in=scripts/curated-venues.kyiv.approved.json --apply
```

## Caddy Or Domain Changes

Edit and validate:

```sh
ssh root@167.172.178.229
nano /etc/caddy/Caddyfile
caddy fmt --overwrite /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile
systemctl reload caddy
journalctl -u caddy -n 80 --no-pager
```

DNS for `gennety.com` is managed at Hostinger. All Gennety Dating API domains
must stay prefixed with `dating-` or `api-admin`; `api.gennety.com` belongs to
a sibling project and must not be used here.

## Rollback

Code rollback is currently file sync based, not git based on the server.

Fast rollback options:

1. Re-sync a known-good local checkout to `/opt/gennety`.
2. Restore a previous local commit, then run the full server deploy again.
3. If only env changed, restore one of `/opt/gennety/.env.bak.*`, then restart
   PM2.
4. If only Mini App changed, rebuild and rerun `./scripts/deploy-webapp.sh`
   from a known-good local checkout.

Env rollback:

```sh
ssh root@167.172.178.229
cd /opt/gennety
ls -lt .env.bak.*
cp .env.bak.YYYYMMDD-HHMMSS .env
pm2 restart gennety-bot --update-env
pm2 save
```

## Post-Deploy Checklist

```sh
ssh root@167.172.178.229 'pm2 status'
ssh root@167.172.178.229 'pm2 logs gennety-bot --lines 100 --nostream'
curl -s https://dating-api.gennety.com/v1/ping
curl -sI https://dating-calendar.gennety.com
curl -sI https://dating-calendar.gennety.com/onboarding.html
curl -sI https://dating-calendar.gennety.com/verification.html
curl -sI https://dating-calendar.gennety.com/ticket.html
curl -sI https://dating-calendar.gennety.com/tickets.html
curl -sI https://dating-calendar.gennety.com/venue-change.html
curl -sI https://api-admin.gennety.com
```

Then check:

- PM2 `gennety-bot` is `online`.
- Bot log says `Bot @gennetybot started`.
- Bot log says admin API is listening on `:3100` when `ADMIN_API_KEY` is set.
- Bot log says public API is listening on `:3101`.
- Public `/v1/ping` returns `{ "ok": true, ... }`.
- Calendar, onboarding, and verification Mini Apps return HTTP `200`.
- Admin API returns HTTP `401` without bearer auth.
