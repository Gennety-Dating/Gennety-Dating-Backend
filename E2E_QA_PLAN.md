# Gennety Dating Full E2E QA Plan

> Snapshot date: 2026-06-07.
> Target: local services, local dev database, and Telegram bot
> `@gennetytestbot`. Production `@gennetybot` is explicitly out of scope until
> the release gate passes.

## Test Accounts

| Role | Telegram | Telegram ID | Email verification | Identity verification |
|---|---|---:|---|---|
| Primary | `@GN01001` | `782065541` | Real university email and real OTP | Full Persona + AWS Rekognition |
| Secondary | `@gennetysupport` | `5986970093` | Dev-only allowlisted bypass | Test skip path first; Persona in a separate pass if needed |

The email bypass is configured only in `.env.local` through
`DEV_OTP_BYPASS_TELEGRAM_IDS=5986970093`. It creates a synthetic verified
email only for the secondary Telegram ID. The matcher requires each account to
have a verified corporate domain, but matches users by the same canonical
dating city; the two domains do not need to be equal.

## Current Preflight

- `.env.local` targets `localhost:5434/gennety_dev`.
- `.env.local` targets `BOT_USERNAME=gennetytestbot`.
- The Mini App URL is HTTPS.
- OpenAI, Persona, AWS, Supabase, email, JWT, and admin credentials are set.
- `TICKET_FEATURE_ENABLED=true`.
- Coordination and venue-change flags are currently off/unset.
- Both target users are reset to `onboarding/consent`; their prior profiles,
  bot sessions, and pair matches were removed on 2026-06-07.

Do not begin the clean E2E pass until the running process is confirmed to use
the dev bot token.

## User Entry Paths

1. Direct Telegram entry: search/open `@gennetytestbot`, then `/start`.
2. Telegram bot deep link: `https://t.me/gennetytestbot?start=<source>`.
   The source is persisted as `tg:<source>` for attribution.
3. Website handoff: website email OTP creates a one-time
   `?start=auth_<token>` link. Legacy `web_<token>` links remain accepted.
4. Persona hosted-flow return: `?start=verify_done` resumes verification
   polling without restarting onboarding.
5. Telegram command re-entry: `/start` resumes the current DB-backed step;
   `/menu`, `/profile`, `/edit`, and `/settings` enter completed-user surfaces.
6. Telegram Mini Apps opened from bot buttons:
   onboarding, verification, ticket, calendar, location, venue change, and
   post-date feedback.
7. Mobile/public API entry: university OTP through `/v1/auth/*`, then Bearer
   JWT access to onboarding, profile, assistant, Aether, match, and settings
   routes. A full mobile app is not present in this repository.
8. Admin dashboard/API entry: Bearer `ADMIN_API_KEY` to `/admin/*`.

## Current Feature Inventory

### Onboarding And Identity

- Consent, Terms acceptance, research opt-in, and five-language selection.
- Full-screen Telegram onboarding Mini App.
- University email validation, OTP request/verify, and resend.
- Dating-city search, browser geolocation resolution, map/city selection, and
  timezone persistence.
- AI memory export accepted/declined branches.
- Tool-calling conversational profile collection.
- Text and Whisper voice input.
- Magic Prompt context ingestion, psychological summary, and embedding.
- Deterministic fallback summary/embedding when AI memory export is declined.
- Static photo and Telegram Live Photo upload with exact/perceptual duplicate,
  unsafe-content, one-person, and same-identity checks across Telegram,
  edit-profile, mobile API, and Aether attachment paths.
- Profile-video validation with bounded `ffmpeg` samples, independent frame
  and transcript moderation, and distributed owner evidence. Group/travel
  video is allowed; scenery-only and one-moment owner cameos are rejected.
- Persona embedded or hosted liveness flow.
- AWS Rekognition comparison against every profile photo.
- Verified, pending, pending-review, rejected, and soft-skip outcomes.
- Reverification after photo edits and 90-day selfie retention cleanup.
- Five-step onboarding re-engagement chain.
- Post-onboarding Profiler batches, answers, skip, and repeat-skip behavior.

### Completed User Surface

- Pinned weekly-match countdown/status banner.
- Profile view with generated bio and photos.
- Edit bio, major, preferences/age range, and photos.
- Pause and resume matching.
- Language settings.
- Start/retry verification.
- Account deletion.
- Help/support.
- Free-form menu assistant for profile and account actions.

### Matching And Date Flow

- Wednesday teaser, Thursday weekly batch, and no-match notice.
- Eligibility hard filters, embedding/research/Elo scoring, starvation boost,
  score logs, lifetime pair ban, and cooldown.
- Personalized streamed pitch, photo card, synergy score, and 24-hour timer.
- Blind accept/decline decisions, neutral peer nudge, decline reason analysis,
  expiry, silent-ignore handling, and compensating priority.
- Proposal and scheduling nudges.
- Optional Date Ticket gate with mock payments, pay-self/pay-both rules,
  partner-paid state, expiry/refund, and free calendar fallback.
- Peer-aware calendar with 30 server-approved slots, live polling,
  no-overlap, one-overlap auto-lock, and multi-overlap confirmation.
- Vibe parsing and commute-origin selection by search, geolocation, map tap,
  marker drag, or raw Telegram location.
- Curated-first venue selection, Google Places fallback, quality gates,
  Maps URI, and Telegram `date_time` entity.
- Optional one-shot female venue change.
- Wingman hints, icebreakers, emergency cancellation, female safety brief,
  optional pre-date contact/proxy coordination, and post-date feedback.
- Structured Mini App feedback and voice/text feedback.
- Reports, LLM severity triage, negative constraints, strikes, suspension,
  ban, pending investigation, and duplicate-report prevention.

### API And Operations

- Mobile OTP auth and refresh-token rotation.
- Current-user read/update/delete, home/raw location, match-radius preference,
  push token, verification state, and photo CRUD.
- Mobile onboarding interview by text/voice.
- Post-onboarding assistant by text/voice.
- Aether multimodal image upload, message, history, and signed image URLs.
- Current match, decision, vibe-location, safety acknowledgment, and report.
- Telegram Mini App state/write APIs for onboarding, verification, ticket,
  calendar, location, venue change, and feedback.
- Persona HMAC webhook.
- Admin demographics, funnel, matches, audience, heatmap, algorithm, gender,
  retention, dates, verification, users, reports, review, and rerun-verification.
- Workers for matching, expiry, no-match, countdown, re-engagement, Profiler,
  nudges, ticket expiry, teaser, unsuspend, embedding refresh, status banner,
  selfie retention, venue revalidation, and date lifecycle.

## Public API Checklist

Unauthenticated or purpose-specific:

- `GET /v1/ping`
- `POST /v1/auth/otp/request`
- `POST /v1/auth/otp/verify`
- `POST /v1/auth/refresh`
- `POST /v1/web-registration/otp/request`
- `POST /v1/web-registration/complete`
- `POST /v1/webhooks/persona`

Bearer JWT:

- `GET|PATCH|DELETE /v1/me`
- `POST /v1/me/location`
- `POST /v1/me/home-location`
- `PATCH /v1/me/preferences`
- `POST /v1/me/push-token`
- `GET /v1/me/verification`
- `GET /v1/me/verification/url`
- `GET|POST /v1/me/photos`
- `DELETE /v1/me/photos/:index`
- `GET /v1/onboarding/interview`
- `POST /v1/onboarding/interview/answer`
- `POST /v1/onboarding/interview/voice`
- `POST /v1/onboarding/consent`
- `POST /v1/assistant/ask`
- `POST /v1/assistant/voice`
- `POST /v1/chat/upload`
- `POST /v1/chat/message`
- `GET /v1/chat/history`
- `GET /v1/matches/current`
- `POST /v1/matches/:id/decision`
- `POST /v1/matches/:id/vibe-location`
- `POST /v1/matches/:id/safety-ack`
- `POST /v1/matches/:id/report`
- `GET /v1/countdown`

Telegram `initData` HMAC:

- `/v1/telegram-onboarding/state|consent|language|email/*|city/*|ai-memory|complete`
- `GET /v1/verification/mini-app/init`
- `POST /v1/verification/mini-app/event`
- `GET /v1/matches/:matchId/ticket/state`
- `POST /v1/matches/:matchId/ticket/intent|confirm`
- `GET /v1/calendar/state`
- `POST /v1/calendar/pick`
- `GET /v1/location/search`
- `POST /v1/location/select`
- `GET /v1/venue-change/state|catalog`
- `POST /v1/venue-change/propose`
- `POST /v1/feedback/post-date`

For every route test success, missing auth, invalid auth, malformed body,
boundary values, wrong participant, wrong state, duplicate/replay, rate limit,
and provider failure where applicable.

## Execution Plan

### Pass 0: Automated Baseline

1. Run focused bot, API, verification, calendar, venue, feedback, and webapp
   tests.
2. Run bot and webapp typechecks.
3. Run a build if the focused checks pass.
4. Record failures before modifying test data.

### Pass 1: Clean Onboarding

1. Stop any process polling with the dev bot token.
2. Run `pnpm dev:reset-onboarding`, then explicitly apply
   `pnpm dev:reset-onboarding:apply`.
3. Start local DB, bot/API, webapp, and HTTPS tunnel.
4. Confirm Telegram `getMe` resolves to `@gennetytestbot`.
5. Primary account: complete consent, language, real email OTP, city, both AI
   memory branches across separate resets, profile fields, voice input, static
   photos/Live Photo, and Persona.
6. Secondary account: confirm email screens are skipped only for ID
   `5986970093`; complete every other required step normally.
7. Validate resume behavior by closing the Mini App and restarting Telegram at
   several steps.
8. Validate invalid OTP, expired OTP, invalid domain, duplicate email, bad
   photo, too many photos, and missing required profile answers.

### Pass 2: Persona And Rekognition

1. Primary: complete an approved Persona inquiry with matching profile photos.
   Expect `verified`, per-photo scores, selfie path, and no Elo skip penalty.
2. Secondary: use the two-step skip. Confirm first tap changes nothing; final
   confirmation sets `verificationSkippedAt`, `unverified`, active status, and
   exactly one 150-point penalty.
3. Controlled reruns: matching face, borderline image, no-face/group image,
   and clearly non-matching consenting test image.
4. Confirm any detected-face fail rejects; no-face alone yields
   `pending_review`; provider/storage failures never reject.
5. Edit/add/delete photos and confirm score-array alignment and rerun behavior.
6. Verify Persona webhook signature rejection, replay/idempotency, pull
   fallback, and admin rerun.

### Pass 3: Profile, Menu, Profiler, And Workers

1. Exercise every menu button and command.
2. Confirm immutable identity fields cannot be edited.
3. Edit all mutable fields and verify embedding dirty/refresh behavior.
4. Pause/resume and confirm match eligibility changes.
5. Trigger Profiler: answer, skip once, skip twice, batch transition, quiet
   hours, and language behavior.
6. Trigger re-engagement, status timer, teaser, no-match tiers, and nudges with
   controlled timestamps.

### Pass 4: Matching And Decisions

1. Confirm both accounts have verified domains, the same `homeCityKey`, and
   saved city coordinates.
2. Run the real weekly matcher once and inspect eligibility and score logs.
3. Use `pnpm dev:trigger-test-match` for repeatable downstream branch passes.
4. Test A accept then B accept; A decline then B accept; A accept then B
   decline; both decline; one silent until expiry.
5. Before the second decision, verify neither account learns the first
   account's choice.
6. Confirm final decisions cannot be changed and duplicate callbacks are safe.

### Pass 5: Ticket And Calendar

Run separate bot restarts for `TICKET_FEATURE_ENABLED=false` and `true`.

1. Ticket off: mutual accept opens Calendar immediately.
2. Ticket on: self-pay/self-pay, male pay-both, female pay-both rejection,
   duplicate confirm, partial expiry, refund marker, and free fallback.
3. Calendar: first mover only, no overlap, exactly one overlap, multiple
   overlaps and manual confirmation, resave no-op, unauthorized slot, stale
   match, and live peer polling.
4. Verify old Telegram calendar cards are replaced/removed correctly.

### Pass 6: Venue And Scheduled Date

1. Submit vibe and location in both possible orders.
2. Test all location input modes and invalid/out-of-range coordinates.
3. Test curated venue, strict Places result, relaxed-price result, text-search
   result, and local fallback.
4. Inspect venue existence, operational status, rating, reviews, price,
   commute fairness, opening hours, Maps URI, and `date_time` entity.
5. Enable `VENUE_CHANGE_FEATURE_ENABLED=true` for a separate pass: eligibility,
   disclaimer, radius, comment length, accept, decline/cancel, timeout, and
   one-shot behavior.

### Pass 7: Date Lifecycle And Safety

Use `qa-orchestrator.ts` or controlled clock scripts only to move timestamps;
perform user decisions manually.

1. T-5h icebreakers and emergency button.
2. Emergency abort and confirmed cancellation with verbatim reason.
3. T-1.5h female safety brief and wingman reveal.
4. Enable `COORDINATION_FEATURE_ENABLED=true`: share self, request partner
   approve/decline, proxy open, text relay, media rejection, report, leave,
   and T+2h close.
5. T+24h structured feedback and voice/text feedback on separate sides.
6. Confirm feedback updates events/constraints without exposing private
   partner data.

### Pass 8: Reports, Admin, Mobile API

1. Submit Tier 1, Tier 2, Tier 3, and duplicate reports in controlled test
   rows; verify exact state transitions and in-flight cancellation.
2. Verify admin auth failures, analytics payloads, users, report queue,
   review action, and verification rerun.
3. Exercise all public routes with an API client and save a redacted result
   table containing request class, status, latency, and contract checks.
4. Verify refresh-token rotation/replay rejection and account deletion
   cascades using a disposable mobile-only user, never either primary QA user.

### Pass 9: Release Gate

- All required scenarios pass or have an accepted documented exception.
- No cross-account data leakage or blind-decision violation.
- Persona/AWS false accept, false reject, and infrastructure outcomes reviewed.
- Venue results manually verified.
- No duplicate DMs from workers.
- No secret, production token, or production DB used during QA.
- Full test/typecheck/build green.
- Feature flags chosen explicitly for production.
- Dev email bypass absent from production.
- Rollback and production smoke checklist prepared from `deploy.md`.

## Evidence To Capture

For each scenario record: timestamp, account, build commit, feature flags,
Telegram screenshot/message ID, API status/body with secrets removed, relevant
DB state before/after, provider dashboard result, expected result, actual
result, and pass/fail/blocked. Never store OTPs, tokens, selfies, raw private
messages, or user photos in the QA notes.
