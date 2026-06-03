# Gennety Dating — Product Specification

> **Version:** 2.1 (rewritten 2026-05-04 to reflect the actual code; clarified
> 2026-05-06 as product-invariants documentation; the
> 1.x linear-FSM onboarding and visual-screening sections are obsolete.)
> Tech stack and coding rules are in [AGENTS.md](AGENTS.md).
> Database schema and system architecture are in [ARCHITECTURE.md](ARCHITECTURE.md).
> This file documents product invariants and major flows, not every
> implementation detail. Code, tests, and Prisma remain the source of truth for
> local mechanics.

## Project Overview

Gennety Dating is an AI-first romantic matchmaking service targeting university
students. It diverges from traditional dating apps by relying on deep context
extracted from each user's personal LLM (ChatGPT, Claude, etc.) and completely
eliminating user-to-user text communication before the first date. The system
acts as the matchmaker: it finds the match, pitches it, and negotiates the
logistics until both users meet in person.

The product surface is Telegram-first: `@gennetybot`, the Calendar Mini App,
and a shared `/v1/*` HTTP API for the Expo/mobile client. This repo contains
the backend, Mini App, public API, and `mobile-handoff/` components; a full
`apps/mobile` workspace is not present here yet. Both Telegram and mobile users
share the same Postgres backend (`User.platform ∈ {telegram, mobile, both}`).
Mobile-only users carry a synthetic **negative** `telegramId` and are filtered
out of Telegram-only workers.

## Core Principles (Strict Rules)

- **Hyper-Local Student Focus (Corporate Email)** — Users MUST register and
  verify a valid university email domain (whitelist in `ALLOWED_EMAIL_DOMAINS`,
  e.g. `.edu`, `.ac.uk`).
- **NO IN-APP CHAT** — Users NEVER message each other through our platform. Do
  not build chat interfaces between users. The only chats are user↔bot,
  user↔Aether concierge (mobile), and the structured pitch / scheduling /
  emergency flows.
- **Deep Context over Questionnaires** — During onboarding the user pastes the
  *Magic Prompt* into their personal LLM and returns the long psychological
  analysis, which we parse into structured profile + embedding.
- **Identity-Verified by Default** — Liveness (Persona) + photo↔selfie
  face-match (AWS Rekognition) gate full match eligibility. Skipping is
  allowed but carries a real Elo penalty.
- **Progressive Logistics** — The AI auto-proposes timeslots first; if both
  rounds fail it hands off to the Calendar Mini App; venue is chosen by an
  AI concierge from each user's free-text *vibe* + commute pin.
- **Native Telegram AI Experience** — Heavy use of Bot API 9.x:
  `sendMessageDraft` (streamed pitches), `icon_custom_emoji_id` (menu and
  match-decision affordances), `message_effect_id` (match confirmations),
  `date_time` MessageEntity (timezone-aware date confirmation), pinned status
  banner (live discrete countdown).
- **Blind Decision Invariant** — A user must never learn their partner's
  Accept/Decline before committing to their own.

## Phase 1 — Onboarding

> The legacy "strict linear FSM" sequence is **gone**. Onboarding is driven by
> a tool-calling LLM agent (`apps/bot/src/services/onboarding-agent.ts` for
> Telegram, `/v1/onboarding/interview*` for mobile). The agent harvests fields
> in any order, never re-asks something already volunteered, and validates
> answer quality before advancing.

### 1.1 Initialization & Consent (`onboardingStep = consent`)

- `/start` (or first mobile launch) creates a `User` row, captures any deep
  link as `referralSource` (`tg:<start_param>` / `mobile:utm=…` /
  `referral:<USER_ID>`), and shows the consent + ToS card.
- Telegram `/start` now opens a full-screen Onboarding Mini App before the
  conversational agent takes over. The Mini App presents the visual intro,
  legal consent, language, and corporate-email OTP gate, using Telegram
  `initData` HMAC auth for all writes. If the user arrived through a verified
  website handoff (`auth_<token>`; legacy `web_<token>` still accepted), the
  server-side `isEmailVerified` state skips the Email/OTP screens.
- When the Mini App reaches its handoff step, it calls
  `/v1/telegram-onboarding/complete` with the visual-flow token issued by
  `/v1/telegram-onboarding/state`; the bot immediately resumes the chat through
  the existing onboarding agent. This does **not** mark onboarding complete by
  itself — Magic Prompt context, required profile fields, photos, and
  verification CTA still follow the normal product rules.
- The user MUST flip `termsAccepted` (legal click) and MAY opt into
  `researchOptIn` (analytics use of anonymised data, default false per GDPR
  norms).

### 1.2 Language (`onboardingStep = language`)

- Three options: `English`, `Русский`, `Українська` → persists `User.language`
  and `BotSession.language`.
- The conversational agent matches the user's language thereafter and is
  forbidden from injecting English enum words ("male/female/men/women") into
  non-English replies.

### 1.3 Conversational profile capture (`onboardingStep = conversational`)

The agent calls tools in any order until *all* required data is collected:

| Tool | Effect |
|---|---|
| `send_otp_email(email)` | Validate domain, mint OTP, send via email provider |
| `verify_otp(code)` | Check the 6-digit code, flip `isEmailVerified` |
| `resend_otp()` | Re-send to the email already on file |
| `request_context_dump()` | Surface the *Magic Prompt* in a copy-block |
| `save_context_dump(raw_dump)` | Stream-parse to `psychologicalSummary` and seed embedding |
| `request_photos()` | Open photo upload (must follow `save_context_dump`) |
| `save_profile_data(...)` | Persist `firstName`, `age`, `gender`, `preference`, `height`, optional `ethnicity`, `hobbies`, `partnerPreferences` |
| `finalize_onboarding()` | Activate the user (or hand off to verification CTA) |

Before the Telegram Mini App hands off to the conversational bot, the user
must also choose a **dating city** (`Profile.homeCityKey`). This is framed as
"where you want to receive matches", not as a home address. Users can search
for a city manually or let the Mini App resolve their browser geolocation to a
city; raw coordinates alone do not satisfy the matching gate.

Hard rules baked into the agent prompt:
- Required fields (`firstName`, `age`, `gender`, `preference`,
  `partnerPreferences`) are NEVER skipped — keep asking until concrete.
- "No hobbies" / a single hobby is a valid answer; the agent must NOT chain
  "one more, one more" requests.
- `MIN_PHOTOS` is a hard floor; anything beyond is purely optional.
- Profile media may be a mix of static photos and Telegram Live Photos.
  A Live Photo counts as one profile media item toward `MIN_PHOTOS` /
  `MAX_PHOTOS`, but its static frame is still stored in `Profile.photos[]`
  and must pass the same single-face and face-match checks as a normal
  profile photo. Live Photos without a static frame are rejected.
- `request_photos` MAY NOT be called in the same turn as
  `request_context_dump` — wait for the dump to land first.
- During the LLM dump *parsing* the bot streams an "internal monologue"
  via `sendMessageDraft` ("Analyzing your profile… Synthesising
  psychological traits…") to keep the user oriented.

### 1.4 Identity verification (Phase 6.3 in code)

After `finalize_onboarding` the bot sends the **verification CTA**
(`handlers/onboarding/verification.ts`):

- **Verify now** — opens the **Verification Mini App**
  (`apps/webapp/verification.html`) via `InlineKeyboardButton.web_app`,
  so Persona's KYC flow runs inline inside the native Telegram WebView
  (no redirect to `withpersona.com`, no in-app browser frame). The Mini
  App mounts Persona Embedded SDK v5 against `/v1/verification/mini-app/init`
  config; terminal SDK events POST to `/v1/verification/mini-app/event`
  which triggers the existing pull-fallback pipeline. `verificationStatus
  → pending` is written on `/init`. When `WEBAPP_URL` isn't a real HTTPS
  host (dev without a tunnel) the bot silently falls back to the legacy
  `InlineKeyboardButton.url` opening the hosted flow at
  `buildPersonaHostedUrl(userId)`. Mobile (Expo) still uses the hosted
  URL via `/v1/me/verification/url` — it isn't a Telegram client.
- **Skip for now** — flips `verificationSkippedAt`, drops
  `Profile.eloScore` by `UNVERIFIED_ELO_PENALTY` (= 150 from a 500 default),
  and activates the user as `unverified`. Reversible by later running Persona.

When Persona sends a trusted terminal webhook that maps to passed liveness
(`inquiry.approved` or the configured terminal equivalent), the verification
pipeline (`services/verification-pipeline.ts`) runs. The manual pull fallback
is stricter and runs the pipeline only once Persona's REST status is
`approved`; `completed` without approval is treated as still processing.

1. Pull the captured selfie via Persona's API; upload to
   `SUPABASE_SELFIE_BUCKET` as `verifiedSelfiePath`.
2. AWS Rekognition `CompareFaces` against every profile photo; record each
   score in `Profile.photoFaceScores` (1:1 with `photos[]`). Each photo is
   bucketed as **pass** (≥ `FACE_MATCH_THRESHOLD_VERIFY`), **borderline**
   (∈ `[FACE_MATCH_THRESHOLD_REVIEW, FACE_MATCH_THRESHOLD_VERIFY)`),
   **fail** (face detected but score below `FACE_MATCH_THRESHOLD_REVIEW`),
   or **no_face** (`faceFound=false`: group photo, scenery, etc.).
3. Decide using the **quorum rule** over detected-face photos. The
   no_face bucket is excluded from the decision (group photos aren't
   informative either way; their 0 score is still persisted so admins
   can spot the offending photo):
   - `verified` — pass count ≥ `FACE_MATCH_MIN_VERIFIED_PHOTOS` (default 1)
     AND zero `fail` photos. Auto-activate if still onboarding; seed
     `eloScore` via the cold-start AI vision pass.
   - `rejected` — at least one `fail` photo (a real, detected face that
     doesn't match the verified selfie — likely impostor / wrong-person).
     A pass quorum cannot rescue an impostor: any `fail` is a hard reject.
   - `pending_review` — anything else: all-borderline, mixed pass +
     borderline under quorum, or zero detected-face photos
     (`no_detected_faces` reason).
4. Any *infrastructure* failure (Persona / Rekognition / storage) routes the
   user to `pending_review`, never `rejected` — we don't penalise users for
   our outages.
5. `selfie-retention` cron deletes `verifiedSelfiePath` 90 days after
   `verifiedAt` (GDPR Article 9). The user stays `verified`; only the
   reference image is scrubbed. Re-verifications re-fetch from Persona.

For Telegram Live Photos, verification always uses the static photo frame
stored in `Profile.photos[]`; the short video part is display-only for
profile and match cards.

The same pipeline runs again on every photo edit. The bot/mobile photo
handlers fire `triggerVerificationRerun` after every add/delete/replace,
which clears the `(personaInquiryId, faceMatchedAt)` idempotency marker,
flips `verificationStatus` back to `pending`, and re-launches the
pipeline against the new photo array. Persistence of `photoFaceScores`
is gated on the photo array still matching the snapshot taken at
pipeline start — if the user edits photos again mid-run the stale scores
are discarded rather than corrupting the `photos[i] ↔ photoFaceScores[i]`
alignment. The admin "rerun verification" endpoint shares the same code
path.

**Match-pool exclusion.** Users with `verificationStatus IN ('rejected',
'pending_review')` are excluded from the weekly batch matching pool
regardless of `User.status` — the photo-edit auto-rerun handles
rehabilitation, while admin moderation (for pending_review) handles
borderline cases. `unverified` (Persona skipped) and `pending` (Persona
inquiry mid-flight) DO match: the former carries the documented
`UNVERIFIED_ELO_PENALTY` and the latter is a brief transient state.

### 1.5 Re-engagement chain

Drop-off during onboarding triggers a 5-step retention loop
(`workers/re-engagement.ts`). Steps fire at +15 min, +2 h, day-of 19:00,
day-of+1 19:00, day-of+2 14:00 (Kyiv). Quiet hours **23:00–09:00 Kyiv** are
deferred to the next 13:00. Any user activity (consent click, language pick,
agent reply, photo upload) resets the chain to step 0; finishing onboarding
nulls `reEngagementNextAt` permanently.

## Phase 2 — Main Menu & Persistent Surface

### 2.1 Telegram bot menu (`handlers/menu/main.ts`)

The persistent inline menu uses a `custom_emoji` entity for the 🎓 title icon
when `CUSTOM_EMOJI_MENU_ID` is set. **Bot API limitation:** inline keyboard
button labels CANNOT carry `custom_emoji` entities — buttons fall back to
plain Unicode emoji.

- **My Profile** — generated bio + photos.
- **Edit Profile** — non-identity fields only. `firstName`, `age`,
  `email`, `universityDomain` are **fixed** post-onboarding.
- **Pause Matching** — flips `User.status = paused`. The match engine ignores
  paused users; the status banner shows "paused".
- **Settings** — change `language`.
- **Report / Help** — opens the support handle.

A pinned **status banner** is created on activation
(`services/status-banner.ts`) and live-edited every minute by the
`status-timer` worker. It shows a discrete countdown to the next batch
("Xd Yh", "Xh Ym", "Xm"), de-duplicated in-memory so unchanged text never
hits the Bot API.

### 2.2 Mobile API / Expo handoff

The public `/v1/*` API is the integration surface for the Expo/mobile client
(Bearer JWT, refresh-token rotation). This repo currently ships API support
and handoff components rather than a full mobile workspace. Supported
first-class flows:

- Onboarding / consent / OTP / Persona via `/v1/onboarding/*`,
  `/v1/auth/*`, `/v1/me/verification/*`.
- **Aether Concierge** (`/v1/chat/*`) — multimodal AI chat that gathers
  profile facts in the background via `update_profile` / `attach_profile_photo`
  tools. Distinct from the legacy onboarding-agent: persists each turn as a
  `Message` row and supports image attachments.
- Match decision, vibe-location, safety-ack, report endpoints under
  `/v1/matches/:id/*`.
- `/v1/me/push-token` registers Expo/APNs/FCM tokens; the bot dispatches
  push via `services/push.ts` for the same events that DM Telegram users.
- `/v1/me/home-location` persists canonical dating city + coordinates for
  match eligibility; `/v1/me/location` remains raw coordinate storage for
  Meet-Halfway and does not by itself unlock matching.
- `/v1/me/preferences` (`matchRadius` ∈ `campus_only` / `citywide`) stores
  the user's future radius preference.

## Phase 3 — Matching Engine & Progressive Scheduling

### 3.1 Cadence

- **Pre-match teaser** — Wednesday 18:00 Europe/Kyiv (`PRE_MATCH_ANNOUNCE_CRON_SCHEDULE = "0 18 * * 3"`).
  A warm "your match is coming tomorrow" DM goes to active users who
  haven't been announced for the current cycle.
- **Weekly batch** — Thursday 18:00 Europe/Kyiv (`MATCH_CRON_SCHEDULE = "0 18 * * 4"`).
- **No-match notice** — Thursday 18:15 Kyiv (`NO_MATCH_NOTICE_CRON_SCHEDULE = "15 18 * * 4"`).
  An empathetic DM goes to every eligible-but-unpaired user. Tier escalates
  with consecutive famine count (1 / 2 / 3+); idempotent via
  `NoMatchNotice@@unique([userId, dropDate])`.

### 3.2 Scoring (`services/match-engine.ts`)

Hybrid SQL + Node.js re-rank.

```
MatchScore = ((w₁·V_explicit) + (w₂·V_research)) · V_league − (w₃·V_penalty)
                                                + starvationBonus
```

- `V_explicit` (cosine similarity of the 1536-dim profile embedding), weight 0.80.
- `V_research` (sociological heuristics: age, height, social energy, etc.), weight 0.20.
- `V_league` — universal Elo-distance multiplier; same league = 1.0,
  decays linearly past `LEAGUE_TOLERANCE = 150`, floors at `LEAGUE_FLOOR = 0.1`.
- `V_penalty` — negative-constraint penalty (subtracted), weight 0.30.
- `starvationBonus` — α=0.05 per missed weekly batch, capped at 0.25 (strictly
  below `V_penalty` so it never overrides a real negative-constraint hit).

Hard SQL filters (`buildCandidateSql`):
1. `status = 'active'` and `onboardingStep = 'completed'`.
2. Embedding present, `gender` and `preference` set.
3. Mutual gender compatibility (a's preference includes b's gender AND vice versa).
4. Verified corporate/university email domain present.
5. Same canonical dating city (`Profile.homeCityKey`) and saved city
   coordinates. Different university domains can match inside the same city.
6. **Lifetime ban** — exclude any pair that EVER appeared in a `matches` row,
   regardless of terminal status. Backed by the canonical-pair functional
   index. A user never sees the same partner twice.
7. Cooldown — `Profile.lastMatchedAt < now − MATCH_COOLDOWN_MS (24 h)`.

Score breakdown for every created pair is frozen into `match_score_logs`
for the dashboard's algorithm-quality view.

### 3.3 The Pitch & Synergy

- The orchestrator generates a personalised pitch + **Synergy Score**
  (clamped to a motivating 70..99 range) + a 1–2 sentence positive
  rationale, in side-A's language.
- Pitches are queued through `services/dispatch-queue.ts` (rate-limited,
  default 2 s between sends ≈ 30/min).
- For Telegram users the pitch streams via `sendMessageDraft`; the
  `pitchMessageId{A,B}` is captured.
- An explicit `matchDeadlineNotice` follows the headline: **24 h** to reply,
  decision is final once tapped.
- Buttons: `[Accept]` / `[Decline]`.
- The `proposal-countdown` worker live-edits a "⏳ Xh left" plate every
  5 min — hourly during the first 23 h, then per-5-min during the final hour.

### 3.4 Blind Decision Invariant + Peer Nudge

A user MUST NOT learn what their partner picked until they themselves have
committed.

- **First commit** — row stays `proposed` (even on a single decline). The
  peer's keyboard is still live until both have decided or 24 h elapses.
  Peer receives a neutral nudge `matchPeerDecided` ("your match has answered,
  your turn") that is **identical** for accept and decline.
- **Mutual accept** — atomic `proposed → negotiating`; both sides get
  `matchBothAccepted` with symmetric reveal.
- **Mixed / both declined** — second decider gets their own
  `matchAccepted`/`matchDeclined` ack PLUS a follow-up
  `matchPeerWasAccepted`/`matchPeerWasDeclined` reveal; the first decider
  (who only saw their ack earlier) is also DM'd the outcome at this moment.
  Status flips to `cancelled`. In the mixed case, the user who accepted but
  whose peer declined receives a softer, accepted-side-specific reveal and
  gets a compensating priority boost for the next weekly batch.
- **TTL expiry asymmetry** — if the silent side ghosted a partner who had
  *accepted*, the expiry message includes `matchExpiredYouMissedDate` ("you
  missed a real date") on top of the standard rating warning. If the
  partner declined or also ghosted, the message stays neutral — preserving
  the blind rule even at expiry. Match flips to `expired`.
- **Forgive-once on silence** — first `silentIgnoreCount` increment is a
  warning only; from the second onwards Elo decrements as if the user had
  declined, and a `EXPIRED_SILENT` `MatchEvent` is logged.

After a decline (and once the user has seen the partner's verdict, if any),
the bot prompts for a free-text reason; the LLM distils it and appends the
result to the *decliner's* `Profile.negativeConstraints`.

### 3.5 Match nudges

`workers/match-nudge.ts` sends two cadence pairs (`MATCH_NUDGE_CRON_SCHEDULE = "0 * * * *"`),
both honouring quiet hours:

- **Proposal phase** (status `proposed`, awaiting decision) — ≥3 h after
  `dispatchedAt`, then ≥10 h.
- **Scheduling phase** (status `negotiating`, both accepted, no agreed slot)
  — ≥6 h since last update, then ≥12 h.

Each cadence has its own pair of timestamp columns
(`proposalNudge1/2SentAt`, `schedNudge1/2SentAt`) so a row that already got
a proposal nudge cannot dead-letter the scheduling-phase cadence.

### 3.6 Calendar Scheduling

After mutual accept the bot DMs both users a button that opens the
**Calendar Mini App** (`apps/webapp`, Vite + Telegram Web Apps SDK). The
legacy three-iteration flow (two rounds of "pick one of three slots"
inline keyboards before falling back to the calendar) was removed
2026-05-07 — landing straight on a peer-aware calendar is strictly
better UX than three separate retries.

- **Server-side slot grid.** When the match enters `negotiating` the
  bot writes **6 consecutive dates** (next 6 days starting tomorrow)
  with **5 time slots per date** into `Match.proposedTimes`: 17:30,
  18:00, 18:30, 19:00, 19:30 local. Both users see the same exact
  DateTime allowlist; the public API rejects any submission whose ISO
  isn't on it. Pre-2026-05-10 the grid was 12 slots with Sun/Mon
  pre-skipped; pre-2026-05-11 it was 6 dates at only 18:00. The current
  shape keeps the first choice compact while avoiding a single fixed
  dinner time.
- **Multi-pick with live peer visibility.** Each user marks any subset
  of slots as "I'm free" — stored in `Match.availableTimesA` /
  `availableTimesB`. The Mini App polls `GET /v1/calendar/state` every
  ~4 s while open, so each side sees the partner's marks land in
  near-real-time.
- **Four visual states.** The grid renders each slot as **empty** /
  **mine** / **peer-only** / **overlap**. When the partner has marked
  slots and the current user hasn't, a banner reads *"Tap one to
  instantly agree, or pick your own — they'll see it live."* Tapping a
  peer-only slot and saving locks in the date in a single round-trip.
- **Initiator-offers / responder-decides.** The intersection of
  `availableTimesA` and `availableTimesB` after each update routes one
  of three ways:
  - **0 overlaps** — nothing locks. Bot DMs (see below).
  - **1 overlap** — auto-lock to that slot, write `Match.agreedTime`,
    and run `startVenueNegotiation` (the "instant agree" fast path).
  - **>1 overlaps** — do NOT auto-lock. Server returns
    `overlapCandidates: string[]` and the Mini App shows a confirm
    card to the actor; tapping a slot re-POSTs that single iso, which
    collapses the intersection to size 1 and hits the lock path. The
    asymmetry "initiator offers, responder decides" is deliberate UX —
    earliest-wins would silently steal user agency.
- **First-mover DMs.** When the actor's first non-empty submission
  finds zero overlap and the peer hasn't picked yet, the bot fires two
  DMs: peer gets `matchSchedulePeerProposed` with the calendar button;
  actor gets `matchScheduleSavedConfirmation` so the chat shows a
  confirmation receipt the moment they close the Mini App.
- **No-overlap-yet ping.** When both sides have submitted but no slot
  is shared, the bot DMs both with `matchScheduleNoOverlapYet`. Gated
  on the actor's set actually changing — re-saving the same set is a
  no-op so toggling-and-saving doesn't spam the peer. Subsequent edits
  also rely on the existing `match-nudge` cron (proposal-phase nudges
  at ≥3 h / ≥10 h since dispatch).
- **Mini App view states.** The default picker is a two-step flow:
  `dates` first, then `times` for the selected date. After Save, the
  Mini App shows one of:
  - `agreed` — locked-in success card (only state where the peer also
    sees the lock via polling).
  - `multi-overlap` — radio-list confirm card listing the candidates;
    Confirm uses the Telegram MainButton.
  - `waiting` — first-mover success card with peer-still-empty copy;
    `Close` and `Change my picks` buttons.
  - `grid` — default editing view with the 4-state slot rendering.
- **Auth.** The Mini App is opened via `InlineKeyboardButton.web_app`
  in production, where `Telegram.WebApp.sendData` is silently a no-op.
  Both `GET /v1/calendar/state` and `POST /v1/calendar/pick` therefore
  authenticate via `Authorization: tma <initData>` (HMAC verified
  against `BOT_TOKEN`).
- **Backwards-compat.** `Match.schedulingIteration` and
  `pickedTimeA/B` are retained as deprecated columns until a follow-up
  cleanup migration drops them; mid-deploy taps on legacy
  `sched:pick:*` callbacks are caught by a graceful fallback that
  re-delivers the calendar button instead of failing silently.

### 3.7 Concierge Venue Negotiation (`negotiating_venue`)

Once `agreedTime` is locked, both users are asked for two things:

1. A free-text **vibe** ("cafe / quiet / vegan / park walk / ..."), which
   `services/vibe-parser.ts` normalises to a strict whitelist
   (`cafe | restaurant | coffee_shop | park | museum | lounge`). Anything
   outside the whitelist is overridden and audited in `parsedCategoryA/B`.
2. A **commute origin** — captured via the Location Mini App
   (`apps/webapp/location.html`). The legacy `request_location` reply
   keyboard was retired 2026-05-10 — it doesn't work on Telegram Desktop
   (no GPS) and only supports the user's *current* GPS, not "the metro
   I'll leave from" or "my friend's place tonight". The Mini App offers
   four input modes: one-tap browser geolocation, Places-backed
   autocomplete (type "Lukyanivska metro" or "Khreshchatyk 14"),
   tap-on-map, and drag the marker.
   Stored in `vibeLat{A,B}` / `vibeLng{A,B}`; the human-readable label
   from autocomplete is stored in `vibeAddress{A,B}` (display only —
   the matching pipeline runs on lat/lng). Telegram users who share a
   raw location pin via the attach menu still flow through the legacy
   `handleVenueLocation` path; `vibeAddress*` stays null in that case.

**Per-side "what's next" ACK.** Order doesn't matter — handlers are
idempotent — but each save fires a side-aware nudge so a user doesn't
sit there wondering if anything happened:
- vibe done, location not yet → "Vibe noted ✅ Now pick where you'll
  be coming from:" + 🗺️ Pick on map inline button (re-surfacing the
  Mini App entry point in the chat).
- location done, vibe not yet → "Location saved ✅ Now tell me the
  *vibe* — e.g. _quiet cafe_, _park walk_." (text-only, the Mini App
  isn't relevant here).
- both done → `venueWaitingPeer` ("Got yours, waiting on partner…").

The same `sendVenuePostSaveAck` helper drives all three paths
(`handleVenueLocation` / `handleVenueVibe` / `POST /v1/location/select`)
so the wording stays consistent regardless of which surface the user
saved through.

**Curated-first venue selection.** When all four pairs are present, the bot
first consults the hand-curated venue base (`CuratedVenue`, currently scoped by
`universityDomain` when both sides share one) via `services/curated-venue.ts`.
Curated venues are operator-vetted first-date spots, so they are the PRIMARY
source when available; Google Places is the fallback for cross-domain city
matches or when no curated venue is in commute range. Ranking is
**fairness-aware** — it minimises `max(distA, distB)` (the worse of the two
commutes) rather than distance to the geometric midpoint — weighted by a manual
`priority` (1 best … 3 acceptable) and a small bonus when the venue's `vibeTags`
match the merged keywords. A venue whose worse commute exceeds
`CURATED_VENUE_MAX_COMMUTE_KM` (8 km) is discarded. Category selection mirrors
`mergeParsed`: exact merged category → `cafe` default → any. The base is
populated by `scripts/seed-venues.mjs` (Places-backed pull → manual review →
import); it shares the exact production quality gate via `searchVenueCandidates`,
so a curated spot can never be something the live gate would reject.

A curated venue that is **closed at the agreed date/time** (per its stored
Places `openingHours`, evaluated in the venue's local time via
`utcOffsetMinutes`) is skipped at selection — missing hours data is treated as
"open", never as a reason to exclude. The curated base is kept fresh by the
daily **venue re-validation** cron (`services/venue-revalidation.ts`): it
re-checks the oldest-verified active venues against Google Places by stored
`placeId`, deactivates ones that closed or dropped below the rating/review
floor, and refreshes opening hours. An infra failure never deactivates a venue.

When no curated venue qualifies (no rows for the domain, or all out of range),
the bot computes the great-circle midpoint (`services/geo.ts`) and queries the
**Google Places API (New) v1**
`places:searchNearby` endpoint at `places.googleapis.com/v1/...`
(`services/venue.ts`). The legacy `maps.googleapis.com/maps/api/place/nearbysearch/json`
path was retired 2026-05-10 — it returned long-closed places when
`business_status` was `undefined` and offered no native price-level
filter, both root-cause issues for the "place doesn't exist / wrong
price tier" complaints.

Quality gate (strict tier):
- `businessStatus === "OPERATIONAL"` (strict — `undefined` is rejected)
- place type ∉ a hard deny-list (`gas_station`, `lodging`/hotels,
  `supermarket`/`convenience_store`, clinics, banks, gyms, car services,
  etc.) — enforced in BOTH strict and relaxed tiers. `searchNearby` already
  constrains by `includedTypes`, but the tier-3 `searchText` fallback does
  not, so without this a high-rated petrol station with a coffee corner
  used to leak through and get pitched as a date venue.
- `userRatingCount >= 30`
- `rating >= 4.0`
- For `cafe`/`coffee_shop`/`restaurant`/`lounge`:
  `priceLevel ∈ {UNSPECIFIED, FREE, INEXPENSIVE, MODERATE}` — no
  premium spots on a student first date. `park`/`museum` skip the
  price filter (often free or unpublished).

Candidates that pass the gate are ranked by
`rating × log10(userRatingCount + 10) × distanceFactor` (linear
1.0 → 0.5 over the search radius), and the top-1 is picked. This
beats Google's default ordering, which would pick the
closest-but-mediocre place over a slightly-further-but-popular one.

Multi-step fallback so scheduling never wedges:
1. `searchNearby` with strict gates
2. Same response, relaxed price ceiling (allows `EXPENSIVE` for food)
3. `searchText` biased on the midpoint (catches places not in
   `includedTypes` but matching the keyword, e.g. a "gallery cafe")
4. Local stub (last resort)

Persisted columns on success: `venueName`, `venueAddress`, `venueLat`,
`venueLng`, **`venueGoogleMapsUri`** (deep-link to the picked place).
The final `scheduled` DM includes the `googleMapsUri` on a separate
line — Telegram auto-linkifies it so users can tap to verify the
venue exists, check hours, and pre-plan transit. The confirmation also wraps a localized date phrase
(`📅 Sat, 16 May, 19:00`, rendered in `Europe/Kyiv`) in a
**`date_time` MessageEntity** so the whole phrase is a visibly
unmistakable tap target — Telegram does not auto-style `date_time`
entities, so a bare ⏰ glyph reads as a regular emoji on iOS. Tapping
opens the user's local-timezone add-to-calendar sheet via the
entity's `unix_time`.

## Phase 4 — Date Lifecycle

Driven by `services/date-lifecycle.ts` + `services/pre-date-safety.ts`,
`setInterval` every 2 min. All actions are idempotent via timestamp
columns on `matches`.

| When | Action | Idempotency marker |
|---|---|---|
| Activation → `scheduled` | Generate **wingman hints** (one short imperative tip per side about the other) and persist on the row | `wingmanHintA/B` |
| T − 3 h | Send personalised AI **ice-breakers** (3 starters per side, language-aware, fallback to static lists). Mobile gets the same content via `iceBreakersA/B`. | `icebreakersSentAt` |
| T − 3 h | Open the **emergency window** — DM both sides with the cancel button (callback `emerg:start:{matchId}`) | shared with above |
| T − 1 h | **Pre-date safety brief** to the female user (Telegram DM only — mobile gets push). Skipped when no female participant has a Telegram presence. | `safetyNoteSentAt` |
| T − 1 h | **Wingman hint reveal push** — the asymmetric tip is unmasked at this gate (the mobile serializer enforces it independently) | `wingmanSentAt` |
| Date moment | (no automated action — users meet in person) | — |
| T + 24 h | **Feedback prompt** to both sides; LLM parses positives/negatives and updates `negativeConstraints` accordingly | `feedbackPromptedAt` |

### Post-date Feedback UX

The T+24h DM is a structured invitation, not a single 📝 button. It carries
two stacked inline buttons in the user's language and an optional Bot API 7.6
`message_effect_id` (`MESSAGE_EFFECT_FEEDBACK_ID`) so the moment reads as
something more than a tech ping:

- **`[✍️ Open feedback form]`** — `web_app` button opening the post-date
  Feedback Mini App (`apps/webapp/feedback.html`). The form shows three
  cards: a custom 1–10 chemistry slider, a `Yes / Maybe / No` segmented
  control for "second date?", and a free-text textarea with cycling
  placeholders. Slider value, second-date pick, and text are auto-saved to
  `DeviceStorage` so a swipe-down dismiss doesn't wipe a draft. On submit,
  the Mini App POSTs `{ matchId, chemistry, wantsSecondDate, text, language }`
  to `/v1/feedback/post-date` (auth: `tma <initData>`); the bot composes
  the structured fields into a single text blob for the LLM analyst — no
  schema additions to `Match`. Second-date pick is required to send.
- **`[🎤 Send voice instead]`** — callback `feedback:voice:{matchId}` puts
  the session into `awaiting_feedback`, sends a `record_voice` chat action,
  and asks for a voice note (or typed text — both accepted). The upstream
  `voiceHandler` transcribes via Whisper, then the same shared
  `recordPostDateFeedback` pipeline persists `Match.feedbackByA/B` and
  appends new negative constraints. Same pipeline as the form path.

### Emergency Protocol

`handlers/date/emergency.ts`:

- Tap → `awaiting_emergency_reason` session state.
- The user MUST type a free-text explanation; the bot quotes the **exact
  text** to the other person as a Telegram blockquote (no AI rewrite, no
  stripping) and appends a short Gennety soft note. Match flips to
  `cancelled`, `emergencyCancelledBy` records the actor, the verbatim text
  lands in `emergencyReason`.
- The partner who was cancelled on receives a very small Elo/priority bump
  (`EMERGENCY_CANCEL_PEER_ELO_BOOST = 5`). The canceller is not penalised
  because emergency reasons may be legitimate; `eloMatchesPlayed` is not
  incremented because no accept/decline contest resolved.

## Phase 5 — Trust & Safety (Reports + Strikes)

Post-match the bot offers `[Report]` (callback `report:open:{matchId}`).
Free-text reason is LLM-triaged into a `tier`:

| Tier | Meaning | Action (`services/moderation.ts`) |
|---|---|---|
| **1 — Preference** | Personal preference mismatch, not unsafe | Append to *reporter's* `negativeConstraints`. No penalty on reported. |
| **2 — Ethical** | Unethical / boundary issues | `reported.strikes += 1`. **Strike 1** → warning DM. **Strike 2** → `status = suspended`, `suspendedUntil = now + 14 d`. **Strike ≥3** → `status = banned`. Cancel in-flight matches at strike ≥2. |
| **3 — Safety** | Safety threat | `status = pending_investigation` immediately, cancel in-flight matches, report row stays `adminReviewed = false` for the manual queue. |

Other safeguards:
- `(reporterId, matchId)` is unique — duplicate reports rejected at write
  time and surfaced as `reportDuplicate` to the user.
- `autoUnsuspendElapsed` runs hourly so a 14-day Tier-2 suspension that
  expires mid-week reactivates within the hour rather than waiting for the
  next Thursday batch.
- `MatchEvent` rows (`PROPOSAL_SHOWN`, `ACCEPTED`, `DECLINED`,
  `EXPIRED_SILENT`, `EXPIRED_PEER_IGNORED`, `DATE_COMPLETED`,
  `CHEMISTRY_POSITIVE`, `CHEMISTRY_NEGATIVE`) drive Elo updates and the
  admin dashboard's behavioural views. Emergency cancellation's small peer
  boost is applied directly by `handlers/date/emergency.ts` and does not
  increment `eloMatchesPlayed`.

## Cross-Cutting Concerns

### Quiet Hours

23:00–09:00 Europe/Kyiv. Enforced inside the **re-engagement** and
**match-nudge** workers (deferred to next 13:00 / next allowed window).
Pinned status-banner edits and the proposal-countdown plate are exempt
(no notifications) — they only re-edit existing messages.

### Standby / Starvation

`Profile.standbyCount` (canonical) + `missedWeeks` (legacy alias) increment
on every weekly batch where the user was eligible but unpaired, and also as
a compensating boost when the user accepted a proposal but the peer declined.
They reset to 0 on a successful pairing. `lastMissedAt` powers the "priority
boosted" UX ping. The matching score adds `starvationBonus(standbyCount)`
capped at 0.25 — strictly below the negative-constraint penalty so priority
breaks ties without forcing bad pairings.

### Embedding freshness (M-2)

Every code path that mutates `psychologicalSummary`, `partnerPreferences`,
`negativeConstraints`, or `hobbies` flips `Profile.embeddingDirty = true`.
The `embedding-refresh` cron (every 5 min, ≤20 rows/tick) recomputes via
OpenAI and clears the flag. Pre-M-2 the embedding silently went stale on
every profile edit, slowly degrading match quality.

### GDPR

- Account deletion (`/v1/me` `DELETE`, or admin) cascades through Prisma
  (`onDelete: Cascade` on every relation).
- Persona-captured selfies are auto-deleted 90 days after `verifiedAt`
  (`selfie-retention` cron); the user stays `verified`, only the reference
  image is scrubbed.
- `researchOptIn` is opt-in; default false. Audit is via `User.consentedAt`,
  `User.termsAcceptedAt`.

### Languages

`en` / `ru` / `uk`. All user-facing strings live in
`packages/shared/src/i18n.ts`. Onboarding/menu/Aether agents auto-detect
the user's language and forbid English enum injection into non-English
replies.
