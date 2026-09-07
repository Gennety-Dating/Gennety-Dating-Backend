<!-- WHEN_TO_READ: You are deploying, rolling back, running a DB operation on production, seeding venues, changing Caddy/domains, or reading production logs. This is the CANONICAL deploy procedure — do not ask the user for hostnames, paths or service names, they are in environments.md. -->
<!-- SOURCE: deploy.md (lines 11779-13248) — migrated 2026-09-01 -->

# Production deploy runbook

Hosts, paths, credentials and endpoints: [environments.md](./environments.md).
Per-deploy history and the pending backlog: [deploy-journal/](./deploy-journal/INDEX.md).

## Preflight Before Deploy

Run from the local repo:

```sh
cd "/Users/pro/Desktop/Gennety Dating"
git status --short
pnpm install
pnpm test
pnpm build
pnpm security:secrets
pnpm security:audit
```

`pnpm security:audit` is a **mandatory** preflight step (added 2026-07-26). It
existed as a script long before it was in this runbook, and the gap is exactly
how a CRITICAL `fast-xml-parser` advisory reached the shipped Mini App bundle —
the package rides in via `@aws-amplify/ui-react-liveness`, so a client-side CVE
was invisible to any server-side check. Fix transitive advisories with an entry
in the root `pnpm.overrides` block (already used for seven packages) rather than
waiting on the upstream dependency. **Never pin an override BELOW the patched
version** — `postcss` was held at `8.5.10` while the fix was `8.5.18`, so the
override itself was the vulnerability.

**An override rots — re-check the pinned versions every deploy, not only when
adding one.** This recurred on 2026-08-07, to three overrides at once
(`postcss` 8.5.18, `fast-uri` 3.1.4, `brace-expansion` 5.0.8), each sitting
exactly one patch below a **newly published** advisory. Every one had been
correct when written; the bar moved underneath them, and the block still looked
deliberate and healthy on inspection. `pnpm audit` is the only thing that
notices. Triage the output by whether the path reaches the droplet runtime — an
`apps/video > @remotion/cli` or `eslint > …` chain is build/dev-only and never
ships, while `apps/bot > …` does — but fix all of them anyway, because the gate
is pass/fail and one tolerated advisory turns it into a permanently red check
nobody reads.

**A brand-new transitive advisory is the same tax, and it landed again on
2026-08-20** — `deepmerge-ts` <8.0.0 (GHSA-ggr8-5vv4-36mx, high) reaching in
through `packages/db > prisma > @prisma/config`. Pinned to `8.0.1`. Build-time
only (it is Prisma's config loader, not the bot's request path), but **verify
the CLI still runs before trusting the pin**: the demo and production deploys
both call `db:push`/`db:generate` through that exact dependency, so an override
that satisfies `pnpm audit` and breaks Prisma would surface as a failed deploy
rather than a failed preflight. `prisma --version` (which loads `@prisma/config`)
plus `db:generate` is the whole check.

Identity and profile-media validation preflight:

```sh
ffmpeg -version
ffprobe -version
# The process must refuse to boot unless all of these are production-ready:
grep -E '^(MANDATORY_VERIFICATION_ENABLED|FACE_LIVENESS_ENABLED|LIVENESS_STS_ROLE_ARN|FACE_MATCH_PROVIDER|PROFILE_MEDIA_VALIDATION_ENABLED)=' .env
```

These local checks do not prove that the production droplet has the package.
Run the server-side installation/check in **Required Production System
Dependency** during the production rollout.

Verify the three narrow Rekognition actions and run consenting/synthetic QA
media before deployment. Production must have
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_LIVENESS_ENABLED=true`, a
configured `LIVENESS_STS_ROLE_ARN`, `FACE_MATCH_PROVIDER=rekognition`, and
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

```sh
# ALWAYS dry-run first. Every line must be a deletion you intend.
rsync -az --delete --dry-run --itemize-changes \
  --exclude '.git/' --exclude 'node_modules/' --exclude 'dist/' --exclude 'tmp/' \
  --exclude '.env*' --exclude 'keys/' --exclude '*-backup-*.json' \
  --exclude '.claude/' --exclude '.agents/' --exclude '.codex/' --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/ | grep '^\*deleting'
```

Then the real sync (identical flags, minus `--dry-run`):

```sh
rsync -az --delete \
  --exclude '.git/' \
  --exclude 'node_modules/' \
  --exclude 'dist/' \
  --exclude 'tmp/' \
  --exclude '.env*' \
  --exclude 'keys/' \
  --exclude '*-backup-*.json' \
  --exclude '.claude/' \
  --exclude '.agents/' \
  --exclude '.codex/' \
  --exclude '.gstack/' \
  ./ root@167.172.178.229:/opt/gennety/
```

**`.env*`, `keys/` and `*-backup-*.json` are not optional excludes.** `.env*`
(not just `.env`) covers the `.env.bak.*` snapshots that Rollback depends on.
`keys/` holds server-only Apple secrets (`APNS_KEY_PATH`, `APPSTORE_KEY_PATH`)
that exist nowhere in the repo — the narrower pre-2026-07-25 list already
destroyed the APNs `.p8` once. `*-backup-*.json` covers the **two** droplet-only
database backups, which live in the repo root and are matched by nothing else:

```
/opt/gennety/ethnicity-backup-2026-08-02T08-26-08-301Z.json   (1 KB)
/opt/gennety/prod-backup-2026-07-27T14-08-06-066Z.json        (3.3 MB)
```

Until 2026-08-07 this exclude was mentioned only in the 2026-08-02 release note,
named only the first file, and was **absent from the flag set above** — so
following this section literally destroyed both. `ls /opt/gennety/*.json` after
any deploy; it is the same class of failure as the `keys/` deletion.

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
reaching for that flag, confirm the change is genuinely additive. The
authoritative gate is `pnpm db:drift-check` (it introspects the live prod DB
rather than diffing schema files); to SEE which DROPs `--accept-data-loss` would
run, dump the plan with `prisma migrate diff --from-schema-datasource
prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` (URL
read from env, never `--from-url`, which would leak the password into `ps` and
pnpm's failure echo) and confirm every DROP is one you intend. The older manual
pair below still works as a cross-check — the deploy is only safe if **both** hold:

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

**Mandatory drift gate before restart.** Whether or not you think the schema
changed, confirm the production DB now matches the code schema — this turns the
silent P2022 crash-loop above into a clean pre-restart stop:

```sh
export DATABASE_URL="$(sed -n 's/^DATABASE_URL=//p' .env | tail -1 | tr -d '"')"
pnpm db:drift-check   # exit 0 = match (safe); exit 2 = DRIFT → run db:push, re-check
```

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
(full-screen Telegram onboarding), `verification.html` (AWS Face Liveness
Embedded SDK KYC flow), `ticket.html` (Date Ticket, feature-flagged
premium post-accept gate), `tickets.html` (ticket store / wallet,
feature-flagged pre-purchase bundles), and `venue-change.html` (feature-flagged
female-exclusive venue swap). Caddy's `try_files {path} /index.html` resolves
direct hits like `/feedback.html` and `/onboarding.html` before the SPA
fallback.

The liveness flow needs one one-time provider-side setup step (it doesn't
affect rsync output, but skipping it breaks the Mini App):
1. **BotFather** `/setdomain` → `dating-calendar.gennety.com` for
   `@gennetybot`. Without this, the Mini App can't request camera
   permissions inside the Telegram WebView.

Note the detector fetches its TF.js wasm backend and Blazeface model from
public CDNs by default. If a client network can't reach them, self-host both
from `/var/www/dating-app` and set `config.binaryPath` / `config.faceModelUrl`
in `apps/webapp/src/liveness-detector.tsx`.

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

**Update 2026-07-23 — remaining dark features enabled in safe shadow mode
(founder-approved, env-only + PM2 restart).** The two features that were still
off (Type Radar, Venue Intent V2) were switched on in their *designed* launch
posture — enabled but not yet influencing matching — NOT flipped to full live:
- `TYPE_RADAR_ENABLED=true` with `TYPE_PREF_FLOOR=1.0` — the "choose your type"
  onboarding step + answer collection go live; the `V_type` multiplier stays a
  no-op (shadow) until predictiveness is validated over 3–4 batches, per
  TYPE_RADAR_PRODUCT_SPEC. Verified live: `GET /v1/radar/deck` now returns `401`
  (auth-gated) instead of `404`.
- `VENUE_INTENT_V2_ENABLED=true` with `VENUE_INTENT_V2_SHADOW_PERCENT=100` /
  `VENUE_INTENT_V2_ROLLOUT_PERCENT=0` — the new two-step concierge selector
  computes + writes its append-only `venue_selection_logs` for 100% of pairs
  but real matches still schedule via the existing path (live 0%), exactly the
  documented "shadow ≥7 days / 30 pairs before advancing live" rollout.

**Superseded 2026-07-25.** Both were advanced to their live posture in the
catch-up deploy: `TYPE_PREF_FLOOR=0.7` (the `V_type` multiplier now re-ranks)
and `VENUE_INTENT_V2_ROLLOUT_PERCENT=100` / `SHADOW_PERCENT=0`. See the
2026-07-25 block at the top of this file, including the note that the venue
rollout skipped the staged 10→50→100 guard. `PROMO_FEATURE_ENABLED=true` was
added at the same time; `REFERRAL_FEATURE_ENABLED=false` is set explicitly
because the referral program is unfinished. **Superseded 2026-07-26 for
identity:** Persona and its `ALLOW_SANDBOX_PERSONA` override are gone; the
provider is AWS Face Liveness and the sandbox-vs-real-KYC question no longer
exists (see the block at the top of this file). No schema work remains.

Every product feature is now **on** in `/opt/gennety/.env`: tickets + Telegram
Stars, Registration v2's phone track, the fact collector (which is what actually
feeds the matching engine's vibe axes), Elo vision seed, pre-date coordination,
venue change v2, the date card, the match card, and Rekognition face-match.

`ENABLE_PERSONA_VERIFICATION` was on, while
`MANDATORY_VERIFICATION_ENABLED` was still off. After the identity trust-gate
hardening that state stopped booting; as of 2026-07-17
`MANDATORY_VERIFICATION_ENABLED=true` was set and production ran the sandbox
Persona key behind an explicit `ALLOW_SANDBOX_PERSONA=true` override. **That
whole arrangement was retired on 2026-07-26** when identity moved to AWS Face
Liveness — see "Verification production gate" below for the current gate.

**Provider credentials, verified by probing each one from the droplet** (a flag
is worthless without its provider):

| Credential | State | Consequence |
|---|---|---|
| Supabase (DB + Storage) | **migrated 2026-07-13 to a new project** — see below | Storage works for the first time (the old project's keys were never filled in — they were the literal `your_supabase_…` placeholders from `.env.example`, so uploads 403'd with `Invalid Compact JWS`). |
| `PERSONA_API_KEY` | **retired 2026-07-26** (was a SANDBOX key, `persona_sand…`, so identity checks were test flows rather than real KYC) | Replaced by AWS Face Liveness on the existing `AWS_*` credentials + the `GennetyLivenessClient` STS role. Verify with `pnpm probe-liveness`; delete the `PERSONA_*` keys from `/opt/gennety/.env`. |
| `PLACES_API_KEY` | ~~empty~~ → **set** (re-verified on the droplet 2026-07-25; a live Place Details probe of a real curated Kyiv venue returned its cover photo) | Google Places: the venue fallback when no curated venue is in range, the Location Mini App autocomplete, the venue-change catalog beyond curated rows, and — since 2026-07-25 — **every** venue photo, including for curated venues (resolved from `placeId` at assignment). Without it the curated base still covers Kyiv/Kharkiv/Odesa, so scheduling degrades to gradient-only cards rather than dying. |
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

**Provider: AWS Rekognition Face Liveness (migrated off Persona 2026-07-26).**
The migration's whole point was ending the sandbox era: production had been
running `ALLOW_SANDBOX_PERSONA=true` since 2026-07-17, i.e. Persona TEST flows
rather than real KYC, because a live Persona key costs a fixed ~$250/mo
regardless of volume. Face Liveness is ~$0.015 per check with no monthly floor
(so a paused ad campaign costs nothing), and our Persona template only ever
used selfie-liveness — no document checks — so nothing was lost functionally.

There is **no sandbox/production key split to police any more**, and therefore
no override to remove. `identityTrustConfigurationErrors` requires
`FACE_LIVENESS_ENABLED=true`, real `AWS_ACCESS_KEY_ID` /
`AWS_SECRET_ACCESS_KEY`, and `LIVENESS_STS_ROLE_ARN`, alongside the unchanged
`MANDATORY_VERIFICATION_ENABLED=true`, `FACE_MATCH_PROVIDER=rekognition` and
`PROFILE_MEDIA_VALIDATION_ENABLED=true`. A production-like process refuses to
start unless all of them hold — the credential check matters because
flag-on-but-unconfigured would render a verification CTA that opens a Mini App
with no session to run.

**Historical debt:** `verified` statuses granted during the sandbox window
(2026-07-17 → 2026-07-26) carry no real identity guarantee and were never
retroactively cleared. Audit that cohort before it matters commercially.

**Cost per verified user.** One liveness check ≈ **$0.015** (first 500k/mo,
us-east-1 list price; eu-central-1 may differ slightly) plus the existing
`CompareFaces` calls — one per profile photo, ≈ $0.001 each, so 4–10 photos add
≈ $0.004–0.010. A verified user therefore costs roughly **$0.02–0.03**, and a
retry costs another $0.015. At 1,000 registrations/month that is ~$25 versus
Persona's $250 floor.

**⚠️ Region: Face Liveness runs in `eu-west-1`, not `eu-central-1`.**
`FACE_LIVENESS_REGION` (default `eu-west-1`) is deliberately separate from
`AWS_REGION`, which stays `eu-central-1` for `CompareFaces` / `DetectFaces` /
moderation. Measured across every EU region on 2026-07-26, **`eu-west-1`
(Ireland) is the only one that serves Face Liveness** for this account —
`eu-central-1` and `eu-west-2` refuse it, and the rest have no Rekognition
endpoint at all. This is also where our Supabase project lives, so the
reference selfie never leaves that region.

**The trap that cost us a debugging session:** a region that does not serve Face
Liveness answers `CreateFaceLivenessSession` with an `AccessDeniedException`
carrying an **empty message** — indistinguishable from an IAM denial, and
nothing like the `UnknownOperationException` you would expect. If the probe
fails, rule out the region before touching IAM: `sts:AssumeRole` lives in the
same policy as the Rekognition permissions, so if step 2 of the probe succeeds
the policy is live and the region is your problem.

**Required AWS setup** (account `147010141827`; IAM is global, so no region
applies to these two steps). Both console-side:

1. Add to the `gennety-bot-rekognition` user policy:
   `rekognition:CreateFaceLivenessSession`,
   `rekognition:GetFaceLivenessSessionResults` (Resource `*`), and
   `sts:AssumeRole` on
   `arn:aws:iam::147010141827:role/GennetyLivenessClient`.
2. Create role **`GennetyLivenessClient`** — trust policy: Principal =
   `arn:aws:iam::147010141827:user/gennety-bot-rekognition`, Action
   `sts:AssumeRole`. Permission policy: `rekognition:StartFaceLivenessSession`
   on `*` and nothing else. This is the grant a user's browser/phone briefly
   holds (15 min, the AssumeRole floor) to sign its own video stream;
   Rekognition supports no resource-level ARN for that action, so the narrow
   action list plus the short TTL is the containment. The backend re-asserts
   the same ceiling as an inline session policy, so widening the role later
   does not silently widen what a client gets.

Verify all three permissions without a camera or a billed check:

```sh
pnpm probe-liveness   # CreateSession → AssumeRole → GetSessionResults
```

An unused session is not billed as a check and expires on its own after 3
minutes, so the probe is free and safe to re-run.

**BotFather `/setdomain` must include `dating-calendar.gennety.com`** — the
detector needs camera permission inside the Telegram WebView. (The Persona
"Allowed origins" dashboard step is gone with the provider.)

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
  feedback DM; empty = no effect),
  `MESSAGE_EFFECT_MUTUAL_ID` (falling-hearts effect on the mutual-match reveal
  — the Date Ticket card, and only that card; **defaults to ❤️
  `5159385139981059251`, so no env change is needed** — set it empty to
  disable, or to another effect id to change the animation. Code-only
  otherwise: no schema, no flag, no Mini App change.)
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
- **Native theme picker (always-on — no feature flag).** `PATCH /v1/me/theme`
  and the two new `SerializedUser` fields ship with the bot; the iOS Settings
  screen is what calls them. **Requires `db:push` of the additive
  `users.theme_mode` column (enum `ThemeMode`) first** (non-destructive), then
  a one-off backfill so people who already picked a theme in the bot are not
  reset to the `dark` default the column ships with:

  ```sql
  UPDATE users SET theme_mode = theme::text::"ThemeMode" WHERE theme_chosen_at IS NOT NULL;
  ```

  Without the backfill nothing breaks — the effective `theme` column is
  untouched, so cards and Mini Apps keep rendering correctly — but a bot user
  who chose light would see the iOS picker check "Dark". No Mini App rebuild
  and no new env; the Mini Apps read `theme`, which did not change shape.
- Database/storage: `DATABASE_URL`, `SUPABASE_URL`,
  `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_SELFIE_BUCKET`,
  `SUPABASE_PHOTO_BUCKET`, `SUPABASE_CHAT_BUCKET`
- AI/email/onboarding: `OPENAI_API_KEY`, `RESEND_API_KEY`, `SMTP_FROM`,
  `OTP_LOG_TO_CONSOLE`, `ONBOARDING_FACT_COLLECTOR_ENABLED` (default `false`;
  enable only after schema push and backfill verification)
  - **AI-memory export kill switch:** `AI_MEMORY_EXPORT_ENABLED` (default
    **`true`** — `config.ts` reads `!== "false"`, so the Magic Prompt branch
    stays on unless explicitly disabled). Set `AI_MEMORY_EXPORT_ENABLED=false`
    to hide the whole feature (PRODUCT_SPEC §1.3): the onboarding Mini App skips
    the AI-memory choice screen, `POST /v1/telegram-onboarding/ai-memory` 404s,
    and onboarding runs vibe → photos with the deterministic fallback summary —
    i.e. every user takes the existing "declined" path. **No schema change, no
    backfill, no Mini App rebuild required to flip it** (the bundle reads the
    server's `aiMemoryExportEnabled` from `/state`; redeploying the Mini App is
    only needed to pick up the client-side skip for *cached* older bundles,
    which are already safe because the server 404s the write). Toggle live with
    `pm2 restart gennety-bot --update-env`. Rollback = remove the line (or set
    `true`); `User.aiMemoryExportPreference` is never rewritten by the flag, so
    the branch returns exactly as it was. In-flight effects when turning it
    off: users parked on the choice screen / Magic Prompt step advance straight
    to photos, and a paste already buffered is dropped instead of saved.
    **Current state (2026-07-30): OFF in production AND off in dev.** Prod has
    carried `AI_MEMORY_EXPORT_ENABLED=false` in `/opt/gennety/.env` since
    2026-07-26; `.env.local` (+ `.env.local.example`) now sets the same, because
    the default is `true` and a dev box without the line walks an onboarding
    flow no production user can reach — choice screen → Magic Prompt paste →
    an AI-derived `psychologicalSummary` feeding `V_explicit`. Nothing in the
    production pool is AI-memory-derived: audited 2026-07-30, **zero** users
    have ever held `aiMemoryExportPreference = accepted` (15 rows: 14
    `undecided`, 1 `declined`), so the five populated `psychologicalSummary`
    values are all the deterministic vibe fallback. **Rollback trap:** four env
    backups predating 2026-07-26 (`.env.bak.20260713`…`20260725`) have no such
    line, so restoring one silently turns the feature back on.
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
- OpenAI model selection (single source of truth, `apps/bot/src/models.ts`):
  every chat/vision call site resolves its model from the `MODELS` map, so an
  OpenAI generation retirement is a one-line change (or a live env override).
  Current defaults are the GPT-5.6 tiers (migrated off the retiring GPT-5.4/4.1
  families 2026-07): `MODELS.vision`/`MODELS.agent` → **`gpt-5.6-terra`**
  (attractiveness Elo seed + conversational/user-facing generation),
  `MODELS.visionFast`/`MODELS.fast` → **`gpt-5.6-luna`** (simple photo checks +
  cheap classification / short worker DMs). Four optional overrides —
  `OPENAI_MODEL_VISION`, `OPENAI_MODEL_VISION_FAST`, `OPENAI_MODEL_AGENT`,
  `OPENAI_MODEL_FAST` — let ops pin/roll a model live via
  `pm2 restart gennety-bot --update-env`, no redeploy and no schema change.
  Embeddings (`text-embedding-3-small`), Whisper, and moderation are
  deliberately NOT routed through `MODELS` (changing the embedding model forces
  a full re-embed). Note: switching `MODELS.vision` shifts the Elo seed's score
  distribution for newly verified users; `Profile.eloSeedDetails.model` records
  the model per seed so the drift is auditable.
- Chat progress streams: no production env flag. Do not set or reintroduce a
  `RICH_THINKING_ENABLED` live toggle — the rich path is hard-coded per call site
  (`rich: true`), never a global default, because Telegram draft/rich-draft APIs
  are treated by clients as generated AI replies and can reserve scroll space
  below the preview, and that tradeoff must be chosen deliberately per flow.
  Two categories of stream exist:
  - **Thinking-status beats** (`runStatusSequence`, the "agent is analysing /
    working" lines): AI-memory analysis, liveness verify check, verification
    soft-skip, profile-video upload check, onboarding photo-burst check
    (`photoReviewSteps`), concierge venue selection, date-card
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
  `PHONE_AUTH_ENABLED` gate — 404 while off): `TWILIO_ACCOUNT_SID` /
  `TWILIO_AUTH_TOKEN` / `TWILIO_VERIFY_SERVICE_SID` (**primary rail** —
  Twilio Verify, founder decision 2026-07-18; no phone number purchase
  needed) and optionally `TELEGRAM_GATEWAY_TOKEN` (secondary —
  gateway.telegram.org; empty → Gateway never used).
  `PHONE_CODE_PRIMARY_PROVIDER` (default `twilio`; set `telegram` to flip
  the order). Either rail alone works; with neither set the endpoints
  answer 503 and the Telegram one-tap flow is unaffected. Twilio gotchas:
  a trial account only texts numbers verified in the console, and Geo
  Permissions must allow the target countries.
  **An upgraded account is not immediately a sending account (2026-08-05).**
  The founder upgraded off trial and the REST API reported `type: "Full"`,
  `status: "active"`, `$20.00` balance within seconds — while a real send to a
  Ukrainian number was refused with **`403 / code 60238` "Verification Creation
  Attempt blocked by Twilio"**, which Twilio documents as the upgrade being
  under review (its only other cause is Iran/Syria/Cuba). Account type and
  sending permission are separate states, so **`type: Full` is not evidence
  that SMS works** — only a real send is. Twilio's guidance is to wait and to
  contact support if it persists past **72 hours**.
  **Re-checked 2026-08-22 from the iOS device pass: still 403, and the review
  window is long gone.** The account reports `type: Full`, `status: active`,
  `$20.00` — identical to 2026-08-05 — while `pm2 logs gennety-bot` shows
  `[phone-verification] twilio start returned 403` on every attempt. The 72-hour
  window closed **2026-08-08**; nobody opened a support ticket, so seventeen
  days of "under review" have produced no change and there is no reason to
  expect the eighteenth to differ. **Waiting is no longer a strategy — this
  needs a support ticket**, and the ticket is now the oldest unaddressed item
  blocking launch: with `TELEGRAM_GATEWAY_TOKEN` unset (still true today) the
  phone rail has no fallback, so **no new user can register on any surface that
  uses it**, including the native iOS app, whose sign-in cannot be reached at
  all. Our side degrades
  correctly: `twilioStartVerification` returns null on the 403, the Gateway
  fallback is unconfigured, and the route answers a visible
  `503 "Code delivery unavailable"` rather than a phantom code-entry screen.
  Re-test with one command — no `verify` call, so no account is resolved,
  created or logged in:

```sh
curl -s -X POST https://dating-api.gennety.com/v1/auth/phone/request \
  -H 'Content-Type: application/json' \
  -d '{"phone":"+380XXXXXXXXX","channel":"sms"}' -w '\n%{http_code}\n'
# 200 + deliveredVia:"sms" = the rail is open. 503 = still blocked;
# read the exact Twilio code from: pm2 logs gennety-bot --nostream | grep twilio
```

  A 60238 that outlives the review window is NOT the same failure as Geo
  Permissions (which must separately allow +380) — check the returned code
  before changing any console setting.
  **Requires `db:push` of the additive `phone_otps` table first**
  (non-destructive). Anti-SMS-pumping: per-phone+IP express limits plus a
  durable per-phone cooldown (60 s) and daily cap (6/day) in the table.
- StoreKit 2 tickets (native iOS; rides `TICKET_FEATURE_ENABLED`):
  `APPSTORE_KEY_PATH` (App Store Connect → Users and Access → Integrations →
  In-App Purchase key `.p8`, scp'd next to the APNs key), `APPSTORE_KEY_ID`,
  `APPSTORE_ISSUER_ID` (same Integrations page), `APPSTORE_BUNDLE_ID`
  (default `com.gennety.ios`), `APPSTORE_ENVIRONMENT` (`sandbox` default →
  TestFlight/dev purchases; `production` for App Store builds),
  `APPSTORE_TICKET_PRODUCTS` (default `ticket_1:1,ticket_3:3,ticket_6:6`).
  Server Notifications V2 URL to set in App Store Connect:
  `https://dating-api.gennety.com/v1/webhooks/appstore`. Without the keys
  the purchase endpoint answers 503; no schema change (rides the unique
  `ticket_ledger.external_payment_id` already deployed for Stars).
- Push (native iOS, direct APNs — the Expo rail was retired 2026-07-18):
  `APNS_KEY_PATH` (path to the `.p8` APNs Auth Key on the droplet, e.g.
  `/opt/gennety/keys/AuthKey_XXXXXX.p8` — NOT committed; scp it manually),
  `APNS_KEY_ID` (the key's 10-char id), `APNS_TEAM_ID` (Apple Developer
  Team ID), `APNS_BUNDLE_ID` (default `com.gennety.ios`),
  `APNS_ENVIRONMENT` (`sandbox` default). **Corrected 2026-08-22 — this line
  used to say "dev/TestFlight builds use the sandbox host", and the TestFlight
  half of that is wrong.** What picks the host is the `aps-environment`
  entitlement of the *installed binary*, not how the tester got it: a build
  installed over the cable from Xcode is signed with a development profile
  (`development` → sandbox host), while a build that went through TestFlight or
  the App Store is signed with a distribution profile (`production` → the live
  host). So TestFlight sits on the production side of this switch. Sending to
  the wrong host does not degrade, it fails: APNs answers `BadDeviceToken`, and
  a device token does not say which environment minted it, so nothing upstream
  can catch the mismatch. **One `APNS_ENVIRONMENT` therefore serves one half at
  a time** — the moment iOS goes to TestFlight (iOS 6.3), a phone on the cable
  stops receiving and vice versa. Fixing that for real means storing the
  environment next to the token at registration, or retrying the other host on
  `BadDeviceToken`; neither exists yet. With any of the
  first three empty, pushes are dropped with a warning and everything else
  works. **Requires `db:push` of the additive `live_activity_tokens` table
  first** (non-destructive). `EXPO_ACCESS_TOKEN` is retired and can be
  removed from `/opt/gennety/.env`.
- Liveness (AWS Rekognition Face Liveness — replaced Persona 2026-07-26):
  `FACE_LIVENESS_ENABLED` (must be `true` in production — startup fails
  closed), `FACE_LIVENESS_MIN_CONFIDENCE` (default `0.8`; below it the check is
  RETRYABLE, never `rejected`), `LIVENESS_STS_ROLE_ARN`
  (`arn:aws:iam::147010141827:role/GennetyLivenessClient`),
  `LIVENESS_CREDENTIALS_TTL_SECONDS` (default/floor `900`). Reuses the existing
  `AWS_*` credentials and region. **Since 2026-07-26 requires `db:push` of the
  additive `users.pending_liveness_session_id` column** (nullable,
  non-destructive) — it binds a liveness session to the user who minted it, and
  the `/event` handler reads it unconditionally, so a DB missing it throws
  `P2022` on every completed check. Push the schema BEFORE restarting. **Removed with the provider:**
  `ENABLE_PERSONA_VERIFICATION`, `PERSONA_TEMPLATE_ID`,
  `PERSONA_ENVIRONMENT_ID`, `PERSONA_API_KEY`, `PERSONA_WEBHOOK_SECRET`,
  `PERSONA_HOSTED_URL_BASE`, `ALLOW_SANDBOX_PERSONA` — delete these from
  `/opt/gennety/.env`; the process no longer reads them.
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
- Proposal reply countdown + deadline nudge (always-on, no feature flag,
  Telegram-only): the pitch's live reply-deadline **button** re-render
  (`workers/proposal-countdown.ts`, `editMessageReplyMarkup`) and the new
  match-nudge **deadline heads-up** (`workers/match-nudge.ts`, one DM ~2 h
  before the 24 h TTL to still-undecided sides). Both run on the existing crons
  (`PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `MATCH_NUDGE_CRON_SCHEDULE`) — no new
  schedule, no new env. `PROPOSAL_COUNTDOWN_CRON_SCHEDULE` defaults to
  `* * * * *` since 2026-07-25 (was `*/5 * * * *`) so the button label moves
  every minute; `editMessageReplyMarkup` raises no notification, and the load
  is one edit per undecided side per minute only during a 24 h window (paced at
  25 edits/s, single-flight via `guardedTick`). Set the env override back to
  `*/5 * * * *` to restore the old cadence without a redeploy. **Requires `db:push` of the additive
  `matches.proposal_deadline_nudge_sent_at` column first** (nullable,
  non-destructive; a DB missing it throws `P2022` on the nudge sweep). Mobile
  clients render their own countdown from the public API and are unaffected.
- Per-side synergy rationale (always-on, no feature flag, bug fix 2026-07-25):
  the match-reveal synergy reason is now stored + rendered **per side in that
  side's own language** instead of pair-wide (it used to splice side A's
  sentence into side B's otherwise-localized pitch header, and into the mobile
  `synergyReason`). **Requires `db:push` of the additive
  `matches.synergy_reason_b` column first** (nullable, non-destructive; a DB
  missing it throws `P2022` on every pitch dispatch AND on
  `GET /v1/matches/current`, so push the schema BEFORE restarting). Existing
  rows keep their single reason and fall back to it for side B. No env, no new
  system dependency; `/v1/*` contract unchanged (same `synergyReason` field,
  correct language).
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
  (`mock` default / `stripe`), `TICKET_PRICE_CENTS` (default `849`),
  `TICKET_PAYMENT_WINDOW_HOURS` (default `24`).
  - **Real payments = Telegram Stars (XTR), the production rail.**
    `TICKET_STARS_ENABLED` (default `false`) makes the date gate **and** the
    store pay natively in Telegram Stars via `WebApp.openInvoice` +
    `pre_checkout_query` + `successful_payment` (`handlers/payments.ts`). Needs
    **no** merchant account / provider token (empty provider token +
    `currency: "XTR"`); Stars→TON withdrawal is a Telegram-side setting.
    `TICKET_BUNDLE_STARS` (default `1:425,3:1020,6:1650`, `<count>:<stars>` pairs)
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
  for the venue picker). The lapse/express-revert sweep runs on the existing
  date-lifecycle `setInterval`. **Since 2026-07-26 there is also one new hourly
  cron** — `VENUE_CHANGE_REFUND_CRON_SCHEDULE` (default `0 * * * *`, registered
  only when the flag is on) — retrying failed Stars refunds and reversing
  purchases abandoned mid-settle, the twin of `REMATCH_REFUND_CRON_SCHEDULE`.
  **Requires `db:push` of the new additive `venue_change_purchases` table
  first** (non-destructive; the settle path writes to it on every payment, so a
  DB missing it throws `P2022` on the `successful_payment` boundary — push the
  schema BEFORE restarting). Rollback: flip the flag off; the additive
  columns/table may stay.
- Gennety Premium (feature-flagged, recurring subscription, §Premium):
  `PREMIUM_FEATURE_ENABLED` (default `false` — leave off until launch),
  `PREMIUM_STARS` (default `750`, the monthly Telegram Stars price — exactly
  what Telegram's Star store bills $17.99 for),
  `PREMIUM_PRICE_USD_DISPLAY` (default `$17.99`, display-only; it must always
  name the real cost of `PREMIUM_STARS`, so the two are edited together — a
  cheaper label over a 750⭐ charge misleads), and
  `PREMIUM_APPSTORE_PRODUCT_ID` (default `premium_monthly`, the StoreKit 2
  auto-renewable subscription id — matched by full id or last dot-segment). When
  on, the menu shows a ✨ Gennety Premium row → hub → the Premium Mini App
  (`premium.html`), and the venue-change board shows premium venues locked with a
  subscribe-in-place upsell; a subscriber's venue changes are free. **Standalone
  per-user entitlement** (`services/premium.ts`) — decoupled from venue-change.
  - **Telegram Stars recurring rail.** `POST /v1/premium/stars-invoice` mints a
    `createInvoiceLink` with `subscription_period=2592000` (Telegram supports
    only the 30-day period; empty provider token + `XTR`, no merchant account).
    The `sub:premium` payload is settled by the bot's `successful_payment`
    handler on the first charge AND every auto-renewal, exactly-once via the
    recurring `telegram_payment_charge_id`. Cancellation is native (Telegram →
    Settings → Subscriptions) OR **in-chat via the menu agent** (the user asks to
    cancel → `offer_cancel_premium` tool → a nonce-bound confirm card → Bot API
    `editUserStarSubscription`, `handlers/menu/premium-cancel.ts`); either way the
    entitlement simply lapses at `premiumUntil` (no early revoke, no mid-period
    refund). After a confirmed in-chat cancel the bot asks the churn reason and
    stores it on the `cancelled` `subscription_ledger.note`. Telegram-only.
  - **iOS StoreKit rail (parallel).** `POST /v1/premium/appstore/transaction`
    (JWT) + the existing App Store Server Notifications webhook
    (`/v1/webhooks/appstore`, now routes SUBSCRIBED/DID_RENEW/EXPIRED/REFUND/
    REVOKE for the premium product) reuse the `APPSTORE_*` config already
    deployed for tickets. No new Apple keys.
  - **Premium venues.** Curated venues carry a `tier` (`base`/`premium`); premium
    rows may exceed the ≤ MODERATE price cap and are seeded with
    `pnpm seed-venues:pull --tier=premium` (relaxed price gate; every other
    quality gate stays) → review → `seed-venues:import --apply`. The auto-assign
    concierge picker stays base-only.
  - **In-chat cancellation.** No new env. The menu agent's `offer_cancel_premium`
    tool + `handlers/menu/premium-cancel.ts` handle it; the churn reason lands in
    the additive `subscription_ledger.note` column (see below). Telegram-only —
    App Store subs are guided to iOS Settings, iOS cancels natively via Apple, so
    no `/v1/*` contract change.
  - **Requires `db:push` first** of the additive `users.premium_*` columns, the
    new `subscription_ledger` table (now including the additive nullable
    `subscription_ledger.note` churn-reason column — non-destructive; a DB
    missing it throws `P2022` on an in-chat cancel), `curated_venues.tier`, and
    `matches.venue_change_tier` (all non-destructive; deploy code + push schema
    BEFORE flipping the flag — the new columns are read by the venue board and
    the entitlement service). Redeploy the Mini App bundle (`premium.html` +
    reworked `venue-change.html`). No new system dependency. Rollback: flip
    `PREMIUM_FEATURE_ENABLED` off; the additive columns/table may stay. An
    entitlement already granted stays valid regardless of the flag.
- Referral program (feature-flagged, "Give a date, get a date", see
  `REFERRAL_PRODUCT_SPEC.md`): `REFERRAL_FEATURE_ENABLED` (default `false` —
  leave off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED` (it pays rewards in Date Tickets AND complimentary
  Premium months). Tunables: `REFERRAL_INVITEE_PREMIUM_MONTHS` (default `1`, the
  invited user's welcome Premium month shown on the onboarding wow screen),
  `REFERRAL_LADDER` (default `1:1:1,3:1:1,5:1:1,10:2:2` =
  `<count>:<ticketsDelta>:<monthsDelta>`, the referrer's milestone ladder —
  cumulative 1/1, 2/2, 3/3, 5/5), and `REFERRAL_DAILY_REWARD_CAP` (default `3`,
  a per-referrer 24h anti-fraud reward-hold). The reward fires at the invited friend's **verification** (the
  anti-fraud gate); the invitee's Premium month is granted at the onboarding
  screen. **Requires `db:push` of the additive `users.referral_verified_count`
  (default 0) / `referral_counted_at` / `referral_invitee_premium_at` columns
  first** (non-destructive; the referrer tally + invitee once-markers). Rewards
  reuse `ticket_ledger` (`referral_milestone`) + `subscription_ledger`
  (`referral`) — no new tables. Also **redeploy the Mini App bundle**
  (`referral.html` ships with the Vite build — the referrer ladder + one-tap
  share). Uses `BOT_USERNAME` (invite deep link) + `PUBLIC_BASE_URL` (the public
  HMAC-signed `GET /v1/referral/card` image Telegram fetches for the shared
  photo) — both already set. The branded share card reuses the date/match-card
  satori stack + bundled fonts (no new system dependency); a render failure
  degrades the share to a rich text article. Runs inline at verification / the
  onboarding screen — no new cron. iOS: `GET/POST /v1/me/referral*` (JWT) +
  `features.referral` in `/v1/app/config`. Rollback: flip the flag off; the
  additive columns may stay. Telegram-first; iOS attribution via a referral code.
- Promo codes (feature-flagged, independent campaign links, see
  `PROMO_CODES_PRODUCT_SPEC.md`): `PROMO_FEATURE_ENABLED` (default `false` — leave
  off until launch). Rides the already-on `TICKET_FEATURE_ENABLED` +
  `PREMIUM_FEATURE_ENABLED`. Grants a NEW user **1 free Date Ticket + 3 months
  Premium** at a richer, distinct onboarding wow screen (new users only,
  first-touch, mutually exclusive with referral). Tunables (all optional):
  `PROMO_DEFAULT_TICKETS` (`1`) / `PROMO_DEFAULT_PREMIUM_MONTHS` (`3`, the
  `promo:create` defaults), `PROMO_ATTRIBUTION_TTL_MIN` (`60`, iOS
  fingerprint-match window), `PROMO_APP_STORE_URL` (the App Store URL the
  `GET /v1/promo/:code` landing bounces iOS visitors to; empty → no redirect),
  and the emergency `PROMO_MANUAL_ENTRY_ENABLED` (`false` — a pre-wired
  manual-entry fallback field, off by product decision). **Requires `db:push` of
  the additive `users.promo_redeemed_at` column + the new `promo_codes` /
  `promo_redemptions` tables first** (non-destructive). Rewards reuse
  `ticket_ledger` (`promo`) + `subscription_ledger` (`promo`). Also **redeploy
  the Mini App bundle** (`onboarding.html` ships the new promo wow screen).
  Create codes with the CLI: `pnpm promo:create --code=SUMMER3M --tickets=1
  --months=3 --max=500 --expires=2026-09-01` (also `promo:disable` /
  `promo:stats` / `promo:list`; writes to the `DATABASE_URL` in scope — run with
  prod env for prod). Telegram uses `t.me/<bot>?start=promo_<CODE>` (reliable);
  iOS is a custom deferred deep link (clipboard + coarse fingerprint via the
  in-memory `services/promo-attribution.ts`, `GET /v1/promo/:code` landing +
  `POST /v1/me/promo/claim-deferred` + `/v1/me/promo/claim`, JWT), **best-effort
  with no manual fallback** — a miss silently loses the gift (flip
  `PROMO_MANUAL_ENTRY_ENABLED` if painful). `features.promo` in `/v1/app/config`;
  iOS client tasks in `~/Desktop/Gennety-iOS/IMPLEMENTATION_PLAN.md`. Runs inline
  at the wow screen — no new cron, no new system dependency. Rollback: flip the
  flag off; the additive columns/tables may stay. Launch: deploy code + push
  schema BEFORE flipping the flag (the new columns are read by onboarding state),
  create at least one code, then set `PROMO_FEATURE_ENABLED=true`.
- Rematch (feature-flagged, paid on-demand engine re-run, PRODUCT_SPEC §3.11 /
  `REMATCH_PRODUCT_SPEC.md`): `REMATCH_FEATURE_ENABLED` (default `false` — leave
  off until launch). When on, a man whom the Thursday batch left unpaired, or
  whose match expired without a date, gets a DM offering one paid re-run of the
  matching engine for himself; the woman it finds never buys and never sees a
  price — she gets an ordinary pitch with gift framing. Telegram-only (Stars is a
  Telegram rail); no `/v1/*` or OpenAPI change. Tunables: `REMATCH_STARS`
  (default `150`), `REMATCH_PRICE_USD_DISPLAY` (`$2.99`, display-only),
  `REMATCH_MAX_PER_WEEK` (`2`), `REMATCH_COOLDOWN_HOURS` (`24`),
  `REMATCH_GIFT_CAP_DAYS` (`7`, protects a candidate from serial gift-pitching),
  `REMATCH_PRE_BATCH_BLACKOUT_HOURS` (`6`, keeps a single-seeker run from taking
  a candidate the globally-optimal Thursday batch needed; `0` disables),
  `REMATCH_FAILED_LOOKBACK_DAYS` (`14`), and `REMATCH_REFUND_CRON_SCHEDULE`
  (`0 * * * *`). **Requires `db:push` of the additive `matches.source` (default
  `'weekly'`) / `matches.rematch_paid_by_id` columns and the new
  `rematch_purchases` table FIRST** (non-destructive, but `matches.source` is
  read unconditionally by the pitch + the admin algorithm route, so a DB missing
  it throws `P2022` on every dispatch — push the schema BEFORE restarting).
  Payments ride the existing Stars rails (`rematch:v1` payload in
  `handlers/payments.ts`; no merchant account, same XTR mechanics as tickets and
  independent of `TICKET_STARS_ENABLED`). The refund-retry cron is registered
  only when the flag is on. No Mini App change, no new system dependency.
  **Pricing note:** 150⭐ follows the ticket rate ($8.49/425⭐ = $0.02/⭐ → ≈$3.00);
  at the more conservative $0.024/⭐ rate documented under `PREMIUM_STARS`, 150⭐
  bills nearer $3.59 — if you want Premium's strict "never under-promise the
  charge" convention, set `REMATCH_STARS=125` or raise the display price (both
  env-only). Rollback: flip the flag off; the additive columns/table may stay.
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
  **Venue photos require `PLACES_API_KEY` — no key, no venue photo** (the card
  still renders, on its branded gradient). Since 2026-07-25 Google Places is the
  SINGLE source: the retired `CuratedVenue.photoUrl` fallback is gone, and
  curated venues — the primary assignment source — have their cover resolved
  from their stored `placeId` at assignment time (`fetchPlacePhotoName`, one
  extra Places request per scheduled date; also fires at a §3.7b venue-change
  agreement / express mint). Google's bytes are fetched at render, credited on
  the card, never persisted. (`PLACES_API_KEY` re-verified present on the
  droplet 2026-07-25, and a live probe of a real curated Kyiv venue returned its
  cover photo — superseding the stale "empty" note in the 2026-07-13 flag table
  below.) Runs inline at venue finalization —
  no new cron. Any render failure degrades to the existing plain-text scheduled
  DM, so the flag is safe to toggle live with `pm2 restart gennety-bot
  --update-env`.
- Match card (feature-flagged): `MATCH_CARD_FEATURE_ENABLED` (default `false`).
  When on, the match-pitch photo album is replaced by the rendered collage
  card set (card 1 = photo + name/vibe panel, following cards = one full-bleed
  photo each; PRODUCT_SPEC.md §3.3). Uses the same satori/resvg/canvas stack
  and bundled fonts as the date card plus `apps/bot/src/assets/brand/butterfly-logo.svg`
  and the Unbounded woffs in `assets/fonts/` (all ride the code rsync), and one
  extra OpenAI call per side for the short card copy. Any copy/render/send
  failure falls back to the plain protected media group, so the flag is safe to
  toggle live with `pm2 restart gennety-bot --update-env`. No schema change.
- Type Radar (feature-flagged visual appearance calibration, §Type Radar /
  `TYPE_RADAR_PRODUCT_SPEC.md`): `TYPE_RADAR_ENABLED` (default `false` — the
  whole feature ships dark) + `TYPE_PREF_FLOOR` (default `1.0` = the `V_type`
  match multiplier is a pure no-op even when enabled; launch value ≈ `0.7`,
  the weakest factor — read directly by the match engine, mirroring
  `AGE_RANGE_PREF_*`). When on, the conversational onboarding shows a skippable
  visual "choose your type" step **before** the Magic Prompt (a `web_app` button
  into `radar.html` + an inline Skip); submit/skip resumes the flow. The
  compiled per-set preference vector (`Profile.typePrefTags`) scores a partner's
  `Profile.appearanceTags` — the candidate side is tagged by an **isolated**
  cheap vision pass on the verified branch (separate from the Elo attractiveness
  call, so a tagging regression never perturbs the live Elo seed; no extra call
  while dark). **Requires `db:push` of the additive `Profile.type_radar_answers`
  / `type_pref_tags` / `type_radar_completed_at` / `type_radar_age_band` /
  `appearance_tags` and `match_score_logs.score_type` columns first** (all
  nullable/defaulted, non-destructive). Also **redeploy the Mini App bundle**
  (`radar.html` ships with the Vite build) — the 24 band-A calibration portraits
  live in `apps/webapp/public/radar/a/*.jpg` and ride the webapp rsync. No new
  system dependency (tagging reuses `OPENAI_API_KEY` via the `visionFast`
  model). Rollout is two-stage: (1) `db:push` + deploy code + Mini App with the
  flag OFF (everything inert); (2) flip `TYPE_RADAR_ENABLED=true` to start
  collecting radar answers while `TYPE_PREF_FLOOR=1.0` keeps scoring unchanged
  (shadow); later lower `TYPE_PREF_FLOOR` (e.g. `0.7`) to let `V_type` actually
  re-rank. `WEBAPP_URL` must be a real HTTPS host for the picker button (dev
  without a tunnel degrades to Skip-only). Rollback: flip the flag off; the
  additive columns/images may stay.
- Type Radar "thinking state" (always-on, rides `TYPE_RADAR_ENABLED`):
  `RADAR_THINKING_ENABLED` (default **`true`** — `config.ts` reads
  `!== "false"`). The ~10.7s status sequence played in chat between the radar
  Mini App closing and the next onboarding question
  (`TYPE_RADAR_PRODUCT_SPEC.md` → *Close → "thinking state" → next question*;
  PRODUCT_SPEC §1.3): four scripted beats then a profile counter decelerating
  onto a 160–220 total. **No schema change, no Mini App redeploy, no new
  dependency** — it is bot-side only and reuses the existing
  `runStatusSequence` primitive, so a full server code deploy carries it.
  Localized in all five languages.
  Two things worth knowing before flipping it:
  - It is a **deliberate labor illusion**. Nothing is scanned — the radar
    verdicts are saved before it starts, and matching doesn't run until the
    Thursday batch. Founder-approved (2026-07-27) with the copy as specified.
  - It **holds the user ~10.7s** (plus a 2.2s lead-in that waits out the Mini
    App's own close animation) before their next onboarding question. That is
    real added time in the funnel — watch
    `GET /admin/analytics/onboarding-funnel` for a drop-off bump at the
    AI-memory / photos step after enabling it.

  Set `RADAR_THINKING_ENABLED=false` + `pm2 restart gennety-bot --update-env`
  to drop straight to the next question; nothing else changes. That kill switch
  is the whole rollback.
- Founder notifications (feature-flagged private ops feed): `FOUNDER_NOTIFY_ENABLED`
  — **ON in production since 2026-07-16** (founder bot `@sverkausbot`, chat id set).
  When on, a SEPARATE founder bot DMs the founder four things: (1) each new user's
  full profile + photos on first activation (no AI-memory dump), (2) a tokenized
  weekly-matches report link after the Thursday batch, (3) both date cards + venue
  when a date locks in, (4) the full profile + **phone number** + photos when a
  user freezes or hard-deletes their account (bot Settings→Delete/Freeze and mobile
  `DELETE /v1/me`; the delete path snapshots the row and downloads any photo
  bytes before the storage cleanup + Prisma cascade run). (Item 4 briefly sent
  an anonymous event instead, 2026-07-16 → 2026-07-28, over a since-reverted
  GDPR concern — see PRODUCT_SPEC.md §2.1 and `legal/privacy-policy.md` §12.2.)
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
  **Since 2026-07-26 also requires `db:push` of the additive nullable
  `founder_reports.expires_at` column** — report links now expire after 90 days
  (the token is the page's sole auth and rides in the URL, so it also sits in
  access logs). A null means never-expires, so links created before the upgrade
  keep working. Rollback: flip the flag off; the additive column/table may stay.
- Optional cron overrides: `MATCH_CRON_SCHEDULE`, `CRON_TIMEZONE`,
  `EXPIRY_CRON_SCHEDULE`, `NO_MATCH_NOTICE_CRON_SCHEDULE`,
  `PROPOSAL_COUNTDOWN_CRON_SCHEDULE`, `RE_ENGAGEMENT_CRON_SCHEDULE`,
  `MATCH_NUDGE_CRON_SCHEDULE`,
  `STATUS_TIMER_CRON_SCHEDULE`, `AUTO_UNSUSPEND_CRON_SCHEDULE`,
  `EMBEDDING_REFRESH_CRON_SCHEDULE`, `SELFIE_RETENTION_CRON_SCHEDULE`,
  `VENUE_REVALIDATION_CRON_SCHEDULE`, `TICKET_EXPIRY_CRON_SCHEDULE`,
  `RETENTION_CRON_SCHEDULE`,
  `REMATCH_REFUND_CRON_SCHEDULE`, `VENUE_CHANGE_REFUND_CRON_SCHEDULE`,
  `PROFILER_CRON_SCHEDULE`, `DATE_LIFECYCLE_TICK_MS`, `DISPATCH_DELAY_MS`,
  `MATCH_PREROLL_DELAY_MS`
- Data retention (always-on, no feature flag, added 2026-07-26):
  `RETENTION_CRON_SCHEDULE` (default `45 3 * * *`, Europe/Kyiv) deletes aged OTP
  challenges (7 d), dead refresh sessions (30 d past unusable), and proxy-chat
  messages (90 d). No schema change, no new env beyond the schedule, no new
  system dependency. **Deletes are irreversible, so verify the backlog before
  the first production run**: check `SELECT count(*) FROM phone_otps WHERE
  created_at < now() - interval '7 days';` (and the same for `email_otps`,
  `user_sessions`, `proxy_messages`) so the first sweep's numbers are expected
  rather than a surprise. Batched at ≤1000 rows per table per tick, so a large
  backlog drains over several nights instead of one long-running transaction.
  **The `user_sessions` window is deliberately tied to `JWT_REFRESH_TTL` (30 d)
  — if you raise that env var, raise `SESSION_RETENTION_MS` with it**, or
  refresh-token reuse detection quietly stops firing for long-lived tokens.
  Rollback: set the schedule far-future (e.g. `0 0 31 2 *`); nothing else reads
  the worker.
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
  **2026-07-26 update — requires `db:push` of two more additive
  `profiles` columns before deploying the code**: `profiler_answer_window_until`
  and `profiler_question_message_id` (both nullable; a DB missing them throws
  `P2022` on the first question sent, which surfaces as a PM2 restart loop).
  They bound how long an open question may claim the user's free text
  (PRODUCT_SPEC §Phase 1b), so an unrelated message no longer gets recorded as
  its answer. No new env and no new system dependency; the same release also
  halves the Profiler shimmer, drops its emoji, stops streaming the question
  text, shortens `PROFILER_STALL_TIMEOUT_MS` to 6 h, and expands the question
  bank with situational questions that repeat each drop cycle — all code-only.

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
pnpm sync-venues:kyiv --check   # free: local validation, no network
pnpm sync-venues:kyiv --apply   # 219 Place Details, billed per request
pnpm seed-venues:import --in=scripts/curated-venues.kyiv.approved.json --apply
```

**⚠️ This sequence used to open with a bare `pnpm sync-venues:kyiv`, and that
line cost money.** `--apply` gated only the file write, so the flagless run made
all 219 Place Details requests and *then* printed "Dry run:" — meaning the
documented way to edit one venue's tier billed **438** requests, twice what the
work needs. Fixed 2026-08-23 (DECISIONS.md): a flagless run now prints the
request count and exits without touching the network, so it is a genuine plan.
`--check` is the free look; `--apply` is the one that spends. The same trap and
the same fix apply to `resolve-venues:kyiv` (167 Text Search requests, where
`--write` gated only the write) and to `backfill-venue-quality.mjs`, whose dry
run fetched everything and whose default `--limit` was **1000** top-tier
requests — now 100.

When the operator hands over a raw list of venue NAMES (no place ids), resolve
and triage it first — `sync-venues:kyiv` needs stable place ids and fails on
anything below the quality gate:

```sh
# 1. Put the names in scripts/curated-venues.kyiv.additions.json
#    ({"name": "...", "tier": "base|premium|alternative"}).
pnpm resolve-venues:kyiv                  # free: prints the request count, exits
pnpm resolve-venues:kyiv --write          # names -> place ids + review flags
# 2. Read the flags. A `name-mismatch` is Google answering with a DIFFERENT
#    venue — confirm the address, then set "acceptMatch": true, or fix "query".
pnpm merge-venues:kyiv                    # dry run: what is accepted/rejected
pnpm merge-venues:kyiv --apply            # fold into the expansion manifest
#    --promote-expensive re-tiers EXPENSIVE base venues to premium instead of
#    dropping them (an operator decision — off by default).
# 3. Reconcile + re-tag, then import as above.
pnpm sync-venues:kyiv --apply
pnpm backfill-venue-facets --only-missing --apply
```

`backfill-venue-facets --only-missing` matters: `sync-venues:kyiv` rebuilds rows
from Google Places, which knows nothing about Venue Intent V2 facets. It now
carries existing `facetTags`/`hardCapabilities` across a rebuild, but venues
added for the first time have none, and without `hardCapabilities` a row fails
the V2 indoor/outdoor hard filter and never gets picked.

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
# Venue Intent V2 rollout

This release is additive. Before enabling it, take the standard production DB
backup, deploy code, then run the documented production `db:push`. Do not drop
legacy vibe or venue columns. Backfill curated rows with `city_key` (`ua:kyiv`,
`ua:kharkiv`, `ua:odesa`) via the reviewed venue import inputs; duplicate legacy
domain rows may remain because runtime deduplicates them.

Before live rollout, audit every active `base` curated row used by V2: rating
must be at least 4.0 with at least 30 reviews; commercial/admission categories
must have a provider `price_level` or one operator-confirmed canonical price tag
(`free`, `inexpensive`, `moderate`). Rows without this evidence remain stored
for operator repair and Venue Change, but fail closed for the initial automatic
assignment. No schema migration is required for this policy update.

Start with all three flags at zero/off. Then enable the master flag with shadow
10% and live 0%. Keep shadow for at least seven days and 30 completed pairs.
Advance live 10% → 50% → 100% with at least 48 hours per step. Roll live back to
0 immediately on any hard-constraint violation, fake/closed assignment,
finalisation error regression, or venue-change-rate increase over baseline by
more than five percentage points. Shadow can remain on during rollback.
