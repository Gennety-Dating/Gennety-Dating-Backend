# Gennety Dating — Architecture

> Product logic and user flow are in [PRODUCT_SPEC.md](PRODUCT_SPEC.md).
> Tech stack and coding rules are in [AGENTS.md](AGENTS.md).
> Production deploy instructions are in [deploy.md](deploy.md).
> This file documents durable architecture boundaries. Code, Prisma schema,
> route files, and env loading remain the source of truth for implementation
> details.

## Production Endpoints

The DigitalOcean droplet (`167.172.178.229`) terminates TLS via **Caddy**
(auto-renewed Let's Encrypt). DNS for the `gennety.com` zone lives at Hostinger.

| Subdomain | Reverse-proxies to | Purpose |
|---|---|---|
| `api-admin.gennety.com` | `localhost:3100` | Admin analytics dashboard API (`ADMIN_API_KEY` Bearer auth, `helmet` + IP rate-limit + timing-safe key compare). |
| `dating-api.gennety.com` | `localhost:3101` | Public `/v1/*` API for the Expo/mobile client **and** the Persona liveness webhook (`/v1/webhooks/persona`). |

**Domain isolation:** `api.gennety.com` is owned by a sibling project — never
use it for Gennety Dating. Always pick names prefixed with `dating-` here.

The bot itself runs **long-polling** (grammY `bot.start`) on the same host;
it does not need an inbound subdomain. Telegram delivers updates to whichever
process is currently polling — so prod (`@gennetybot`) and local dev
(`@gennetytestbot`) MUST use different bot tokens.

Persona production webhook target: `https://dating-api.gennety.com/v1/webhooks/persona`.

## Top-Level Topology

```
┌──────────────────┐   ┌──────────────────┐
│ Telegram client  │   │ Expo/mobile API  │
│ (bot + Mini App) │   │  (iOS / Android) │
└────────┬─────────┘   └────────┬─────────┘
         │ Bot API + WebApp     │ HTTPS  (Bearer JWT)
         │ + signed HTTP POST   │
         ▼                      ▼
┌─────────────────────────────────────────┐
│  Node.js process (apps/bot)             │
│  ─────────────────────────────────────  │
│  • grammY bot (long-polling)            │
│  • Express public  API  (:3101)         │
│  • Express admin   API  (:3100)         │
│  • cron workers + date lifecycle tick   │
└─────────────────────────────────────────┘
       │           │            │
       │ pgvector  │ OpenAI     │ External APIs
       ▼           ▼            ▼
┌───────────┐ ┌──────────┐ ┌──────────────────────────┐
│ Postgres  │ │ OpenAI / │ │ Persona (liveness)       │
│ + pgvector│ │ Whisper  │ │ AWS Rekognition (face)   │
│ (Supabase)│ │          │ │ Google Places (venue)    │
└───────────┘ └──────────┘ │ Supabase Storage (media) │
                           │ Resend/email provider    │
                           │ Expo / APNs / FCM (push) │
                           └──────────────────────────┘
```

## End-to-End Architecture Schema

```mermaid
graph TD
    %% ── Clients ────────────────────────────────────
    TG_User[Telegram user]
    Mini[Telegram Mini Apps<br/>Calendar + Post-date Feedback]
    Mobile[Expo/mobile client]

    %% ── Single Node.js process (apps/bot) ──────────
    subgraph Process["Node.js process (apps/bot)"]
      Bot[grammY bot<br/>long-polling]
      PublicAPI["Public /v1/* API<br/>(Express :3101)"]
      AdminAPI["Admin /admin/* API<br/>(Express :3100)"]
      Crons["14× node-cron schedules<br/>+ date lifecycle interval"]
      OnboAgent[Onboarding collector<br/>server state + LLM extractor]
      MenuAgent[Menu LLM agent]
      Aether[Aether concierge<br/>multimodal chat]
      Match[Match engine<br/>SQL+Node re-rank]
      DispatchQ[Dispatch queue<br/>rate-limited DM]
      Verify[Verification pipeline<br/>Persona+Rekognition]
      DateLC[Date-lifecycle service]
      Push[Push service<br/>Expo SDK]
    end

    %% ── External services ──────────────────────────
    OpenAI[(OpenAI<br/>GPT + embeddings + Whisper)]
    PersonaSvc[(Persona<br/>hosted KYC)]
    Rekog[(AWS Rekognition<br/>CompareFaces)]
    Places[(Google Places API)]
    Email[(Resend/email provider)]
    Supabase[(Supabase Storage<br/>selfies + profile photos + chat images)]
    PushSvc[(Expo / APNs / FCM)]

    %% ── Data layer ─────────────────────────────────
    PG[(PostgreSQL + pgvector<br/>Prisma)]

    %% ── Edges: clients ↔ process ───────────────────
    TG_User <-->|Bot API messages,<br/>InlineKeyboard, FSM| Bot
    Mini -->|MainButton +<br/>signed HTTP POST<br/>/v1/calendar/pick<br/>/v1/feedback/post-date| PublicAPI
    Mobile <-->|Bearer JWT| PublicAPI

    %% ── Edges inside process ───────────────────────
    Bot --> OnboAgent
    Bot --> MenuAgent
    Bot --> Match
    Bot --> Verify
    Bot --> DateLC
    Crons --> Match
    Crons --> DispatchQ
    Crons --> DateLC
    Crons --> Push
    PublicAPI --> Aether
    PublicAPI --> Verify
    AdminAPI --> Verify

    %% ── Edges: process → external ──────────────────
    OnboAgent <--> OpenAI
    MenuAgent <--> OpenAI
    Aether <--> OpenAI
    Match <--> OpenAI
    Verify -->|trusted terminal inquiry webhook| PersonaSvc
    Verify -->|CompareFaces| Rekog
    Verify -->|selfie/photo storage| Supabase
    Aether -->|chat images| Supabase
    DateLC -->|venue lookup| Places
    Bot -->|OTP delivery| Email
    Push --> PushSvc

    %% ── Edges: process → DB ────────────────────────
    Bot <--> PG
    PublicAPI <--> PG
    AdminAPI <--> PG
    Crons <--> PG
    Match -->|cosine ANN| PG
    Verify --> PG

    %% ── Webhooks back into process ─────────────────
    PersonaSvc -.HMAC-signed webhook<br/>POST /v1/webhooks/persona.-> PublicAPI
```

## Process Layout

A **single** Node.js process (`apps/bot`) hosts everything:

- **grammY bot** — long-polling Telegram updates; routes via Composer-based
  handlers (`handlers/router.ts`).
- **Public Express server** on `PUBLIC_PORT` (default `3101`). Mobile client
  consumer; also receives the Persona webhook and the signed Calendar
  Mini App POST. Refuses to start if `JWT_SECRET` is shorter than 16 chars.
- **Admin Express server** on `ADMIN_PORT` (default `3100`). Started only
  when `ADMIN_API_KEY` is set. Bearer-auth + helmet + per-IP rate limit.
- **Background jobs** — 14 `node-cron` schedules (one, ticket-expiry, is only
  registered when `TICKET_FEATURE_ENABLED`) plus the date-lifecycle interval
  (see *Cron & Workers* below).

Importing `./config.js` is the very first thing `index.ts` does — this
ensures `.env.local` overrides `.env` *before* `@gennety/db` evaluates
`new PrismaClient()` and locks in `DATABASE_URL`.

## Data Models (PostgreSQL + Prisma)

Source of truth: [`packages/db/prisma/schema.prisma`](packages/db/prisma/schema.prisma).
This section is an architectural map, not a manually authoritative schema dump;
when columns diverge, Prisma wins.

### Enums

| Enum | Values |
|---|---|
| `UserStatus` | `onboarding`, `active`, `paused`, `frozen`, `suspended`, `pending_investigation`, `banned` (`frozen` = soft-delete: user chose "Freeze" instead of deleting; row/profile/embedding/verification kept, excluded from matching, silently reactivated to `active` on next `/start`) |
| `Language` | `en`, `ru`, `uk`, `de`, `pl` |
| `OnboardingStep` | `consent`, `language`, `conversational`, `completed` |
| `Gender` | `male`, `female` |
| `GenderPreference` | `men`, `women`, `both` |
| `Platform` | `telegram`, `mobile`, `both` |
| `WebRegistrationPurpose` | `join`, `login` |
| `VerificationStatus` | `unverified`, `pending`, `pending_review`, `verified`, `rejected` |
| `MatchRadius` | `campus_only`, `citywide` |
| `MatchStatus` | `proposed`, `negotiating`, `negotiating_venue`, `scheduled`, `cancelled`, `completed`, `expired` |
| `MatchEventActionType` | `PROPOSAL_SHOWN`, `ACCEPTED`, `DECLINED`, `DATE_COMPLETED`, `CHEMISTRY_POSITIVE`, `CHEMISTRY_NEGATIVE`, `EXPIRED_SILENT`, `EXPIRED_PEER_IGNORED` |
| `MessageRole` | `user`, `assistant`, `system` |
| `AiMemoryExportPreference` | `undecided`, `accepted`, `declined` |
| `ProfilerPriority` | `high`, `medium`, `low` |

### `users`

Columns (≈ 35; grouped by purpose):

| Group | Columns |
|---|---|
| Identity | `id`, `telegramId` (unique BigInt — synthetic **negative** id for mobile-only users), `telegramUsername` (public `@handle`, captured opportunistically for `t.me/` coordination links), `email`, `universityDomain`, `firstName`, `surname`, `age`, `gender`, `preference`, `major`, `language`, `platform` |
| Lifecycle | `status` (`UserStatus`), `onboardingStep`, `aiMemoryExportPreference`, `aiMemoryExportPreferenceAt`, `hasConsented`, `consentedAt`, `termsAccepted`, `termsAcceptedAt`, `researchOptIn`, `createdAt`, `updatedAt` |
| Email OTP | `emailOtp`, `emailOtpExpiresAt`, `isEmailVerified` |
| Conversational state | `messageHistory` (`Json[]`), `lastMessageAt`, `lastPreMatchAnnounceAt` |
| Re-engagement | `reEngagementStep` (0–5), `reEngagementNextAt` |
| Trust & safety | `strikes`, `suspendedUntil` |
| Telegram UI | `statusMessageId` (pinned banner) |
| Push (mobile) | `pushToken`, `pushPlatform` |
| Verification | `verificationStatus`, `personaInquiryId` (unique), `verifiedAt`, `verificationSkippedAt`, `verifiedSelfiePath`, `faceMatchScore`, `faceMatchedAt`, `selfiePath` (legacy) |
| Attribution | `referralSource` (`tg:start_param` / `mobile:utm=…` / `referral:USER_ID`) |
| Tickets (feature-flagged) | `ticketBalance` — materialized ticket-wallet balance; running sum of `TicketLedger.delta` (see `ticket_ledger`). `ticketDiscountPct` / `ticketDiscountGrantedAt` / `ticketDiscountExpiresAt` / `ticketDiscountConsumedAt` — one-time famine single-ticket discount (PRODUCT_SPEC §3.5b; active ⇔ `pct > 0 AND consumedAt IS NULL AND expiresAt > now`), owned by `services/ticket-discount.ts`. |

Indexes: `(status, reEngagementNextAt)`, `(status, suspendedUntil)`.

### `onboarding_progress` (1:1 with `users`)

Server-owned traversal metadata for incomplete onboarding:

| Column | Ownership |
|---|---|
| `completedFields`, `skippedFields`, `askedFields` | Collector state only; never copies personal answers |
| `currentQuestion` | Deterministic next-question key used by Telegram and public/mobile API |
| `collectorVersion`, `backfilledAt` | Rollout and lazy-backfill audit |
| `revision` | Optimistic concurrency guard so simultaneous answers do not lose facts |

Canonical answers remain in `users` and `profiles`. `messageHistory` is an
interface/audit log, not a profile database. Only `user_text` may enter fact
extraction; `resume`, `context_dump`, and `photos_updated` are typed synthetic
events. Backfill reads canonical columns and raw user-authored messages, never
AI summaries, assistant messages, or historical tool arguments.

### `profiles` (1:1 with `users`)

Columns (≈ 25):

| Group | Columns |
|---|---|
| Demographics | `userId` (unique), `ethnicity`, `height`, `hobbies` (`String[]`), `partnerPreferences`, `psychologicalSummary`, `negativeConstraints`, `ageRangeMin`, `ageRangeMax` |
| Vector | `embedding` (`vector(1536)`), `embeddingDirty`, `embeddingDirtyAt` |
| Elo | `eloScore` (default 500), seeded from the server-side mean of all per-photo vision scores; `eloMatchesPlayed`; `eloSeededAt`; auditable aggregate/per-photo output in `eloSeedDetails` |
| Photos | `photos` (`String[]` of static Telegram `file_id` or Supabase path), `profileMedia` (`Json[]` structured display media; empty legacy rows normalize from `photos[]`), `referenceFaceEmbedding` (`Json?` upload-time identity-anchor metadata for the confirmed identity cluster), `uploadedPhotoHashes` (`String[]` perceptual hashes for accepted static photos), `pendingPhotoCandidates` (`Json[]` hidden unconfirmed consensus pool), `acceptedPhotoCount` (`Int`), `photoFaceScores` (`Float[]`, 1:1 with `photos`) |
| Geo / radius | `matchRadius` (`campus_only` / `citywide`), `homeCity`, `homeCountryCode`, `homeCityKey`, `homePlaceId`, `latitude`, `longitude`, `locationUpdatedAt`, `timeZone` (IANA, derived from the dating city; drives the Profiler's local-time batch windows) |
| Match priority | `lastMatchedAt`, `missedWeeks`, `standbyCount`, `lastMissedAt`, `silentIgnoreCount` |
| Profiler (Phase 1b) | `profilerStartedAt`, `profilerNextAt`, `profilerActiveQuestionId`, `profilerBatchRemaining` — scheduler state for the post-onboarding Q&A batches that fuel icebreakers/hints (see [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §Phase 1b). Indexed `@@index([profilerNextAt])` for the worker sweep. |
| Vibe (matching) | `fridayVibeText`, `vibeFocusText` (raw onboarding §1.3 answers), `energyAxis` / `orientationAxis` (`Float?` `[-1,1]`, scored by `V_research` quadrant proximity), `socialRole` (`String?` initiator/participant/observer — whitelist-validated in app code, **stored but not scored** in v1), `anchorTags` (`String[]`), `vibeExtractedAt`. Written at finalize by `services/vibe-axes.ts`; the raw Friday text is also folded into `psychologicalSummary`. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §1.3 / §3.2. |
| Audit | `createdAt`, `updatedAt` |

### `matches`

Columns (≈ 40). Drives the entire matching → scheduling → date lifecycle. See
[PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3–4 for the state machine.

| Group | Columns |
|---|---|
| Identity | `id`, `userAId`, `userBId`, `status` (`MatchStatus`), `createdAt`, `updatedAt` |
| Pitch & synergy | `pitchForA`, `pitchForB`, `synergyScore` (clamped 70–99), `synergyReason` |
| Decision (blind invariant) | `acceptedByA`, `acceptedByB` (tri-state `null`/`true`/`false`), `rejectionReasonA`, `rejectionReasonB`, `dispatchedAt`, `pitchMessageIdA`, `pitchMessageIdB` |
| Calendar scheduling | `proposedTimes` (`DateTime[]`, server-side allowlist of valid slots: 6 dates × 17:30/18:00/18:30/19:00/19:30), `availableTimesA`/`availableTimesB` (`DateTime[]`, each side's marked availability), `agreedTime` (set after a single exact overlap is agreed; multi-overlap is confirmed in the Mini App), `calendarMessageIdA/B` (current Telegram post-accept CTA per side: accepted/waiting, Date Ticket, or Calendar; edited on status changes and cleared after agreement). `schedulingIteration` and `pickedTimeA/B` are deprecated — retained for backwards-compat with in-flight rows mid-deploy and will be dropped in a follow-up cleanup migration. |
| Concierge venue | `vibeTextA`, `vibeTextB`, `vibeLatA/LngA`, `vibeLatB/LngB`, `vibeAddressA/B` (Mini App map-picker label), `parsedCategoryA`, `parsedCategoryB`, `venueName`, `venueAddress`, `venueLat`, `venueLng`, `venueGoogleMapsUri`, `venuePhotoUrl` (curated photo absolute URL) / `venuePhotoName` (Places photo resource name; rebuilt to a media URL at date-card render with the server-side key, never persisting Google's bytes), `venuePromptAskedAt` |
| Date lifecycle | `icebreakersSentAt`, `iceBreakersA`/`B` (`String[]`), `safetyNoteSentAt`, `safetyAckA`/`B`, `wingmanHintA`/`B`, `wingmanSentAt`, `emergencyCancelledBy`, `emergencyReason`, `feedbackByA`/`B`, `feedbackPromptedAt` |
| Nudges | `nudge1SentAt`, `nudge2SentAt` (legacy), `proposalNudge1SentAt`, `proposalNudge2SentAt`, `schedNudge1SentAt`, `schedNudge2SentAt` |
| Date Ticket (feature-flagged) | `ticketPriceCents`, `ticketPaidA/B`, `paidForPartnerByA/B`, `ticketStatus` (`pending`/`partial`/`completed`/`refunded`/`expired` — string, not a Prisma enum), `ticketExpiresAt`. Monetization sub-state machine that runs while `status = negotiating`; inert when `TICKET_FEATURE_ENABLED` is off. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.5b. |
| Pre-date coordination (feature-flagged) | `coordOfferSentAt`, `coordInitiatorId`, `coordMethod` (`share_self`/`request_partner`/`proxy` — string, not a Prisma enum), `coordChosenAt`, `coordPartnerConsent` (Variant B only), `coordResolvedAt`, `proxyOpenedAt`, `proxyClosesAt`, `proxyClosedAt`. Sub-state machine running on a `scheduled` match; inert when `COORDINATION_FEATURE_ENABLED` is off. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §Phase 4. |
| Venue change (feature-flagged) | `venueChangeStatus` (`proposed`/`accepted`/`rejected`/`expired` — string, not a Prisma enum), `venueChangeProposerId`, `venueChangeProposedAt` (one-shot guard), `venueChangeExpiresAt`, `venueChangeResolvedAt`, `venueChangeName`/`Address`/`Lat`/`Lng`/`MapsUri`/`PlaceId` (proposed replacement), `venueChangeComment` (verbatim ≥10-char relay). Female-exclusive one-shot venue swap sub-state on a `scheduled` match; inert when `VENUE_CHANGE_FEATURE_ENABLED` is off. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.7b. |

Indexes: `(status, createdAt)`, `(userAId, userBId)`, `(ticketStatus, ticketExpiresAt)` (ticket-expiry cron sweep), `(status, coordOfferSentAt)` (coordination offer sweep), `(coordMethod, proxyClosedAt)` (proxy open/close sweeps), `(venueChangeStatus, venueChangeExpiresAt)` (venue-change expiry sweep), plus the functional
`matches_pair_canonical_idx` on `LEAST/GREATEST(user_a_id, user_b_id)` —
created out-of-band by `ensureMatchPairIndex()` at boot — that backs the
**lifetime ban** anti-join (a user never sees the same partner twice).

### `match_score_logs` (1:1 with `matches`)

Frozen score breakdown captured at match creation — `scoreExplicit`,
`scoreResearch`, `scoreLeague`, `scorePenalty`, `scoreTotal`,
`embeddingDistance`, `starvationBonus`. Powers
`/admin/analytics/algorithm` so component weights can be A/B-tuned without
scanning the hot `matches` table.

### `match_events`

Append-only audit trail (`actionType` ∈ `MatchEventActionType`). Drives regular
Elo updates, expiry telemetry, and the dashboard's "ignored you" counter.
Emergency cancellation's small peer boost is applied directly by
`handlers/date/emergency.ts`, not through `match_events`. Indexed by
`(matchId, createdAt)`, `(actorId, createdAt)`, `(targetId, createdAt)`,
`(actionType, createdAt)`.

### `reports`

Post-match user-vs-user reports. LLM-triaged into `tier` 1/2/3
(`reasonSummary` is the distilled rationale). `adminReviewed` flips on the
manual-queue clear. Unique `(reporterId, matchId)` blocks duplicates. See
[PRODUCT_SPEC.md](PRODUCT_SPEC.md) §5 for tier policy.

### `email_otps`

Mobile-side OTP store. **Distinct from `users.emailOtp`**: keyed by `email`
(not `userId`) because mobile users start the funnel before a `User` row
exists. `code` is bcrypt-hashed; raw is only delivered via the email provider. Tracks
`attempts` and `consumedAt` for replay protection.

### `web_registration_links`

Browser → Telegram pre-registration handoff. A user can verify their corporate
email on the website *before* opening the bot; the verified state is carried
into Telegram via a one-time deep link. Columns: `tokenHash` (unique SHA-256 of
the raw token — only the hash is stored, the raw token rides the
`/start auth_<token>` / legacy `web_<token>` deep link), `email`,
`universityDomain`, `language`, `purpose` (`WebRegistrationPurpose` ∈
`join`/`login`), `termsAccepted`/`termsAcceptedAt`, `researchOptIn`,
`expiresAt`, `consumedAt`, `consumedTelegramId`. Written by
`services/web-registration.ts` via the `/v1/web-registration/*` API; consuming
the link in onboarding lets the Mini App skip the Email/OTP screens
(`isEmailVerified` is pre-set). See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §1.1.

### `user_sessions`

Active mobile refresh tokens. Access JWTs are stateless; refresh tokens are
hashed here for server-controlled rotation/revocation.

### `bot_sessions`

grammY session adapter persistence (Prisma-backed). Keyed by Telegram chat id.

### `system_knowledge`

Curated knowledge entries surfaced to the menu/onboarding agents. Each row:
`key` (unique), `title`, `content`, `category`, `priority`, `active`.

### `messages`

Aether concierge multimodal chat history (one row per turn, with optional
`imageUrl` pointing at an opaque Supabase Storage path — renderers mint
short-lived signed URLs). Distinct from `users.messageHistory` which the
legacy onboarding/menu agents still use.

### `proxy_messages`

Append-only audit log of every text message relayed through a Variant C
pre-date **anonymous proxy chat** (`matchId`, `senderId`, `body`, `createdAt`;
`onDelete: Cascade` from `matches`). Backs the moderation trail that justifies
the time-boxed carve-out to the "NO IN-APP CHAT" invariant — relayed content is
fully logged and each relayed message carries an in-line Report button. Written
by `handlers/date/coordination.ts`; inert unless `COORDINATION_FEATURE_ENABLED`.

### `media_validation_rejections`

Append-only audit of upload-time profile-media rejections. Stores only
`userId`, coarse `mediaType` (`photo`/`video`), `rejectionReason`, and
`createdAt`; raw media, hashes, provider payloads, face crops, and biometric
material are never persisted here. Written by the photo/video validation
wrappers before a rejected asset can be committed to `profiles`.

### `ticket_ledger` (feature-flagged)

Append-only audit of every ticket-wallet movement (`userId`, `delta`, `reason`
∈ `photo_bonus`/`video_bonus`/`verification_bonus`/`welcome_gift`/
`store_purchase`/`spend_match`/`refund`, optional
`matchId`/`amountCents`/`bundleSize`, `createdAt`; `onDelete: Cascade` from
`users`). The running sum of `delta` equals `User.ticketBalance`, which is
materialized for fast reads; both are written in the same transaction by
`services/ticket-wallet.ts`. Photo/video onboarding bonuses are idempotent via
`Profile.photoBonusTicketAt` / `videoBonusTicketAt`; the verification bonus and
the first-pitch welcome gift use a serializable ledger claim on
`verification_bonus` / `welcome_gift`. Indexed `(userId, createdAt)`.
Inert unless `TICKET_FEATURE_ENABLED`. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.5b.

### `profiler_answers`

One row per (user, Profiler question) — `questionId`, `priority`
(`ProfilerPriority`), `answerText`, `skipped`, `skipReturned`, `cycleId`;
`@@unique([userId, questionId])`, `onDelete: Cascade` from `users`. Backs the
Phase 1b Profiler (see [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §Phase 1b): timed
post-onboarding Q&A that is the **primary source** for icebreakers
(`date-lifecycle.ts`) and wingman/date-planning hints (`wingman-hint.ts`).
Deliberately NOT read by the matching engine. Written by
`handlers/profiler/router.ts` + `services/profiler.ts`; scheduled by
`workers/profiler.ts`. The question bank is first-party data in
`packages/shared/profiler-questions.ts`.

### `no_match_notices`

Audit row for the empathetic "no match this week" DM. `tier` is the
consecutive-famine count; `dropDate` is truncated to the UTC day of the cron
firing, and `(userId, dropDate)` is unique — both an idempotency guard and
the data source for the dashboard's churn-warning trend.

### `curated_venues`

First-party, hand-curated first-date venues currently scoped by
`universityDomain`. This is the **primary** source for the concierge venue picker
when a same-domain venue pool exists; Google Places is the fallback for
cross-domain city matches (see [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.7). Standalone model (no user
relation) — the venue pool is now first-party data we own, not a per-request
Places lookup. Columns: `name`, `address`, `lat`, `lng`, `googleMapsUri`,
`category` (validated against the shared whitelist in app code, not a Prisma
enum), `priority` (1 best … 3 acceptable), `vibeTags`, `active`,
`lastVerifiedAt`, plus `placeId` (Places resource id for exact re-fetch),
`utcOffsetMinutes` + `openingHours` (Places `regularOpeningHours`, for the
open-at-slot check), and `photoUrl` (optional operator-supplied venue photo,
surfaced in the venue-change catalog card; null for un-photographed rows).
Indexed by `(universityDomain, category, active)`. Read by
`services/curated-venue.ts` (`resolveVenue`) and `services/venue-change.ts`
(the venue-change catalog); populated out-of-band by
`scripts/seed-venues.mjs` and kept fresh by the venue re-validation cron
(`services/venue-revalidation.ts`).

Operator-level brand exclusions are enforced in both curated ranking and the
Google Places gate, preventing a deleted brand from returning through fallback
search. Kyiv expansion data is maintained by stable Places ids in
`scripts/curated-venues.kyiv.expansion.json` and reconciled into the approved
catalog with `pnpm sync-venues:kyiv`.

## Cron & Workers (`apps/bot/src/index.ts`)

All schedules are env-overridable (the canonical names are listed below).

| Schedule (default) | TZ | Purpose | Module |
|---|---|---|---|
| `0 18 * * 4` (Thu 18:00) | Europe/Kyiv | **Weekly matching batch** — same-city global greedy + dispatch | `services/match-engine.ts` → `services/dispatch-queue.ts` |
| `15 18 * * 4` (Thu 18:15) | Europe/Kyiv | "No match this week" empathetic DM | `services/no-match-notifier.ts` |
| `0 18 * * 3` (Wed 18:00) | Europe/Kyiv | Pre-match teaser (24 h ahead of batch) | `workers/pre-match-announce.ts` |
| `*/15 * * * *` | UTC | 24 h TTL match expiry | `services/match-expiry.ts` + `services/expiry-notify.ts` |
| `*/5 * * * *` | UTC | Live "⏳ Xh left" countdown plate edits on the pitch DM | `workers/proposal-countdown.ts` |
| `0 * * * *` | UTC | Match nudges — proposal (3 h / 10 h), scheduling (6 h / 12 h) | `workers/match-nudge.ts` |
| `*/5 * * * *` | UTC | Onboarding re-engagement (5-step decay) | `workers/re-engagement.ts` |
| `*/15 * * * *` | UTC | Profiler scheduler — lazy-seed + dispatch post-onboarding Q&A batches in local morning/evening windows | `workers/profiler.ts` → `services/profiler.ts` |
| `* * * * *` | UTC | Pinned status banner (live discrete countdown) | `workers/status-timer.ts` |
| `*/5 * * * *` | UTC | Embedding refresh (dirty-flag scan, ≤20 rows/tick) | `workers/embedding-refresh.ts` |
| `0 * * * *` | UTC | Auto-unsuspend elapsed Tier-2 suspensions | `services/match-engine.ts` (`autoUnsuspendElapsed`) |
| `30 3 * * *` | Europe/Kyiv | GDPR Article 9 selfie scrub (90 d post-`verifiedAt`) | `services/selfie-retention.ts` |
| `0 4 * * *` | Europe/Kyiv | Curated venue re-validation (closure/rating sweep + hours refresh, ≤30 rows/tick) | `services/venue-revalidation.ts` |
| `0 * * * *` (only when `TICKET_FEATURE_ENABLED`) | UTC | Date Ticket expiry: refund stalled `partial` payments and open the Calendar for free | `workers/ticket-expiry.ts` → `handlers/matching/ticket-gate.ts` |
| `setInterval(2 min)` | — | Date lifecycle: **venue-change expiry sweep** (cancels a stalled `proposed` swap before ice-breakers — feature-flagged), ice-breakers (T-5 h), emergency window, T-1.5 h pre-date safety, T+24 h feedback, wingman; **pre-date coordination** (T-60 m offer, T-30 m proxy open, T+2 h proxy close — feature-flagged) | `services/date-lifecycle.ts` + `services/pre-date-safety.ts` + `services/coordination.ts` + `handlers/matching/venue-change.ts` |

Quiet hours **23:00–09:00 Europe/Kyiv** are enforced inside `re-engagement`
and `match-nudge` (not at the cron level — it would let scheduling drift),
so a touch landing in quiet hours is deferred to the next allowed window.

## Public `/v1/*` API Surface

Mounted by `apps/bot/src/public/server.ts`. JWT bearer auth on all routes
except `auth/*`, `webhooks/persona`, `calendar/*`, and `ping`.

| Method | Path | Purpose |
|---|---|---|
| GET  | `/v1/ping` | Liveness probe |
| GET/POST | `/v1/telegram-onboarding/*` | Telegram full-screen Onboarding Mini App state/consent/language/email OTP/city/AI-memory choice/completion handoff. Authenticates with `Authorization: tma <initData>`; `POST /ai-memory` persists `accepted` or `declined`, `/state` returns it and issues the short-lived visual-flow token, and `/complete` dispatches the post-handoff bot DM only after city + AI-memory choice are saved. |
| POST | `/v1/auth/otp/request` | Send corp-email OTP (rate-limited) |
| POST | `/v1/auth/otp/verify` | Verify OTP → mint access + refresh JWT |
| POST | `/v1/auth/refresh` | Rotate refresh token |
| POST | `/v1/web-registration/otp/request` | Website pre-registration: send corp-email OTP before the user opens Telegram (rate-limited; no auth — pre-account) |
| POST | `/v1/web-registration/complete` | Website pre-registration: verify OTP + ToS, mint a one-time `web_registration_links` token, return the `/start auth_<token>` deep link that carries verified state into the bot (rate-limited) |
| GET / PATCH / DELETE | `/v1/me` | Read / patch / delete current user |
| POST | `/v1/me/home-location` | Persist canonical dating city (`homeCityKey`) + coordinates for match eligibility |
| POST | `/v1/me/location` | Persist raw home-base lat/lng for Meet-Halfway; does not by itself unlock matching |
| PATCH | `/v1/me/preferences` | `matchRadius`, gender preference |
| POST | `/v1/me/push-token` | Register Expo / APNs / FCM token |
| GET  | `/v1/me/photos` / POST / DELETE | Photo CRUD with face-match gate |
| GET  | `/v1/me/verification` | Read current verification state |
| GET  | `/v1/me/verification/url` | Mint Persona hosted-flow URL |
| GET  | `/v1/onboarding/interview` | Resume server-owned conversational onboarding |
| POST | `/v1/onboarding/interview/answer` | Send text to the shared onboarding collector |
| POST | `/v1/onboarding/interview/voice` | Transcribe voice and send it to the same collector |
| POST | `/v1/onboarding/consent` | Record ToS + research-opt-in |
| POST | `/v1/assistant/ask` | Lightweight one-shot helper |
| POST | `/v1/assistant/voice` | Transcribe voice and send the turn to the post-onboarding assistant |
| POST | `/v1/chat/upload` | Upload Aether chat image to private storage |
| POST | `/v1/chat/message` | Aether concierge turn (text + image) |
| GET  | `/v1/chat/history` | Aether chat history |
| GET  | `/v1/matches/current` | Current active match (with serializer gates) |
| POST | `/v1/matches/:id/decision` | Accept / decline (mirrors bot decision handler) |
| POST | `/v1/matches/:id/vibe-location` | Submit concierge vibe + location pin |
| POST | `/v1/matches/:id/safety-ack` | Acknowledge T-1.5 h safety brief |
| POST | `/v1/matches/:id/report` | File post-match report (LLM-triaged) |
| GET  | `/v1/matches/:id/ticket/state` | Date Ticket Mini App screen state (status/price/gender/partner-paid/expiry, plus `selfDiscountPct`/`selfPriceCents` for the famine single-ticket discount on the `self` scope). **Telegram `initData` HMAC auth** (not JWT) — mounted before the JWT `matches` router. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.5b. |
| POST | `/v1/matches/:id/ticket/intent` | Create a (mock) payment intent for a ticket purchase (`scope: self\|both\|partner`; `both`/`partner` male-only). `initData` HMAC auth. |
| POST | `/v1/matches/:id/ticket/confirm` | Confirm "payment" → mark paid (atomic/idempotent); unlocks scheduling when both paid. `initData` HMAC auth. |
| POST | `/v1/matches/:id/ticket/use` | Spend ticket(s) from `User.ticketBalance` to settle the gate (`scope: self\|both\|partner`) instead of paying — atomic, guarded; 409 on insufficient balance. `initData` HMAC auth. See [PRODUCT_SPEC.md](PRODUCT_SPEC.md) §3.5b. |
| GET  | `/v1/tickets/wallet` | Ticket store Mini App — current balance + per-ticket price + active famine discount (`discountPct`/`discountExpiresAt`, applies to the "1 ticket" bundle). `initData` HMAC auth; feature-flagged (`TICKET_FEATURE_ENABLED`, else 404). |
| POST | `/v1/tickets/store/intent` | Create a (mock) bundle payment intent (`count: 1\|3\|6`). `initData` HMAC auth. |
| POST | `/v1/tickets/store/confirm` | Confirm bundle "payment" → credit `ticketBalance` (+`TicketLedger`). `initData` HMAC auth. |
| GET  | `/v1/countdown` | Status banner / next-batch countdown |
| GET  | `/v1/calendar/state` | Calendar Mini App snapshot — slot allowlist, both sides' picks, agreed time (Telegram `initData` HMAC auth; polled by the Mini App for live peer visibility) |
| POST | `/v1/calendar/pick` | Calendar Mini App availability submission — accepts `pickedIsos: string[]` (legacy single `pickedIso` still tolerated). Response carries `agreedTime` (set on single-overlap auto-lock), `overlapCandidates: string[]` (set when intersection > 1, Mini App shows confirm card), `mySlots`, `peerSlots`, `bothPicked`. Telegram `initData` HMAC auth. |
| GET  | `/v1/location/search` | Location Mini App autocomplete — proxies to Google Places (New) `searchText` so the API key stays server-side. `q` query is debounced client-side at 350ms; min length 2 chars. Optional `lat`/`lng` for location-bias. Telegram `initData` HMAC auth. |
| POST | `/v1/location/select` | Location Mini App submission — body `{matchId, lat, lng, address?}`. Validates side + `negotiating_venue` state, writes `vibeLat/Lng/Address{A,B}`, then fires `tryFinalize` (fire-and-forget). Telegram `initData` HMAC auth. |
| POST | `/v1/feedback/post-date` | Post-date Feedback Mini App submission (Telegram `initData` HMAC auth) |
| GET  | `/v1/venue-change/state` | Venue Change Mini App bootstrap — eligibility (female-only, one-shot, T-5h cutoff), original venue, current sub-state. Telegram `initData` HMAC auth. |
| GET  | `/v1/venue-change/catalog` | Venue Change alternatives within 3 km of the original venue (curated-first, Places fallback). Each item also carries detail-page display fields — `photoUrl` (curated), `photoRefs` (Places photo resource names), `rating`/`userRatingCount`/`editorialSummary`. Gated on the same female eligibility. Telegram `initData` HMAC auth. |
| GET  | `/v1/venue-change/photo` | Detail-page image proxy — streams a Google Places photo for `ref=<places/.../photos/...>` (validated shape) so `PLACES_API_KEY` stays server-side. `<img>` can't send headers, so initData rides the `tma` query param (HMAC-verified, same as the header path). 404 when no `PLACES_API_KEY`. |
| POST | `/v1/venue-change/propose` | Venue Change submission — body `{matchId, placeId?, name, address, lat, lng, mapsUri?, comment}`. Re-validates eligibility + comment ≥10 + within-radius, writes the `proposed` sub-state, DMs the male. Telegram `initData` HMAC auth. |
| GET  | `/v1/verification/mini-app/init` | Verification Mini App SDK config — returns `{referenceId, templateId, environmentId, language, environment}` for the Persona Embedded SDK and flips `verificationStatus` to `pending`. 503 if Persona feature flag/ids missing, 409 if already verified. Telegram `initData` HMAC auth. |
| POST | `/v1/verification/mini-app/event` | Verification Mini App terminal SDK callback — body `{kind: "complete"\|"cancel"\|"error", inquiryId?, status?, message?}`. `complete` writes `personaInquiryId` (CAS on null) and triggers `pullVerificationStatus` fire-and-forget; `cancel`/`error` are logged only. Does NOT write `verified`/`rejected` — the HMAC webhook is the only path that can. Telegram `initData` HMAC auth. |
| POST | `/v1/webhooks/persona` | Persona inquiry webhook (HMAC of raw body, mounted **before** `express.json`) |

## Admin `/admin/*` API Surface

Mounted by `apps/bot/src/admin/server.ts`. Bearer-auth via `ADMIN_API_KEY`
(timing-safe compare); IP rate-limited; `helmet` on. Used by the
internal analytics dashboard.

Top-level routers: `audience`, `algorithm`, `gender`, `retention`, `dates`,
`verification` (incl. a "rerun face-match pipeline" admin button).

Conversation viewer (inline routes in `server.ts`, behind the global
`requireApiKey` gate):

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/users/:id/conversation` | Normalized, chronological transcript for one user, merging BOTH conversation stores — `User.messageHistory` (Telegram onboarding/menu agents, array order, no timestamps/images) then `Message` rows (Aether mobile concierge, real `createdAt` + `imageUrl`). `system`/`tool`/null-content turns are flagged `technical`; `tool_calls` are surfaced; `Profile.photos[]` ride along as a separate `photos[]` gallery (not interleaved). Image fields are refs streamed via `/admin/media`. Stringifies BigInt; 404 unknown user. |
| GET | `/admin/media` | Authenticated image proxy that streams private/Telegram image bytes (`type ∈ {telegram, photo, chat}` → `downloadTelegramFile` / `downloadProfileImage` / `downloadChatImage` from `services/storage.ts`). The Bearer key is never accepted via query string; the dashboard fetches with the header and converts to a blob URL. Supabase `ref` shape is validated against path traversal; `503` when `botApi` is null and Telegram is needed; `404` (never 500) on a missing/expired image. Exempted from the global 60/min `adminLimiter` and given its own higher-ceiling `mediaLimiter` so a gallery doesn't exhaust the admin budget. |

## Rate Limiting & Token Budget

Two surfaces, one in-memory mechanism (`services/usage-limiter.ts`; single PM2
process, so plain in-memory sliding windows — a restart only resets counters):

- **Public `/v1/*` API** — `express-rate-limit` per-IP/per-user *request* caps
  (`public/rate-limit.ts`), plus `public/usage-middleware.ts` (`usageGuard`)
  mounted after `requireAuth` on the JWT LLM routers (`/v1/chat`,
  `/v1/assistant`, `/v1/onboarding`) for the per-user daily *token* budget
  (`429` over budget).
- **Telegram bot** — `bot-rate-limit.ts`, registered after `sessionMiddleware`
  in `bot.ts`. Meters only text/voice messages (inline-button callbacks are
  never throttled); a scripted flood or an over-budget user is dropped **before**
  any handler runs, so it protects both OpenAI spend and the
  `messageHistory`/`Message` write path.

Token accounting is attribution-by-context: entry points wrap downstream
handling in `runWithUsage(key, …)` (`services/usage-context.ts`,
`AsyncLocalStorage`; keys `tg:<id>` / `user:<id>`), and the `openaiFetch`
wrapper (`services/openai-fetch.ts`) — a `fetch` drop-in at the scattered OpenAI
call sites — reads the exact `usage.total_tokens` OpenAI returns and charges it
to the ambient key plus a process-wide hourly breaker. Whisper audio is priced
by duration (not tokens), so it stays under the per-request voice limiter only.
All knobs are env-flagged (see deploy.md), ship on with loose thresholds tuned
so normal fast use never trips them, and add no Prisma schema or dependency.

## Storage Buckets (Supabase)

- `SUPABASE_SELFIE_BUCKET` — Persona-captured selfie used as the face-match
  reference. Auto-deleted by `selfie-retention` 90 d after `verifiedAt`.
- `SUPABASE_PHOTO_BUCKET` — mobile-uploaded profile photos. Telegram-uploaded
  profile photos remain Telegram `file_id`s.
- `SUPABASE_CHAT_BUCKET` — Aether chat images, stored as opaque object paths
  (`{userId}/{ts}.jpg`); rendered via short-lived signed URLs from
  `services/storage.ts`.

Telegram-uploaded profile photos are **not** stored in Supabase by the bot
— their static frames live as Telegram `file_id`s in `Profile.photos`.
Richer Telegram display media lives additively in `Profile.profileMedia[]`:
`{ type: "photo", photo }`, `{ type: "live_photo", photo, livePhoto, ...metadata }`,
or `{ type: "video", video, ...metadata }`. Static media admission stores
`uploadedPhotoHashes` for duplicate detection and `acceptedPhotoCount`.
For unverified users without a confirmed anchor, photos that pass per-photo
safety/face/duplicate gates are stored only in hidden
`Profile.pendingPhotoCandidates[]`; they are not rendered, not counted toward
`MIN_PHOTOS`, and not used by verification/matching. Each new candidate is
compared pairwise against the pending pool with Rekognition `CompareFaces`.
When a connected cluster reaches 2+ distinct photos, the largest cluster wins
(equal size tie-breaks by earliest upload), `referenceFaceEmbedding` is written
from the earliest photo in that cluster, cluster photos move into `photos[]` /
`profileMedia[]` / `photoFaceScores[]`, and pending outliers are rejected. Once
`referenceFaceEmbedding` exists, subsequent photos must contain any face
matching that anchor; group photos are allowed when the owner is present.
Verified users bypass consensus and compare against `verifiedSelfiePath`.
This schema is additive (`pending_photo_candidates`) and requires the standard
Prisma `db:push` deploy step before code that selects the column starts.
Video remains display-only and is excluded from `photos[]`, but admission is
validated before persistence:
`ffprobe`/`ffmpeg` extract 12 temporary samples, AWS Rekognition performs face
detection/comparison and image moderation, and OpenAI independently moderates
sampled frames plus the Whisper transcript. Only validation version and
timestamp are retained; temporary video, frames, audio, and transcripts are
deleted. The `photos[i] ↔ photoFaceScores[i]` invariant still holds. When
`profileMedia[]` is empty, renderers normalize legacy `photos[]` into photo
items. Verification and face-match still read `photos[]` only, preserving the
`photos[i] ↔ photoFaceScores[i]` invariant. The mobile app mirrors static
photos through `/v1/me/photos`, which downloads from Telegram (or accepts
direct upload) and runs the face-match gate; Telegram Live Photo upload is
currently bot-side only.

## External Dependencies

| Service | Role |
|---|---|
| OpenAI | Onboarding / menu / Aether agents, embeddings, Whisper voice/video-audio transcription, image/text moderation, vision Elo seed |
| Persona | Hosted KYC / liveness flow; HMAC-signed terminal inquiry webhooks |
| AWS Rekognition | `CompareFaces`, `DetectFaces`, and `DetectModerationLabels` for profile photo/video admission and Persona verification; `DetectFaces` boxes also drive the date-card share-copy face blur (§3.7a) |
| Google Places (New) v1 | **Fallback** concierge venue search (primary is the first-party `curated_venues` base) at the great-circle midpoint via `places.googleapis.com/v1/places:searchNearby` (+ text fallback). Strict quality gate (operational + place-type deny-list + rating ≥ 4.0 + ≥ 30 reviews + student-friendly price tier for food) and weighted scoring on top of the raw API. Also used by `scripts/seed-venues.mjs` (via `searchVenueCandidates`) to source curated-base candidates under the same gate. The `places.photos` field + the Places **media** endpoint supply the date-card venue cover photo (fetched at render time, credited on the card, never persisted). |
| satori + @resvg/resvg-js + @napi-rs/canvas | In-process date-card PNG rendering (§3.7a, feature-flagged): `satori` builds an SVG from a plain element tree, `@resvg/resvg-js` rasterizes it to PNG, and `@napi-rs/canvas` pixelates the partner's face for the share copy plus applies the venue-photo duotone and the film-grain tile. Pure Node (no headless browser); bundled Roboto + Archivo Black TTFs live in `apps/bot/src/assets/fonts/`. |
| Supabase | Postgres + pgvector primary store, Storage for selfies, mobile profile photos, and chat images |
| Resend/email provider | Corporate-email OTP delivery |
| Expo / APNs / FCM | Mobile push notifications |
