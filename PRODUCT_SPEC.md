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

Gennety Dating is an AI-first romantic matchmaking service. It launched for
university students and (Registration v2, 2026-07) opens to a general adult
audience while keeping a first-class student community: students register
with a university email (and get loyalty perks), everyone else with a phone
number. It diverges from traditional dating apps by relying on deep context
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

- **Dual-Track Verified Registration (Registration v2)** — Every user MUST
  verify a contact rail at sign-up. The fork (gated by `PHONE_AUTH_ENABLED`;
  off → legacy email-only flow) offers two tracks recorded in
  `User.registrationTrack`: **student** — university email OTP (whitelist in
  `ALLOWED_EMAIL_DOMAINS`, e.g. `.edu`, `.ac.uk`), rewarded with
  `STUDENT_BONUS_TICKETS` (2) free Date Tickets; **general** — phone via
  Telegram one-tap `requestContact` (the bot receives a trusted
  `message.contact`; `User.phone` is `@unique` — one account per number).
  Matching admits the union (verified email OR verified phone); the student
  community keeps its flavor via educational homogamy, shared-domain curated
  venues, and the 🎓 profile line.
- **NO IN-APP CHAT** — Users NEVER message each other through our platform. Do
  not build chat interfaces between users. The only chats are user↔bot,
  user↔Aether concierge (mobile), and the structured pitch / scheduling /
  emergency flows. **Narrow exception (feature-flagged):** the Variant C
  pre-date *anonymous proxy chat* (§Phase 4 — Pre-date coordination) relays
  text between an already-matched, already-scheduled pair. It is deliberately
  scoped so it does not reopen general user-to-user chat: post-match only,
  time-boxed (opens T-30m, auto-closes T+2h), text-only (media rejected),
  every message logged to `ProxyMessage`, an in-line Report button on each
  relayed message, and off by default (`COORDINATION_FEATURE_ENABLED`). It
  exists to solve "find each other at the venue", not conversation.
- **Deep Context over Questionnaires** — At the end of the Telegram entry Mini
  App the user chooses whether to enrich onboarding from ChatGPT, Claude,
  Gemini, or another personal LLM. Accepted users paste the *Magic Prompt* and
  return the long psychological analysis. Declined users continue without it;
  the backend generates a deterministic fallback summary + embedding from
  their ordinary onboarding answers.
- **Identity-Verified, Mandatory at Launch** — Liveness (Persona) +
  photo↔selfie face-match (AWS Rekognition) gate full match eligibility. With
  `MANDATORY_VERIFICATION_ENABLED` on (Registration v2), the CTA has no Skip
  button and activation happens ONLY through the pipeline's `verified`
  outcome; legacy skip callbacks refuse politely and pre-flip skippers are
  grandfathered with their `UNVERIFIED_ELO_PENALTY`. With the flag off, the
  legacy two-step soft skip + Elo penalty applies (see §1.4).
- **Progressive Logistics** — The AI auto-proposes timeslots first; if both
  rounds fail it hands off to the Calendar Mini App; venue is chosen by an
  AI concierge from each user's free-text *vibe* + commute pin.
- **Native Telegram AI Experience** — Heavy use of Bot API 9.x/10.x:
  bottom-of-chat `sendMessage` + `editMessageText` streams (status, pitch,
  no-match, ice-breakers), `icon_custom_emoji_id` (menu and match-decision
  affordances), `message_effect_id` (match confirmations), `date_time`
  MessageEntity (timezone-aware date confirmation), and pinned status banner
  (live discrete countdown). Product flows intentionally avoid Telegram draft
  streams because clients treat them like generated AI replies and may reserve
  scroll space for a follow-up answer.
- **Blind Decision Invariant** — A user must never learn their partner's
  Accept/Decline before committing to their own.

## Phase 1 — Onboarding

> The legacy "strict linear FSM" sequence is **gone**. After the email gate,
> onboarding uses a server-owned fact collector shared by Telegram and
> `/v1/onboarding/interview*`. The server persists every confirmed fact
> immediately and deterministically chooses the next missing field. An LLM may
> extract multiple explicitly stated facts from free text, but it does not own
> progress, question order, photo gates, or finalization.

### 1.1 Initialization, Language & Consent (`onboardingStep = consent`)

- `/start` (or first mobile launch) creates a `User` row and captures any deep
  link as `referralSource` (`tg:<start_param>` / `mobile:utm=…` /
  `referral:<USER_ID>`). The Telegram entry Mini App first asks for the
  language, then renders the consent + ToS card in that selected language.
- Telegram `/start` now opens a full-screen Onboarding Mini App before the
  conversational agent takes over. The Mini App presents the visual intro,
  language, legal consent, the **sign-up fork** (when `PHONE_AUTH_ENABLED`,
  mirrored to the client as `phoneAuthEnabled` in `/state`): student →
  corporate-email OTP gate; general → phone one-tap gate (PhoneGate polls
  `/state` until the bot records the trusted `message.contact`); then dating
  city, a **light/dark theme picker** (right after the city gate, before the
  visual intro; default `dark`, changeable later in Settings — `POST /theme`
  records it), and the final AI memory export choice, using Telegram `initData`
  HMAC auth for all writes (`POST /track` persists the re-choosable fork pick). If
  the user arrived through a verified
  website handoff (`auth_<token>`; legacy `web_<token>` still accepted), the
  server-side `isEmailVerified` state skips the fork and Email/OTP screens
  (the handoff stamps `registrationTrack=student`).
- When the Mini App reaches its handoff step, it calls
  `/v1/telegram-onboarding/complete` with the visual-flow token issued by
  `/v1/telegram-onboarding/state`; the bot immediately resumes the chat through
  the onboarding collector. This does **not** mark onboarding complete by
  itself — required profile fields, photos, and verification CTA still follow
  the normal product rules. Magic Prompt context is required only when
  `aiMemoryExportPreference = accepted`.
- The user MUST flip `termsAccepted` (legal click) and MAY opt into
  `researchOptIn` (analytics use of anonymised data, default false per GDPR
  norms).

### 1.2 Language (`onboardingStep = language`)

- Five options: `English`, `Русский`, `Українська`, `Deutsch`, `Polski` →
  persists `User.language` and `BotSession.language`. (The shared i18n `Language`
  type and the onboarding Mini App picker both carry all five; `en` is the
  fallback.)
- In the Telegram entry Mini App, language selection precedes legal consent so
  the consent screen is immediately understandable. Email and every later gate
  remain blocked until terms are accepted.
- Server-owned question templates match the user's language thereafter and are
  forbidden from injecting English enum words ("male/female/men/women") into
  non-English replies.

### 1.3 Conversational profile capture (`onboardingStep = conversational`)

Email OTP remains handled by the onboarding agent. Once email is verified, the
fact collector owns profile capture:

| Stage / action | Effect |
|---|---|
| `send_otp_email(email)` | Validate domain, mint OTP, send via email provider |
| `verify_otp(code)` | Check the 6-digit code, flip `isEmailVerified` |
| `resend_otp()` | Re-send to the email already on file |
| `extract + validate` | Require exact user-message evidence; validate age, height, enums, and placeholders |
| `partial save` | Transactionally persist each accepted fact to `User` / `Profile` after every text or voice answer |
| `advance` | Choose the first actually missing field from the canonical order |
| `context gate` | Surface and save the Magic Prompt only when AI memory export was accepted |
| `photo gate` | Preserve early photos but do not skip unfinished profile questions |
| `finalize gate` | Activate only after required profile data, AI-memory branch, city, a verified contact rail (email or phone, per track), and minimum photos are complete |

Canonical order: name + age → gender → preference → height → hobbies → partner
requirements → optional nationality/ethnicity → **vibe (ideal Friday night →
process-vs-who follow-up)** → AI memory → photos. Questions come from server
templates for `en`, `ru`, `uk`, `de`, and `pl`.

**Vibe questions (matching signal, asked of everyone).** Two short free-text
questions sit right before the Magic Prompt step so *every* user — including
those who decline AI-memory export — supplies real psychological signal, not
just demographics:

- `friday_vibe` — "describe your ideal Friday night, money/logistics no object,
  honestly (not what sounds 'right')".
- `vibe_focus` — "what matters most — the experience itself, or who's with you?".

At `finalize_onboarding` one LLM pass (`services/vibe-axes.ts`) maps the two
answers into structured columns: `Profile.energyAxis` (internal↔external
"tempo"), `orientationAxis` (experience↔connection), `socialRole`
(initiator/participant/observer — **stored, not scored in v1**), and
`anchorTags[]`. The raw Friday text is folded into `psychologicalSummary` so it
also feeds the embedding (`V_explicit`) and survives `embedding-refresh`.
Extraction is best-effort: a failure never blocks finalize (matching simply
skips the vibe factor). These answers replace the duplicated Profiler questions
(§Phase 1b) and feed icebreakers. See §3.2 for how the axes are scored.

Before the Telegram Mini App hands off to the conversational bot, the user
must also choose a **dating city** (`Profile.homeCityKey`). This is framed as
"where you want to receive matches", not as a home address. Users can search
for a city manually or let the Mini App resolve their browser geolocation to a
city; raw coordinates alone do not satisfy the matching gate.

The final Mini App screen records `User.aiMemoryExportPreference` through
`POST /v1/telegram-onboarding/ai-memory`:

- `accepted` keeps the existing Magic Prompt flow and server-side ordering
  guards (`save_context_dump` before photos/finalization).
- The pasted AI response is processed automatically after a short idle pause;
  there is no separate paste-confirmation button.
- `declined` suppresses the Magic Prompt for the current onboarding run,
  permits photo collection directly after the ordinary profile fields, and
  generates `Profile.psychologicalSummary` + embedding from those fields at
  finalization.
- `undecided` cannot pass `/v1/telegram-onboarding/complete`.

Hard rules enforced by the collector:
- Required fields (`firstName`, `age`, `gender`, `preference`,
  `partnerPreferences`) are NEVER skipped — keep asking until concrete.
- Gender is accepted only from a direct answer and is never inferred from a
  name.
- Multiple explicit fields in one message are all saved. The last explicit
  correction replaces the previous canonical value.
- Real user text is distinct from `resume`, `context_dump`, and
  `photos_updated`; synthetic events, assistant text, summaries, and tool
  arguments are never mined as profile facts.
- Nationality/ethnicity is asked at most once and may be explicitly skipped.
- "No hobbies" / a single hobby is a valid answer; the agent must NOT chain
  "one more, one more" requests.
- `MIN_PHOTOS` (4) is a hard floor; anything beyond up to `MAX_PHOTOS` (6) is
  purely optional. In Telegram conversational onboarding, the media stage is
  deterministic rather than LLM-owned:
  before the minimum, the bot reports exactly how many valid photos are still
  needed; once 4 photos are valid, it keeps the stage open and shows one
  **Continue** action instead of finalizing automatically. The user may keep
  sending photos one-by-one or as a Telegram album, send a short profile video,
  tap Continue, or type a localized equivalent such as "done" / "дальше".
  Albums and rapid standalone photos are coalesced into one progress response,
  so a 4- or 6-photo burst does not produce one reply per frame. At 5 photos the
  bot uses a short progress reminder rather than repeating the full pitch.
  Exact duplicates (same Telegram `file_unique_id` within a batch) and
  re-encoded / cropped copies (perceptual `differenceHash` within
  `DUPLICATE_HASH_DISTANCE` (8) of any accepted hash) are not counted and
  receive an explicit explanation. **Identity is enforced only by Persona
  verification, not by an upload-time gate before it (simplified 2026-06-23).**
  Before the user has a `verifiedSelfiePath`, each static photo that passes
  safety, usable-face presence (Rekognition face confidence ≥ 0.55 and face
  area ≥ 0.8% of the frame, lenient by design — angled / partially-turned /
  full-body shots are normal; lowered from 0.75/1.5% after a calibration run
  found legit photos bounced as `no_face`), a light **obstruction** check on
  the largest face (reject `face_obscured` only on dark `Sunglasses` ≥ 0.90 or a
  `FaceOccluded` mask/covering ≥ 0.99 — clear prescription glasses and noisy
  sub-0.99 occlusion pass; pose / lighting / sharpness are deliberately NOT
  gated since extreme turned-away / dark / blurred / cropped shots already fail
  the presence floor), and the duplicate
  checks is accepted and counted toward `MIN_PHOTOS` **immediately**: there is
  no cross-photo "same person" clustering and no self-photo identity anchor.
  (The earlier hidden `pendingPhotoCandidates[]` consensus pool — which held the
  first photos invisible until two of them clustered at
  `FACE_SIMILARITY_THRESHOLD` — was removed because it stranded legitimate users
  whose genuine same-person photos scored just below the CompareFaces
  threshold, leaving them with zero accepted photos and no way to finish
  onboarding. `pendingPhotoCandidates` / `referenceFaceEmbedding` columns are
  retained but no longer written by the upload flow.) Once the user is
  Persona-verified, every uploaded or edited photo is compared against the
  verified selfie — the real identity gate — and the verification pipeline
  re-runs on every photo edit (§1.4), so a wrong-person photo on a verified
  profile is caught there. Unsafe, no-face, duplicate, and technical-processing
  failures are rejected before accepted-profile persistence, logged to
  `media_validation_rejections`, and keep the user in the same retryable upload
  session.
- When `TICKET_FEATURE_ENABLED`, the first post-minimum offer explains both
  rewards: reaching `PHOTO_BONUS_TICKET_THRESHOLD` (6) face-validated photos
  grants a free Date Ticket, and adding a profile video grants another. A batch
  that already reaches 6+ photos receives the photo reward immediately, but the
  media stage remains open so the user can still add the optional video. Each
  bonus is one-time/idempotent (`Profile.photoBonusTicketAt` /
  `videoBonusTicketAt`) and explains the mechanic in the reward DM (each date
  costs 1 ticket; tickets normally cost money). See §3.5b.
- Profile media may be a mix of static photos, Telegram Live Photos, and a
  profile **video**. A Live Photo counts as one profile media item toward
  `MIN_PHOTOS` / `MAX_PHOTOS`, but its static frame is still stored in
  `Profile.photos[]` and must pass the same safety, usable-face, and duplicate
  checks as a normal profile photo (identity only against the Persona selfie,
  once verified). Live Photos without a static frame are rejected.
  A **video** (`ProfileMedia` `{ type: "video" }`) remains display-only and is
  NOT added to `photos[]` or counted toward `MIN_PHOTOS`, preserving the
  `photos[i] ↔ photoFaceScores[i]` invariant. The video is validated for
  **safety only** (simplified 2026-06-23 — it carries no identity gate, since
  it is display-only and the old face-presence / owner-match checks reused the
  same brittle CompareFaces path and bounced legitimate friends / scenery /
  party clips). Before persistence, `VIDEO_SAMPLE_TARGET_FRAMES` (12) frames are
  sampled evenly and independently moderated (OpenAI + AWS), and the audio
  transcript is moderated; any confidently unsafe frame or an unsafe audio
  transcript is rejected. Friends, groups, parties, and scenery are allowed,
  and the owner need not appear. Videos over 60 seconds or 100 MB are rejected.
  The video is display-only (stored + re-sent by Telegram `file_id`), so the
  size ceiling is a product choice rather than a hard platform cap — but note
  that when `PROFILE_MEDIA_VALIDATION_ENABLED` is on the safety check downloads
  the clip via Bot API `getFile`, and the standard cloud Bot API cannot supply
  files over 20 MB, so 20–100 MB videos can only be safety-validated behind a
  self-hosted Telegram Bot API server. A rejected replacement never overwrites the existing valid video
  and never grants the ticket bonus. Accepted video metadata stores only
  validation version/time; extracted frames, audio, and transcripts are
  temporary and never persisted.
- For accepted export, photos MAY NOT start until the context dump is saved.
  Declined export skips context collection and uses the fallback analysis.
- After a pasted AI memory dump is parsed and saved, the bot plays a
  self-replacing "analysing" status line (one message edited in place through
  a few steps, each held a beat, then deleted before the photo request) to
  surface the psychological-summary + embedding work that just ran. The same
  `runStatusSequence` primitive (`services/ai-stream.ts`,
  `services/analysis-status.ts`) backs the equivalent "agent is working"
  beats at verification submission, the verification soft-skip, each Profiler
  batch boundary, every Profiler question's compose beat (§Phase 1b),
  concierge venue selection, the profile-video upload check,
  and the date-card PNG render (§3.7a). Most of these are cosmetic pacing only —
  fixed-duration stubs that narrate real but usually sub-second work and never
  gate the flow. Concierge venue selection is hybrid: the first three beats
  always play out, then the final atmosphere beat tracks
  `until: <venue promise>` and is held until the venue is ready. The
  **date-card render** remains the genuinely slow render
  wait: its status is passed a `until: <render promise>` and the last step is
  **held on screen until the PNG is actually ready** (then torn down before the
  card is sent), rather than running on a timer. The **profile-video upload
  check** is the other genuinely-slow held wait: while it runs (frame sampling +
  Rekognition face/identity + image/audio moderation + Whisper transcript) its
  first two beats play as pacing and the final "last checks" beat tracks
  `until: <validation promise>` **plus a short deliberate pad**, held until the
  check settles and then torn down before the accept/reject verdict lands in its
  place. All of these `runStatusSequence` "agent is working / analysing" beats
  render through the native rich `<tg-thinking>` shimmer + AI Actions `<tg-emoji>`
  draft path (each call site opts in with `rich: true`; there is **no** global
  env toggle — see deploy.md), and degrade to the classic bottom-of-chat
  edited-message stream when a client can't render rich drafts. The AI-compose
  feel is the intended look for these status beats, so they accept the rich-draft
  tradeoff (the client may treat it as a generated AI reply / reserve scroll
  space). Two flows use the same rich path for streamed *questions*, not just a
  status beat: (1) the Profiler in-batch flow (§Phase 1b), so the post-onboarding
  Q&A reads as an AI composing each question for the user; and (2) the **periodic
  profile-survey "thinking" pause** — during the conversational profile survey,
  every third typed answer the bot holds one short "thinking" shimmer beat
  (~2.5 s, the `think` AIActions glyph) *before* the next question is composed.
  The pause runs strictly first: the "typing…" indicator and the next-question
  generation only start after the shimmer is torn down, so the thinking beat is
  never preceded by a typing indicator. Photo-stage continues, photo/video
  uploads, and context-dump pastes do not count toward the cadence. The
  *content* streams that are NOT thinking-status beats — the match pitch,
  no-match notice, and ice-breaker DMs (`streamDraftsToChat(..., { rich: true })`
  → `streamRichDraftsToChat`) — also stream through the native rich AI-compose
  draft path (their lead "thinking" chunk renders as a `<tg-thinking>` shimmer),
  **but their final persisted message is sent as a plain `sendMessage`, not a
  rich message**: it must stay a normal, non-self-deleting text message, and for
  the pitch the proposal-countdown worker live-edits that final message via
  `editMessageText`. They degrade to the classic edited-message stream when a
  client can't render rich drafts.

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
  URL via `/v1/me/verification/url` — it isn't a Telegram client. When
  `TICKET_FEATURE_ENABLED`, the CTA also promises one free Date Ticket for a
  successful final `verified` result. The verification pipeline credits it once
  through `TicketLedger` (`reason = verification_bonus`), so webhook retries,
  manual pulls, photo-triggered reruns, and later re-verification cannot
  duplicate it. The reward DM confirms the new balance.
- **Skip for now** — *(legacy path — hidden when
  `MANDATORY_VERIFICATION_ENABLED` is on: the CTA then carries only the Verify
  button with the `verifyPitchMandatory[Ticket]` copy, and taps on pre-flip
  Skip / Skip-anyway buttons refuse with `verifyMandatoryNotice` + a fresh
  Verify button — no penalty, no unverified activation; already-skipped users
  stay grandfathered.)* A *two-step soft skip*. The first tap does **not** apply
  any penalty: the bot plays a short personal **voice note** (native Telegram
  `sendVoice`, OGG/Opus, language-aware across all five onboarding languages
  `en`/`ru`/`uk`/`de`/`pl`) explaining why skipping
  hurts the user's rating, and offers a fork — **reconsider** (re-opens the
  Verification Mini App / hosted flow) or **Skip anyway**. Only **Skip anyway**
  flips `verificationSkippedAt`, drops `Profile.eloScore` by
  `UNVERIFIED_ELO_PENALTY` (= 150 from a 500 default), and activates the user as
  `unverified`. With tickets enabled, the text also makes clear that skipping
  forfeits the free verification ticket. Telegram's native inline-button styles
  render the reconsider action as `success` (green) and the final skip action as
  `danger` (red), with emoji labels retained for older clients. Reversible by
  later running Persona. The voice assets are
  bundled in the bot (`apps/bot/src/assets/verify-skip/`) and sent with an
  in-memory `file_id` cache; a missing asset or send failure degrades
  gracefully to a text message carrying the same fork.

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
     `eloScore` via one cold-start AI vision request containing every profile
     photo. The model returns an independent score for each photo; the server
     uses their arithmetic mean for the 0..100 attractiveness score and stores
     both the aggregate and per-photo audit details in `eloSeedDetails`.
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
handlers and Aether's `attach_profile_photo` tool fire
`triggerVerificationRerun` after every add/delete/replace,
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

**Verification-stall nudges (Registration v2).** With
`MANDATORY_VERIFICATION_ENABLED` on, a user who finalized onboarding but
hasn't passed Persona (`status='onboarding'`, `onboardingStep='completed'`,
`verificationStatus ∈ {pending, unverified}`) would otherwise fall outside the
chain above. The verification CTA re-arms the chain, and the same worker runs
a second sweep that sends the localized `verifyReminderNudge` (with the Verify
button) on the same decaying cadence until the pipeline activates the user or
the chain exhausts. `pending_review`/`rejected` users are deliberately NOT
nudged — they already did their part (or got rejection guidance).

## Phase 1b — Profiler

The **Profiler** (`workers/profiler.ts` + `services/profiler.ts`,
`services/profiler-schedule.ts`) collects gender-specific Q&A *after*
onboarding to fuel the §Phase 4 icebreakers and wingman hints. It is
**not** an input to the matching algorithm — purely fuel for icebreakers/hints.
Telegram-only in v1.

- **Entry.** The first question fires **~10 min after onboarding completes**
  (`PROFILER_ENTRY_DELAY_MS`), armed at `finalize_onboarding`; the scheduler
  defers it out of the user's local quiet hours. Existing/legacy users are
  lazily seeded by the worker, their first batch landing at the next window.
- **Batches.** Questions are sent in **batches of 3** (`PROFILER_BATCH_SIZE_NORMAL`).
  **Every** question — the first of a batch and every follow-up — is delivered
  through the same **native Telegram AI-compose** path (Bot API 10.1 rich
  messages, `streamComposedRich`), so the experience is uniform: one question is
  never a plain dump while the next streams. Each question is **one** rich-message
  draft (a single `draft_id`) carrying, in order: a `<tg-thinking>` **shimmer
  status** whose leading glyph is an animated **AI Actions** `<tg-emoji>`, then
  the question streamed in as growing rich-message drafts, then the question
  persisted as a real message carrying the Skip button. Because it's a single
  draft, the client reserves/collapses the "AI is composing" scroll space exactly
  **once** per question — no mid-stream jump. The status beats differ only by
  context: a **follow-up** (after an answer/skip) shows acknowledge → "thinking"
  (`profilerNextQuestionSteps`, ~2.5s + ~4.5s); the **batch opener** (after a
  long window pause, nothing to acknowledge) shows just "thinking"
  (`profilerOpenQuestionSteps`). The between-batch confirmation ("Preference card
  updated ✅") uses the same shimmer path. If a client can't render rich drafts
  every path falls back to the classic edited-message stream. Like the
  thinking-status beats in §1.3, this streamed-question flow opts into the rich
  `<tg-thinking>` path; it accepts that the client may reserve scroll space under
  the draft, because the AI-compose feel is the goal here.
  Between batches the Profiler pauses to the next **morning (09:00) / evening
  (18:00) window in the user's local time** (`Profile.timeZone`, derived from
  the dating city; `Europe/Kyiv` fallback). When the next weekly drop is within
  **48 h** (`PROFILER_RUSH_WINDOW_HOURS`) it switches to **rush mode**: batches
  shrink to **2** to fill the profile before the event.
- **Date-negotiation gate.** The Profiler stays **silent while the user is
  mid date-planning** so its icebreaker questions never interrupt the flow they
  are meant to fuel. A due batch is held (deferred to the user's next local
  window) whenever the user is on either side of a match in an in-progress
  negotiation — `proposed` (pitch decision), `negotiating` (calendar
  scheduling), or `negotiating_venue` (venue selection)
  (`PROFILER_BLOCKING_MATCH_STATUSES` / `hasActiveDatePlanning`). `scheduled` is
  intentionally **not** a blocking state: once the date is locked in, the wait
  before it is a fine moment to gather icebreaker fuel. The gate also applies
  mid-batch — if a negotiation starts while a batch is in flight, the answer in
  hand is saved but the remaining questions pause to the next window. So the
  questions only ever land when the user is idle-and-waiting or simply waiting
  on a `scheduled` date, never during the pitch/scheduling/venue steps.
- **Skip.** Every question has a **Skip** button. A skipped question returns
  **once** at the end of the current cycle; skipped twice in a cycle, it drops
  until the next drop cycle. Answered questions are never re-asked.
- **Cross-cycle persistence.** Unanswered questions carry into the next drop
  cycle in priority order; the Profiler never resets. Completion is **silent**
  (no "profile complete" ping). No progress indicator, no "why we ask" copy.
- **Questions.** Women are asked from the "what you want in a partner/date"
  angle (fuels the man's *hints*); men from the "who you are" angle (fuels the
  woman's *icebreakers*). The bank lives in `packages/shared/profiler-questions.ts`.
  Questions the onboarding §1.3 vibe answers now cover were **removed** to avoid
  duplication: `f_activity_pref` ("active vs calm" = the energy axis) and
  `m_ideal_evening` (≈ the ideal-Friday question). The remaining bank is
  icebreaker-only flavor that onboarding does not capture (chronotype, sport,
  turn-offs, shared interests, media, surprises, communication style).
- **Storage.** One `ProfilerAnswer` row per (user, question): `priority`,
  `answerText`, `skipped`, `skipReturned`, `cycleId`.
- **Weighting.** Icebreaker/wingman-hint generation emphasises a partner's
  answers by priority weight (`high 1.0 / medium 0.5 / low 0.2`,
  `PROFILER_PRIORITY_WEIGHTS`). Profiler answers are the **primary** source;
  generation falls back to `psychologicalSummary` when a user has no answers
  (see §3.7 wingman and §Phase 4 icebreakers).
- **Off switch.** `PROFILER_CRON_SCHEDULE` (default `*/15 * * * *`).

## Phase 2 — Main Menu & Persistent Surface

### 2.1 Telegram bot menu (`handlers/menu/main.ts`)

The persistent inline menu uses a `custom_emoji` entity for the 🎓 title icon
when `CUSTOM_EMOJI_MENU_ID` is set. **Bot API limitation:** inline keyboard
button labels CANNOT carry `custom_emoji` entities — buttons fall back to
plain Unicode emoji.

Layout: the two **paired** rows come first — **My Profile · Edit Profile**, then
**Pause Matching · Settings** — followed by the single-button rows in order:
**Profile Video**, **My Tickets** (feature-flagged), **Report / Help**.

- **My Profile** — generated bio + photos (and the profile video, when present).
  When no video is set, a one-line hint points to the Profile Video entry.
- **Edit Profile** — non-identity fields only. `firstName`, `age`,
  `email`, `universityDomain` are **fixed** post-onboarding.
- **Pause Matching** — flips `User.status = paused`. The match engine ignores
  paused users; the status banner shows "paused".
- **Settings** — change `language`; **change theme** (a light/dark inline
  toggle mirroring the language flow — persists `User.theme`, which every Mini
  App and both PNG cards honor); re-open verification when applicable; and
  **Delete Account**, which now offers a softer alternative first (Telegram-only,
  see below).
- **Profile Video** — the first single-button row: an **always-visible**
  main-menu entry to add, replace, or
  remove the optional display-only profile **video** *after* onboarding (the same
  upload + safety-only validation as the §1.3 media stage, via the shared
  `services/profile-video.ts`). The video is never added to `photos[]` and never
  triggers a verification rerun, so the `photos[i] ↔ photoFaceScores[i]`
  invariant is untouched. When `TICKET_FEATURE_ENABLED` and the one-time video
  bonus is unclaimed, the button shows a 🎁 marker and the screen promises a free
  Date Ticket; the bonus is granted idempotently via `Profile.videoBonusTicketAt`
  (same claim as onboarding, so it pays at most once across both surfaces).
  Removing the video does not reverse an already-granted bonus.
- **My Tickets** — (only when `TICKET_FEATURE_ENABLED`) shows the user's
  `ticketBalance` and a `web_app` button into the ticket store Mini App
  (`tickets.html`) to pre-purchase bundles ahead of any date. See §3.5b.
- **Report / Help** — opens the support handle.

**Account deletion → Freeze fork (Telegram-only).** Tapping **Delete Account**
no longer goes straight to a destructive confirm. The bot first plays a
per-language founder **video note** (кружок) explaining why freezing beats
deleting, then offers a two-button fork with native styles so the destructive
path is visually distinct: a blue (`primary`) **❄️ Freeze account** over a red
(`danger`) **Delete anyway**.
- **Freeze** sets `User.status = frozen` — a soft-delete that keeps the User,
  Profile, embedding, verification, photos, and coordinates intact, removes the
  user from the matching pool (the engine matches only `active`), cancels any
  in-flight matches (the partner gets a neutral notice + the small emergency-cancel
  priority/Elo comp), and unpins the status banner. On the user's next `/start`
  they are **silently reactivated** to `active` straight into their ready
  profile — no re-onboarding, no re-verification, no re-embedding.
- **Delete anyway** leads to a final confirmation that isolates the destructive
  option: one red **Yes, I'm 100% sure** against two green back-out buttons. Only
  the red path runs the existing GDPR hard delete (Prisma cascade). The hard
  delete now also notifies/comps any in-flight partner before the cascade wipes
  the match rows.
- The кружок assets live at `apps/bot/src/assets/delete-freeze/<lang>.mp4`
  (square, ≤60 s, same mechanics as the welcome-gift video note); a missing
  language degrades gracefully to the text + buttons. Mobile keeps the plain
  `DELETE /v1/me` hard delete (no freeze).

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
  `Message` row and supports image attachments. Post-onboarding fixed identity
  fields such as age cannot be changed through the tool. Attaching a chat image
  to the dating profile re-runs the same upload-time safety, face-presence,
  identity, duplicate-hash, profile-bucket copy, metadata, and
  verification-rerun path as a normal profile-photo upload.
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
  `NoMatchNotice@@unique([userId, dropDate])`. The DM is delivered through the
  native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`,
  the same primitive as the match pitch), so it reads as personally composed
  rather than a mass-blast template. It is a deliberately **short** 2-chunk
  stream — one "thinking" lead beat (`noMatchStreamStart`, a `<tg-thinking>`
  shimmer) then the full message as the plain final `sendMessage` — so bad news
  is never spelled out slowly. Degrades to the classic edited stream when a
  client can't render rich drafts. Telegram-only (mobile/Expo accounts are skipped here).
  When `TICKET_FEATURE_ENABLED` and the famine streak reaches **tier ≥ 2**
  (2nd consecutive week+), the same DM also grants and announces a one-time
  **single-ticket discount** (see §3.5b — *Famine discount*).

### 3.2 Scoring (`services/match-engine.ts`)

Hybrid SQL + Node.js re-rank.

```
MatchScore = ((w₁·V_explicit) + (w₂·V_research)) · V_league · V_agePref − (w₃·V_penalty)
                                                + starvationBonus
```

- `V_explicit` (cosine similarity of the 1536-dim profile embedding), weight
  0.65 (lowered from 0.80 on 2026-06-21). The embedding now carries only
  open-ended psychological prose: demographics (age/gender/height/city) that
  duplicate `V_research`/hard filters were stripped from the declined-profile
  fallback text, and the §1.3 vibe answers were folded in, so the embedding
  finally has real signal for users who skip the Magic Prompt.
- `V_research` (structured compatibility heuristics), weight 0.35 (raised from
  0.20). Sub-factors (weighted, renormalised over whichever are present):
  **vibe quadrant proximity** 0.40 (PRIMARY), age gradient 0.20, height norm
  0.20, educational homogamy 0.20. The quadrant factor scores *proximity*
  between the two users' `energyAxis`/`orientationAxis` (§1.3) — similar tempo
  lands in the same/adjacent quadrant, a big tempo gap is penalised harder than
  an orientation gap. This **replaces** the old keyword-scanned "social energy"
  factor (which was phantom — it scanned `psychologicalSummary` for the English
  words introvert/extrovert and almost never fired). `socialRole` complementarity
  is intentionally NOT scored yet (Phase 2 — needs accept/decline data).
- The explicit/research re-split is **inside** the positive bracket, so it does
  not change `V_league`'s role: beauty still multiplies the whole bracket
  identically. `V_league` is unchanged.
- `V_league` — universal Elo-distance multiplier and the **primary
  (assortative) match gate**. Elo is seeded from the AI vision attractiveness
  pass (0..100 → Elo 200..800, 6 Elo per attractiveness point), so this is in
  practice an *attractiveness-similarity* multiplier. Same league = 1.0,
  decays linearly past `LEAGUE_TOLERANCE = 60`, floors at `LEAGUE_FLOOR = 0.05`.
  Tightened 2026-06-06 so similar attractiveness decides *whether* a pair is
  viable, while psychology (embedding/research) ranks pairs *within* a tier:
  a ~10pt looks gap still gives 1.0, ~20pt → 0.70, ~30pt → 0.40, ~40pt → 0.10,
  and a "90 vs 30" pairing floors at 0.05 (effectively never matched unless the
  starvation bonus rescues a long-unpaired user). Example: an Elo gap of 180
  (≈ a 30-attractiveness-point difference) yields `V_league ≈ 0.40`, so a pair
  that is far apart on looks must have an exceptional psychological/embedding
  fit to outrank a same-tier pair.
  - **Male upward reach (hetero pairs only).** `V_league` is *asymmetric* for
    M/F pairs (`pairLeagueScore`): when the woman out-scores the man, the gap
    is discounted by `MALE_REACH_ELO` (env, default 36 Elo ≈ 6 attractiveness
    points) before the decay — so a less-attractive man is paired with a
    somewhat *more*-attractive woman without the league penalty crushing the
    match. With the default reach a man matches at full strength (1.0) with
    women from his level up to ~16 attractiveness points above him. Matching
    "down" (man already more attractive) is unchanged, and same-gender /
    unknown-gender pairs keep the symmetric `leagueScore(|Δ|)`. This stacks on
    top of the gender-calibrated vision scoring (§1.4), so the reach is kept
    deliberately small to avoid women systematically receiving visibly
    less-attractive partners.
- `V_agePref` — **stated preferred-partner age-band** multiplier
  (`ageRangePreferenceScore`, `Profile.ageRangeMin/Max`). Applied to the
  positive bracket alongside `V_league`. It is a **soft preference, not a hard
  filter**: a candidate whose *actual* age is inside the seeker's stated band
  scores `1.0` (neutral); outside, the bracket is damped by
  `1 − yearsOutside·AGE_RANGE_PREF_DECAY_PER_YEAR` (default 0.1/yr), floored at
  `AGE_RANGE_PREF_FLOOR` (default 0.6) so a far-out-of-band partner is dampened
  but never excluded — an exceptional embedding/league fit can still surface
  them, and a thin city pool is never starved. Symmetric: `scorePair` evaluates
  each side's band against the other's age and averages. **Neutral (1.0) when
  the user never set a band** — the band is not collected at onboarding, so the
  common path is unchanged; only users who explicitly edit the range opt into
  the dampening. Distinct from the `V_research` *age gradient* (which scores the
  closeness of the two real ages); both can apply at once. Tunable via env
  (`AGE_RANGE_PREF_FLOOR` / `AGE_RANGE_PREF_DECAY_PER_YEAR`); set the floor to
  `1.0` to disable.
- `V_penalty` — negative-constraint penalty (subtracted), weight 0.30.
- `starvationBonus` — α=0.05 per missed weekly batch, capped at 0.25 (strictly
  below `V_penalty` so it never overrides a real negative-constraint hit).

Hard SQL filters (`buildCandidateSql`):
1. `status = 'active'` and `onboardingStep = 'completed'`.
2. Embedding present, `gender` and `preference` set.
3. Mutual gender compatibility (a's preference includes b's gender AND vice versa).
4. Verified contact rail present — `is_email_verified OR phone_verified_at
   IS NOT NULL` (Registration v2 union; legacy users are all
   email-verified, so this is a strict superset of the old email rule).
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
- **Match card set (feature-flagged, `MATCH_CARD_FEATURE_ENABLED`, default
  off).** When on, the partner photo media-group that leads the pitch is
  replaced by a rendered collage **card set** (`services/match-card`,
  satori/resvg/canvas — same stack as §3.7a): card 1 is the partner photo with
  an opaque rounded panel (name/age, one vibe line + one short paragraph from a
  dedicated compact copy pass — NOT the streamed pitch), each following card is
  one nearly full-bleed torn-collage photo; branding beyond the first card is
  limited to butterfly accents. The "paper" set renders in the **recipient's
  `User.theme`** (light cream / dark near-black card + panel; the burgundy
  accent, white photo frames and wine halftone dots are theme-agnostic). Sent
  as one protected album with the same
  name/age/✓ caption; collage jitter is seeded by match id + side. Any copy /
  render / send failure falls back to the plain protected media group, so
  pitch dispatch never wedges. Telegram-only.
- Pitches are queued through `services/dispatch-queue.ts` (rate-limited,
  default 2 s between sends ≈ 30/min). When a first-match welcome gift is
  actually delivered, the queue sends those gift pre-rolls first, waits
  `MATCH_PREROLL_DELAY_MS` (default 2 min), then reveals the match cards so the
  gift effect and pitch stream do not visually stack.
- For Telegram users the pitch streams through the native rich AI-compose draft
  path (`streamDraftsToChat(..., { rich: true })` → `streamRichDraftsToChat`):
  the headline/deadline/pitch chunks render as growing rich-message drafts with a
  `<tg-thinking>` shimmer beat (`matchStreamStart`), then the FINAL chunk is
  persisted as a **plain `sendMessage`** carrying the inline Accept/Decline
  keyboard — it stays a normal text message so the countdown worker's
  `editMessageText` keeps working against the same `pitchMessageId{A,B}`.
  Degrades to the classic edited-message stream when a client can't render rich
  drafts.
- An explicit `matchDeadlineNotice` follows the headline: **24 h** to reply,
  decision is final once committed.
- **Conversational decision (no Accept button, 2026-07-05).** The pitch
  message itself carries only the `[Report]` affordance — there is NO permanent
  Accept/Decline keyboard. After the pitch (and trust card) the bot asks a
  natural question in the recipient's locale — "So — want to go on a date with
  him/her?" (`matchDecisionQuestionM/F`, gendered by the partner) — and the
  user answers in their own words. `handlers/matching/decision-text.ts`
  classifies the reply (keyword fast-path across all five locales, small LLM
  fallback; unrelated messages fall through to the menu agent; active
  matchFlow/menuState sub-flows are never hijacked) and the styled
  confirmation button "flows out" of the answer as a reply to the user's own
  message:
  - yes-intent → confirm card with the native-`success` `[💫 Yes, I'm going]`
    button (`match:accept:` — the commit) over `[← Go back]`;
  - no-intent → the guarded decline confirmation card
    (`matchDeclineConfirmPrompt`, `[❌ Yes, pass]` `match:do:decline:` native
    `danger` over `[← Go back]` `match:keep:`) — a pass stays irreversible
    (lifetime-ban invariant §3.2), so it always needs the explicit red tap;
  - unsure → a no-rush nudge, no state change.
  Text alone NEVER commits a decision — the commit is always a button tap on
  the surfaced card. Replies are static copy revealing nothing about the
  partner's choice, so the §3.4 blind-decision invariant is untouched. The
  `match:accept:` / `match:decline:` callback handlers stay live for legacy
  in-flight pitches dispatched before this change. Telegram-only; the mobile
  `POST /v1/matches/:id/decision` path is unchanged (client-side confirmation
  is the app's concern).
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

### 3.5b Date Ticket Gate (feature-flagged monetization)

An optional premium step sits between mutual accept and the Calendar. It is
gated by `TICKET_FEATURE_ENABLED` (default **off** → the bot hands off straight
to the Calendar exactly as documented in §3.6). Telegram-only in v1: the mobile
mutual-accept path (`POST /v1/matches/:id/decision`) still schedules directly.

When enabled, mutual accept creates one live **post-accept status/CTA** per
Telegram side (tracked in `Match.calendarMessageIdA/B`): accepted/waiting →
premium **Date Ticket** card → Calendar. The ticket card carries a `web_app`
button opening the Ticket Mini App (`apps/webapp/ticket.html`, React +
pure-CSS 3D). Each ticket is **$6.99** (mock) or **350 ⭐** (Telegram Stars).
**Payment (production): Telegram Stars (XTR).** With `TICKET_STARS_ENABLED` the
date gate and the store both pay natively in Telegram Stars — the Mini App opens
a server-issued invoice link (`createInvoiceLink`, empty provider token,
`currency: "XTR"`; no merchant account needed) via `WebApp.openInvoice`, and the
bot's `successful_payment` handler (`handlers/payments.ts`) is the trust boundary
that settles: `store:<count>` credits the wallet (exactly-once via the unique
`TicketLedger.externalPaymentId` = `telegram_payment_charge_id`), and
`gate:<matchId>:<scope>` settles the ticket slot(s) via `applyStarsTicketPayment`
(the atomic slot CAS makes redelivery a no-op, so it needs no charge-id column).
`pre_checkout_query` re-validates payload + Star amount within Telegram's 10 s
window. The famine single-ticket discount is **USD-only** and never applies to a
Stars purchase. Star prices are env-tunable (`TICKET_BUNDLE_STARS`, default
`1:350,3:830,6:1350`; the gate derives its per-scope price from the 1-ticket
entry — self/partner 1×, both 2×).
**Payment (fallback): mock.** When `TICKET_STARS_ENABLED` is off, the legacy
mock (`TICKET_PAYMENT_MODE=mock`) fully simulates a Stripe-style flow that
updates the DB but moves no money; `mock`→`stripe` remains the alternate
production switch (`services/ticket-payment.ts`). Mock payment intents are
server-issued, expire after 15 minutes, are bound to the exact payer,
match/bundle, scope, and amount, and can be consumed only once. While Stars is
on, the mock `intent`/`confirm` routes 404 (PAY-1 guard) so Stars is the sole
purchase rail; the free wallet "Use a ticket" path is unaffected.

- **Pricing.** Male users get "Pay for us both — $13.98" (settles BOTH tickets,
  sets `paidForPartnerBy*`) plus "Pay only mine — $6.99". Female users get a
  single "Pay my ticket — $6.99". The server re-validates that pay-for-both is
  male-only.
- **Persistent ticket card + Calendar follows.** The ticket card is a
  **standalone, re-openable** message sent once per side and **never edited or
  deleted** — it is intentionally NOT tracked in `calendarMessageId*`. Tapping
  it always opens the Mini App, which re-derives the live state (offer →
  pay/use; or the "your match paid ❤️" surprise; or both-secured). Ticket
  progress (first paid, both paid) is reflected **inside the Mini App**, not by
  rewriting the chat card. Once both tickets settle, the Calendar arrives as a
  **separate** message that *follows* the ticket card (`startScheduling` sends a
  fresh `calendarMessageId*` card), and the scheduling/venue/time-lock flows
  only ever touch that Calendar card — so the ticket entry survives to the end
  of the flow and the covered woman can always reopen it for the surprise. This
  is a deliberate, scoped exception to the one-live-post-accept-card rule
  (§3.6): the ticket card and the Calendar card are two distinct, coexisting
  buttons.
- **Welcome gift.** Every new user is gifted **one free Date Ticket** as a
  personal "your first date is on me" gesture, delivered as a **pre-roll before
  their first-ever match pitch** (`handlers/matching/pitch.ts` →
  `services/welcome-gift.ts`): an optional gender-specific Telegram **video
  note** (кружок, founder message) followed by the gift DM (the
  `welcomeGiftTicket` copy, $6.99 value anchor + optional
  `MESSAGE_EFFECT_GIFT_ID` effect). The `sendVideoNote` API carries no caption,
  so the text is a separate message; a missing video asset degrades gracefully
  to the DM only. The weekly dispatch queue intentionally waits before sending
  the match card after a delivered gift so the confetti/effect moment stays
  visually separate from the pitch stream. The grant is one-time/idempotent — a
  `welcome_gift`
  `TicketLedger` row is the claim marker, so the FIRST qualifying pitch becomes
  the gift moment automatically (no separate "first match" detection) and
  retries/subsequent pitches never re-gift. Telegram-only in v1 (the mobile
  mutual-accept path bypasses the ticket gate) and inert unless
  `TICKET_FEATURE_ENABLED`.
- **Ticket wallet (pre-purchase + bonuses).** Users carry a `User.ticketBalance`
  topped up by onboarding bonuses (§1.3: 6+ photos, adding a video;
  §1.4: successful identity verification; Registration v2: the one-time
  **student bonus** — `STUDENT_BONUS_TICKETS` (2) tickets granted at
  university-email verification via the idempotent `student_bonus` ledger
  claim, announced with the `ticketRewardStudent` DM — the student track's
  welcome perk; the general/phone track gets none), the welcome gift above, and by bundle
  purchases in the store
  Mini App (`tickets.html`, opened from the
  **My Tickets** menu): **1 / $7.00**, **3 / $16.47** ($5.49 ea), **6 / $26.94**
  ($4.49 ea). Every balance change is written atomically with an append-only
  `TicketLedger` audit row (`services/ticket-wallet.ts`). At the gate, a user
  with tickets sees **"Use a ticket"** instead of paying:
  - female / single-self → "Use my ticket" when `balance ≥ 1`;
  - male with `balance ≥ 2` → "Use 2 tickets (you + your date)" or "Use 1 (self)";
  - male with `balance = 1` → "Use 1 (self)" and may still **additionally** pay
    or use a ticket for his date afterwards (the post-self "cover your date"
    screen, scope `partner`).
  Spends are atomic and guarded against going negative; a spend whose match-slot
  claim doesn't apply is refunded to the ledger. New TMA endpoints:
  `POST /v1/matches/:id/ticket/use` (gate spend) and `/v1/tickets/*`
  (wallet + store). Store purchases and the gate share the mock/stripe
  abstraction in `services/ticket-payment.ts`.
- **Famine discount (single ticket).** A one-time loyalty perk for a user the
  weekly batch left unpaired for a **2nd consecutive week or more** (no-match
  `tier ≥ FAMINE_DISCOUNT_MIN_TIER`). The §3.1 no-match DM grants and announces
  a **`FAMINE_DISCOUNT_PCT` (77%) discount on one ticket**, valid
  `FAMINE_DISCOUNT_TTL_DAYS` (30) days. It applies to a **single** ticket
  purchase only — the date gate's `self` scope and the store's "1 ticket"
  bundle — and is **consumed on the first such purchase** in either surface
  (`services/ticket-discount.ts`; persisted on `User.ticketDiscount*`). The
  Mini Apps render a "−77%" badge + the reduced price; `both`/`partner` scopes,
  the 3/6 store bundles, and the free wallet "Use my ticket" path are
  unaffected. The server always re-derives the charged price (the mock intent is
  amount-bound, so a stale discount auto-fails verify) and consumes via a CAS so
  a double-confirm redeems exactly once. Re-granted/refreshed each later famine
  week until used. Inert unless `TICKET_FEATURE_ENABLED`; Telegram-only in v1.
- **Hard gate.** The Calendar is not sent until *both* tickets are paid
  (`ticketStatus = completed`), at which point `startScheduling` runs and sends
  the Calendar as a **separate** message that follows each side's persistent
  ticket card (it does not replace it).
- **Partner-paid surprise screen.** When a male covers both, the gate completes
  for both. Because the ticket card is a standalone, never-edited message (see
  *Persistent ticket card* above), the covered partner's "buy ticket" entry
  simply stays in chat — no spoiler — so she opens the Mini App still braced to
  pay and instead lands on a dedicated, softly-animated **"{name} already paid
  your ticket ❤️"** reveal (`partner-paid` screen, `PartnerPaidCard`, Lavender
  Glass: glowing covered ticket with a ❤ "PAID" seal, drifting hearts, minimal
  copy), whose single CTA continues her to the Calendar. The ticket card stays
  re-openable (every open re-derives the right screen) for both sides until the
  date is fully scheduled; the Calendar simply follows it as its own button.
- **Goodwill cover read-receipt (his dopamine loop).** So the man's gesture is
  not a silent settle, covering the partner drives a three-beat loop
  (`ticket-gate.ts`): (1) the instant he covers her — via pay/use `both` or
  `partner` — he gets a confirmation DM (`ticketCoveredHerConfirm`, with the
  `MESSAGE_EFFECT_TICKET_ID` heart when set) and his own Mini App success screen
  celebrates it (`iCoveredPartner` → *"you covered {name}'s ticket 💛"*) instead
  of the neutral both-secured copy; (2) the read-receipt — the first time she
  actually sees the reveal (her `GET /ticket/state` returning `partnerPaidForMe`)
  stamps `Match.partnerPaidSeenAt` once (CAS) and DMs him
  `ticketPartnerSawItDm` (*"{name} saw that you covered her ticket ❤️"*), his
  "she was notified" proof; (3) the guaranteed fallback — because she may never
  reopen the ticket card before the Calendar arrives, gate completion sends her a
  warm `ticketPartnerPaidDm` nudge (with a button back to the ticket card) and
  stamps `Match.partnerPaidNudgedAt`, so the notification always lands. The nudge
  deliberately does NOT stamp `partnerPaidSeenAt`, keeping his read-receipt honest
  (it still waits for a genuine open — e.g. tapping the nudge button). All three
  are idempotent and best-effort (a DM failure never blocks settlement).
- **`ticketStatus` lifecycle.** `pending` → `partial` (one paid; `ticketExpiresAt`
  is the second side's deadline) → `completed`; or `refunded`/`expired` on
  timeout. **Refund/expiry policy:** the hourly `ticket-expiry` cron refunds a
  stalled `partial` payment (mock = no-op) and **opens the Calendar for free** —
  an already-accepted match is never killed by a payment stall.
- **State machine.** The whole gate runs while `Match.status = negotiating`;
  `ticketStatus` is a sub-state so the scheduling/venue/lifecycle code is
  untouched. Blind-decision and all other invariants are unaffected.

### 3.6 Calendar Scheduling

After mutual accept (or, when the Date Ticket gate of §3.5b is enabled, after
both tickets are paid) the bot DMs both users a button that opens the
**Calendar Mini App** (`apps/webapp`, Vite + Telegram Web Apps SDK). The
legacy three-iteration flow (two rounds of "pick one of three slots"
inline keyboards before falling back to the calendar) was removed
2026-05-07 — landing straight on a peer-aware calendar is strictly
better UX than three separate retries.

- **Server-side slot grid.** When the match enters `negotiating` the
  bot writes **6 consecutive dates** (next 6 days starting tomorrow)
  with **6 time slots per date** into `Match.proposedTimes`: 17:00,
  17:30, 18:00, 18:30, 19:00, 19:30 local. Both users see the same exact
  DateTime allowlist; the public API rejects any submission whose ISO
  isn't on it. Pre-2026-05-10 the grid was 12 slots with Sun/Mon
  pre-skipped; pre-2026-05-11 it was 6 dates at only 18:00; the earliest
  slot was 17:30 until 2026-07-07. The current
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
- **One live post-accept card per side.** Telegram post-accept prompts are
  tracked in `Match.calendarMessageIdA/B`. The same message can move from
  accepted/waiting → Date Ticket → Calendar; new peer proposals and
  counter-proposals edit it in place, falling back to a replacement only if
  Telegram says the stored message is gone. Both cards are removed when a time
  is locked, so repeated scheduling updates do not accumulate identical "Open
  Calendar" messages in the chat.
- **No-overlap-yet ping.** When both sides have submitted but no slot
  is shared, the bot updates the peer's live calendar card with
  `matchSchedulePeerSuggestedAlternative`. This is gated on the actor's
  set actually changing — re-saving the same set is a no-op, so a
  redundant Save cannot ping the peer again. Subsequent reminders also
  rely on the existing scheduling-phase `match-nudge` cadence.
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

Once `agreedTime` is locked, both users are asked for two things, **in
order** — the Telegram opening prompt (`venueConciergeIntro`) asks **only**
for the departure point so "what am I marking on the map?" is unambiguous;
the vibe is a separate, later message requested only after the departure
point is saved:

1. A **departure (commute) origin** — asked **first**, on its own. The
   prompt states plainly that the user marks *where they'll be setting off
   from* for the date and *why* (so the concierge can pick a convenient
   meeting spot easy for both to reach, near that point). Captured via the
   Location Mini App (`apps/webapp/location.html`). The legacy
   `request_location` reply keyboard was retired 2026-05-10 — it doesn't
   work on Telegram Desktop (no GPS) and only supports the user's *current*
   GPS, not "the metro I'll leave from" or "my friend's place tonight". The
   Mini App offers four input modes: one-tap browser geolocation,
   Places-backed autocomplete (type "Lukyanivska metro" or "Khreshchatyk
   14"), tap-on-map, and drag the marker. Stored in `vibeLat{A,B}` /
   `vibeLng{A,B}`; the human-readable label from autocomplete is stored in
   `vibeAddress{A,B}` (display only — the matching pipeline runs on
   lat/lng). Telegram users who share a raw location pin via the attach
   menu still flow through the legacy `handleVenueLocation` path;
   `vibeAddress*` stays null in that case.
2. A free-text **vibe** ("cafe / quiet / vegan / park walk / ..."),
   requested **only after** the departure point is on file, which
   `services/vibe-parser.ts` normalises to a strict whitelist
   (`cafe | restaurant | coffee_shop | park | museum | lounge`). Anything
   outside the whitelist is overridden and audited in `parsedCategoryA/B`.
   Free text that arrives **before** the departure pin is not banked as a
   vibe: `handleVenueVibe` redirects it back to the map
   (`venueLocationFirst`) so the location-first order holds.

**Per-side "what's next" ACK.** The underlying collector stays idempotent —
either field can technically land first (e.g. a mobile submission, or a raw
attach-menu pin) — but the Telegram *prompts* are sequenced, and each save
fires a side-aware nudge so a user doesn't sit there wondering if anything
happened:
- location done, vibe not yet → "Starting point saved ✅ Now — what *vibe*
  are you after? e.g. _quiet cafe_, _park walk_." (text-only, the Mini App
  isn't relevant here). This is the normal next step after the departure pin.
- vibe done, location not yet → "Vibe noted ✅ Now pick where you'll
  be coming from:" + 🗺️ Pick on map inline button (re-surfacing the
  Mini App entry point in the chat). Defensive — the Telegram bot path no
  longer reaches it, but a vibe-first mobile/legacy save still can.
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

Operator-blocked brands are excluded at every venue boundary: curated ranking,
candidate seeding/import, and live Google Places fallback. The Kyiv catalog
currently blocks all Musafir locations. Kyiv's reviewed additions and explicit
rejections are tracked by stable Google `placeId` in
`scripts/curated-venues.kyiv.expansion.json`; `pnpm sync-venues:kyiv` refreshes
their Places metadata before reconciling the replayable approved JSON.

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
The final `scheduled` DM is a compact, structured block — `📍 venue name`,
the full address, then a short (1–2 line) **grounded venue blurb** describing
what kind of place it is. The blurb is generated per-side in the user's
language by `services/venue-blurb.ts` using ONLY real facts (Google's
`editorialSummary`, rating, place category, and the vibe both users asked for)
— never inventing specifics — and degrades to a generic per-language line if
the model is unavailable, so finalization never blocks. The `googleMapsUri`
is **no longer inlined in the body** (it would duplicate the affordance); it
rides the "📍 Open in Maps" keyboard button only, so users still tap to verify
the venue exists, check hours, and pre-plan transit. For **seated** categories
(`cafe`/`coffee_shop`/`restaurant`/`lounge`, not `park`/`museum`) the block also
carries a one-line **busy-venue expectation-setter** (`matchScheduledNoReservation`):
the spot isn't reserved, so if it's packed at peak time it warmly nudges both
sides to grab a coffee and walk or drop into another place nearby (plain text —
the card is sent without `parse_mode`; voice per `VOICE.md`). The parallel safety
reinforcement rides the female-only T-1.5h pre-date safety brief (`safetyNoteFemale`
gains an "if it's crowded, stay somewhere busy and well-lit" bullet). The confirmation also wraps a localized date phrase
(`📅 Sat, 16 May, 19:00`, rendered in `Europe/Kyiv`) in a
**`date_time` MessageEntity** so the whole phrase is a visibly
unmistakable tap target — Telegram does not auto-style `date_time`
entities, so a bare ⏰ glyph reads as a regular emoji on iOS. Tapping
opens the user's local-timezone add-to-calendar sheet via the
entity's `unix_time`.

### 3.7a Date Card (feature-flagged shareable PNG)

Gated by `DATE_CARD_FEATURE_ENABLED` (default **off** → the scheduled
confirmation is the plain-text DM above). Telegram-only in v1. When on, each
side's `scheduled` confirmation is a rendered **PNG date card** (the recipient
sees their *partner*). The look ("Partiful-glow", 2026-06-20; recolored to the
burgundy / black / white design system 2026-07-09; **theme-aware 2026-07-11**)
renders in the **recipient's `User.theme`** — dark (near-black `#030303`,
light ink) or light (cream `#F5F5F5`, dark ink) — with the burgundy (`#8B253B`)
accent, a soft burgundy glow behind the hero photo, and faint film grain on the
dark card only (skipped on the light one). (The two burgundy corner discs were
removed.) It carries
a wide **duotone**-treated venue photo as the hero (the stock Places/curated
image is remapped into the burgundy brand palette so it reads as part of the card), an
overlapping tilted **polaroid** of the partner, a bold Archivo Black headline
**slogan** whose last line is the burgundy accent (`dateCardSlogan`; the brand
voice is intentionally a fixed English line —
"Error 404: Chat not found. Try real life." — across all five locales), the
"Gennety" wordmark top-left, the brand **butterfly** logo (`butterfly-logo.svg`,
shared with the match card) tilted top-right, and the venue name + address. The card
deliberately **omits the
date/time** — the exact slot already lives in the Telegram caption right below,
so repeating it on the card adds nothing and the freed space is spent on a
cleaner keepsake. Rendered server-side with `satori` (→ SVG) + `@resvg/resvg-js`
(→ PNG), with `@napi-rs/canvas` doing the venue duotone and grain tile; the
partner-face blur uses AWS Rekognition `DetectFaces` boxes + pixelation.
Rendered text is emoji-free (the bundled Roboto + Archivo Black fonts carry no
color-emoji glyphs, so all card accents are vector shapes, not emoji); emoji
live only in the Telegram caption.

- **Live render progress.** The render (partner-photo download + Places venue
  photo + rasterize) takes several seconds, so each side sees a per-side
  "shine" status (`dateCardSteps`: confirming details → building the card →
  final touches) while it runs. Unlike the other status beats this is **not** a
  fixed-duration stub — it is held on screen until the PNG is actually ready,
  then torn down before the card lands, so the chat never looks frozen. It is a
  normal edited status line; the render itself never depends on it (§1.3).

- **Two renders, one layout.** The **private** card is sent with
  `protect_content: true` (blocks forwarding / saving / download) and carries
  the same `date_time`-entity caption + Maps / venue-change keyboard, plus a
  **Share** button. Tapping Share re-renders the card with the partner's
  **face blurred** and sends it *without* `protect_content`, so it can leave
  the platform without exposing the partner's identity. (`protect_content`
  does not block OS screenshots in a normal bot chat — only secret chats do —
  so the blurred share copy is the actual privacy guarantee.) The blur
  re-render is slow too — it adds Rekognition `DetectFaces` + pixelation on top
  of the same photo/venue/rasterize work — and the Share tap has no other
  feedback, so it gets its own held "shine" status (`dateCardShareSteps`, a
  star-led 4-beat sequence, uneven cadence) the instant Share is tapped. Like
  the private render it is held `until` the blurred PNG is ready, then torn down
  before the share copy is sent, so the user sees progress immediately instead
  of re-tapping into stacked renders.
- **Privacy fail-safe.** A blur that cannot be produced never falls back to the
  clear original; the share send is aborted and the user is told to retry.
- **Partner photos are forward/save-protected everywhere they appear with a
  clear face.** Both the match-pitch photo card (§3.3, the first place a user
  sees the partner) and the private date card are sent with `protect_content`,
  so the partner's images can't be forwarded, saved, or downloaded out of the
  chat. (OS screenshots still can't be blocked in a normal bot chat — that is a
  Telegram platform limit, not a toggle — so the blurred share copy remains the
  actual off-platform privacy guarantee.)
- **Venue photo.** Curated-first: an operator-owned `CuratedVenue.photoUrl`
  (clean licensing) when present; otherwise the venue's Google Places **cover**
  photo (credited on the card; Google's bytes are fetched at render time and
  never persisted). No photo → a branded gradient backdrop.
- **Never wedges.** Any render/send failure degrades per-side to the existing
  plain-text scheduled card, so one side's hiccup never denies the other their
  card and scheduling always completes.

### 3.7b Venue Change v2 (feature-flagged, paid multiplayer board)

An optional post-schedule step lets the pair swap the auto-assigned venue via
a **shared likes board** — the couple's first joint activity before the date.
Gated by `VENUE_CHANGE_FEATURE_ENABLED` (default **off** → the scheduled-date
DM carries no venue-change button and nothing below fires). Telegram-only.
Implemented as a string sub-state (`Match.venueChangeStatus`: null → `liking` →
`agreed` → `settled` | `lapsed`) layered on a `scheduled` match — like the Date
Ticket and Coordination gates, it adds no `MatchStatus` enum value. The v1
propose/veto flow (female-exclusive, mandatory comment, decline-cancels-match)
was replaced wholesale in 2026-07 before ever launching; design doc:
`VENUE_CHANGE_PRODUCT_SPEC.md`.

- **Entry — no disclaimers.** BOTH sides' scheduled cards carry a passive
  "📍 Change venue" `web_app` button (no proactive "does the venue suit you?"
  question, no hint DM). The board is open from `scheduled` up to
  **T − `DATE_ALERT_HOURS` (T-5h)** — the ice-breaker / emergency cutoff.
- **The board (calendar mechanics, verbatim).** The Mini App
  (`apps/webapp/venue-change.html`, Liquid Glass tokens) opens straight into
  the catalog: the **current venue pinned on top** ("Picked for you" — the
  eternal default that stands whenever nothing settles), then alternatives
  within **`VENUE_CHANGE_RADIUS_KM` (3 km)** of the original venue center,
  **curated-first** with the Places fallback under the production quality gate.
  Each side hearts any number of places (full-set submissions, server-resolved
  against the catalog — client venue data is never trusted); the partner's
  hearts land live (~4 s polling). The FIRST like of a session claims the
  **initiator** (`venueChangeProposerId`) and sends the partner one
  positively-framed, liker-gendered board-invite DM (guarded per recipient).
  **Agreement**: tapping a venue the partner already liked — or a single like
  overlap — agrees instantly; several simultaneous overlaps return an
  `overlapCandidates` list and the actor picks one (initiator-offers /
  responder-decides, exactly like the Calendar §3.6). No free text anywhere —
  no comment channel, so NO IN-APP CHAT needs no carve-out here.
- **Payment (150⭐, `VENUE_CHANGE_STARS`).** A settled change costs one flat
  Telegram Stars price; browsing/liking/agreeing are free and no one pays
  before an agreement, so **no refund path is needed** (the only refund is the
  parallel-pay race below). Payer matrix — **hetero: the man pays, whoever
  initiated**; same-sex: the initiator pays. The finalizer (whoever completed
  the agreement, definitionally the first to see the final screen) resolves it:
  - *he initiated* → he pays "no questions": invoice right in his Mini App if
    he finalized, else a pay-prompt DM with the invoice link;
  - *she initiated, he finalized* → his in-app fork `[⭐ Lock it in]` /
    `[Not this time]`;
  - *she initiated, she finalized* → her fork `[Lock it in myself — ⭐]` /
    `[Ask him to lock it in 💌]`. The offer sends him the **wish card** — the
    date-card layout re-rendered with HER polaroid over the new venue's duotone
    hero (`services/venue-wish-card.ts`, headline "Her pick. Your move.",
    protected; text fallback so the offer never wedges) with pay/decline
    buttons. One offer per session.
  - His "not this time" (wish card button or Mini App fork) is **single and
    final, and ENDS the change**: the session closes, the originally-assigned
    venue simply stands, and she gets a neutral notice (`venueDeclinedKeepDm` —
    no price, no pay button) that never mentions a refusal. She is **never
    pushed to foot the bill** for a change he wouldn't. **While the fork is still
    open** (before he decides) both invoices can be open in parallel — her
    pay-self path and his — and the settle CAS makes the first payment win, with
    `refundStarPayment` returning the Stars of a lost race. `pre_checkout_query`
    re-validates amount + that the swap is still `agreed`, so stale (reusable)
    invoice links are declined before any Stars move (a decline having closed the
    session also invalidates any open link). She never sees a price anywhere in
    the shared flow — the reveal ("{name} covered the venue change ❤️") is part
    of the product.
  - **Express (hers alone, hetero).** On any venue's detail page the female
    gets "⚡ Change right now — 150⭐": a unilateral swap with no agreement.
    The mint stamps the pick (`venueChangeExpressAt`), stays **invisible to the
    partner until paid**, and an abandoned mint quietly reverts to the open
    board after ~30 min. On payment the partner gets the positive-frame
    surprise card ("she picked a cozier spot ✨"). In same-sex pairs express is
    available to either side (the veto asymmetry is hetero-only).
- **Settle.** `successful_payment` is the trust boundary: a status CAS flips
  `agreed → settled`, copies the venueChange\* snapshot onto the canonical
  `venue*` fields (incl. `venuePhotoUrl/Name` so a re-rendered date card shows
  the new venue), and both sides get updated venue cards with the `date_time`
  entity + Maps button — plus the payer-gendered reveal / express surprise.
  One settled change per date: the board then closes (read-only).
- **The way back (`keep-original`).** At any point before a change is paid for,
  either side can say "actually, let's just stay where we were": it withdraws
  that user's marks and, if an agreement was already reached, calls the
  agreement off (the partner gets a neutral `venueKeepOriginalDm`; a cancelled
  *express* mint stays silent, since they never saw it). The original venue was
  never touched, so dropping the change IS the restore. The session stays open
  while the partner still has marks; once neither side has any it retires
  completely. The sticky offer/decline stamps are deliberately NOT reset while a
  session lives, so the way back can't be used to re-nag him with a fresh wish
  card. Surfaced as "Keep this place" on the pinned current venue and as a quiet
  action on the agreed/payment screen — without it, the only exit from an
  unwanted agreement was to let it rot until the lapse below.
- **Lapse — the match is NEVER cancelled.** An `agreed` swap unpaid by
  `min(agreedAt + VENUE_CHANGE_TTL_HOURS (12h), T − DATE_ALERT_HOURS)` lapses
  on the date-lifecycle tick (before ice-breakers): the original venue stands,
  both get a neutral notice, and the board closes. No Elo, no priority comp —
  nothing was lost. The v1 "decline = cancel the match" branch is gone
  entirely, and with it the v1 disclaimer.

## Phase 4 — Date Lifecycle

Driven by `services/date-lifecycle.ts` + `services/pre-date-safety.ts`,
`setInterval` every 2 min. All actions are idempotent via timestamp
columns on `matches`.

| When | Action | Idempotency marker |
|---|---|---|
| Activation → `scheduled` | Generate **wingman hints** (one short imperative tip per side about the other) and persist on the row | `wingmanHintA/B` |
| T − 5 h | Send personalised AI **ice-breakers** (3 starters per side, language-aware, fallback to static lists). For Telegram users the DM is delivered through the native rich AI-compose draft stream (`streamDraftsToChat(..., { rich: true })`, same primitive as the pitch): a "thinking" lead beat (`icebreakerStreamStart`, a `<tg-thinking>` shimmer), each starter revealed one-by-one as growing drafts, then the full set of starters as the plain final `sendMessage` — the emergency-window DM lands right after. Degrades to the classic edited stream when a client can't render rich drafts. Mobile gets the same content via `iceBreakersA/B` (no streaming). | `icebreakersSentAt` |
| T − 5 h | Open the **emergency window** — DM both sides with the cancel button (callback `emerg:start:{matchId}`) | shared with above |
| T − 1.5 h | **Pre-date safety brief** to the female user (Telegram DM only — mobile gets push). Skipped when no female participant has a Telegram presence. | `safetyNoteSentAt` |
| T − 1.5 h | **Wingman hint reveal push** — the asymmetric tip is unmasked at this gate (the mobile serializer enforces it independently) | `wingmanSentAt` |
| T − 1 h | **Pre-date coordination offer** (feature-flagged) — DM the initiator the contact-exchange / anonymous-chat menu (see below) | `coordOfferSentAt` |
| T − 30 min | **Anonymous proxy chat opens** (feature-flagged, Variant C only) — DM both the "Enter chat" button | `proxyOpenedAt` |
| Date moment | (no automated action — users meet in person) | — |
| T + 2 h | **Anonymous proxy chat auto-closes** (feature-flagged) | `proxyClosedAt` |
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

### Pre-date Coordination (feature-flagged)

Gated by `COORDINATION_FEATURE_ENABLED` (default **off**). Solves the "find each
other at the venue / signal a delay" gap. Telegram-only in v1 (offered only when
both participants have a real `telegramId`). Driven by `services/coordination.ts`
on the date-lifecycle tick; handlers in `handlers/date/coordination.ts`.

- **Initiator (T-60m).** ~1h before the date the bot offers the **female**
  participant three ways to coordinate. A same-sex pair with no female
  participant is offered to both sides, and whoever taps first becomes the
  initiator (first-tap-wins; the second tap gets an "already chosen" notice).
  Idempotent via `Match.coordOfferSentAt`.
- **Username-aware menu.** Contact exchange uses a `t.me/<username>` link
  (Telegram gives bots no phone number, and `text_mention` to a stranger is
  unreliable). The captured `User.telegramUsername` therefore gates which
  options appear: **A** only if the initiator has a username, **B** only if the
  partner has one, **C** always. If neither has a username the offer says
  contact exchange isn't possible and only C is shown.
- **Variant A — share my contact.** Initiator reveals her own Telegram; the
  partner is DM'd her `t.me/` link. Single consent (her tap).
- **Variant B — request partner's contact.** Bot asks the partner's consent
  (`coordPartnerConsent`); on **approve** the initiator is DM'd the partner's
  `t.me/` link, on **decline** she's told (and pointed at C). Only B asks for
  partner consent.
- **Variant C — anonymous proxy chat.** Opens **unconditionally** at T-30m
  (no partner consent — an offline partner must never strand the initiator),
  auto-closes at agreed time **+ 2h**. The cron DMs both an **Enter chat**
  button; tapping it sets the `coordination_chat` session state (entry is
  explicit, so normal bot use — `/menu`, settings, photos — is never hijacked
  into the relay). While in the chat, plain text is relayed bot→partner; every
  relayed message carries **Leave chat** + **Report** controls and is logged to
  `ProxyMessage`. Media is rejected (text-only, closes the face/metadata-leak
  bypass). The relay re-checks the window per message, so a stale session
  self-heals after close. See the "NO IN-APP CHAT" carve-out in Core Principles.

### Emergency Protocol

`handlers/date/emergency.ts`:

- Tap → an explicit **confirmation guard** that makes the lower-risk choice
  visually easier: `[Keep the date]` first with native `success` styling, then
  `[Yes, cancel the date]` with native `danger` styling (callbacks
  `emerg:abort:*` / `emerg:confirm:*`). The copy briefly checks for nerves,
  minor lateness, or uncertainty, reminds the user the match already cleared
  time, and states that cancellation is irreversible (the match can never be
  restored). A stray tap on the emergency button is a pure no-op until the red
  path is confirmed. Backing out touches no state and leaves the date on.
- Confirm → `awaiting_emergency_reason` session state.
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
every profile edit, slowly degrading match quality. Initial embedding failures
during either AI-memory analysis or fallback-profile finalization also leave
the profile dirty, so the same worker retries them instead of silently
excluding an otherwise-complete user from matching.

### GDPR

- Account deletion (`/v1/me` `DELETE`, or admin) cascades through Prisma
  (`onDelete: Cascade` on every relation).
- Persona-captured selfies are auto-deleted 90 days after `verifiedAt`
  (`selfie-retention` cron); the user stays `verified`, only the reference
  image is scrubbed.
- `researchOptIn` is opt-in; default false. Audit is via `User.consentedAt`,
  `User.termsAcceptedAt`.

### Languages

`en` / `ru` / `uk` / `de` / `pl` (the `Language` enum and
`SUPPORTED_LANGUAGES`; `en` is the fallback). User-facing strings live in
`packages/shared/src/i18n.ts`, which aggregates `en`/`ru`/`uk` inline plus the
`de`/`pl` blocks from their own modules. Onboarding/menu/Aether agents
auto-detect the user's language and forbid English enum injection into
non-English replies.
