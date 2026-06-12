# Gennety Dating — Pre-Production E2E Test Plan

> Local-only test plan for the `@gennetytestbot` dev bot. Never run any of
> these against `@gennetybot` / production. Test accounts:
>
> - **@gennetysupport** — Telegram ID `5986970093`. Corp-email step skipped via
>   `DEV_OTP_BYPASS_TELEGRAM_IDS`.
> - **@GN01001** — Telegram ID `782065541`. Full real-world flow: corp-email
>   OTP via Resend, Persona hosted KYC, AWS Rekognition face-match.

## Prerequisites

| Check | Command / location |
|---|---|
| Dev bot token set | `.env.local`: `BOT_TOKEN`, `BOT_USERNAME=gennetytestbot` |
| Bypass list populated | `.env.local`: `DEV_OTP_BYPASS_TELEGRAM_IDS=5986970093` |
| OTP console log on | `.env.local`: `OTP_LOG_TO_CONSOLE=true` |
| Persona enabled | `.env.local`: `ENABLE_PERSONA_VERIFICATION=true`, sandbox creds |
| AWS Rekognition | `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` |
| Google Places key | `PLACES_API_KEY` |
| OpenAI key | `OPENAI_API_KEY` |
| Media validation | `ffmpeg -version`, `ffprobe -version`; IAM allows `CompareFaces`, `DetectFaces`, `DetectModerationLabels`; validation flag on, fail-open off |
| JWT secret ≥16 chars | `.env.local`: `JWT_SECRET` |
| Tunnel running | `cloudflared tunnel --url http://localhost:5173`, URL → `WEBAPP_URL` |
| DB reset | `pnpm dev:db:down && pnpm dev:db:up && pnpm dev:db:push` |
| Bot running | `pnpm dev:bot` — confirm `[dev-bypass] DEV_OTP_BYPASS_TELEGRAM_IDS active for: 5986970093` in logs |
| Webapp running | `pnpm dev:webapp` |
| DB inspector | `pnpm dev:db:studio` |

## Dev scripts

```sh
# Force the weekly matching batch right now (no waiting for Thu 18:00 Kyiv).
pnpm --filter @gennety/bot exec tsx scripts/dev/force-match-batch.ts

# Shift a match's time anchors so date-lifecycle gates can be exercised.
pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
  <matchId> agreed -3h        # simulate T-3h: ice-breakers + emergency window
pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
  <matchId> agreed -2h        # T-1h: pre-date safety + wingman reveal
pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
  <matchId> agreed -28h       # T+24h: feedback DM
pnpm --filter @gennety/bot exec tsx scripts/dev/advance-match-clock.ts \
  <matchId> dispatched -25h   # trigger 24h TTL expiry on next /15-min cron
```

---

## Pass 1 — Happy Path

### Phase A — Onboarding @gennetysupport (Telegram ID 5986970093)

| # | Action | Expected | DB / log evidence | OK |
|---|---|---|---|---|
| A1 | `/start` cold | Consent card + ToS button | `User` row created; `email='dev+5986970093@gennety.dev'`; `isEmailVerified=true` | ☐ |
| A2 | Tap consent → Onboarding Mini App opens | Full-screen Mini App: intro, ToS, language; **no** email/OTP screens (bypass) | `termsAccepted=true`, `consentedAt` set; `language` set | ☐ |
| A3 | Tap "Continue" → returns to bot chat | Conversational agent greets in chosen language | `onboardingStep='conversational'`; agent does **not** call `send_otp_email` | ☐ |
| A4 | Agent requests Magic Prompt → paste a real ChatGPT/Claude dump | "Internal monologue" streamed via `sendMessageDraft` while parsing | `Profile.psychologicalSummary` populated; `Profile.embedding` vector(1536) written | ☐ |
| A5 | Agent requests photos → upload ≥ `MIN_PHOTOS` (mix static + 1 Live Photo) | Different same-person photos accepted; exact/cropped copies, other people, multi-person shots, and unsafe photos rejected; Live Photo counts as 1 item | Approved media only in `Profile.photos[]` / `profileMedia[]`; scores aligned | ☐ |
| A5v | Upload safe travel/group video with owner visible in separated moments, then try scenery-only, one-moment cameo, and unsafe QA clip | Sparse owner appearances pass; rejected replacements preserve the accepted video and grant no ticket | Accepted video has validation metadata; no frames/audio/transcript retained | ☐ |
| A6 | Agent collects firstName / age / gender / preference / partnerPreferences | Agent never re-asks once given; no English enum injection in non-English replies | All fields persisted on `User` and `Profile` | ☐ |
| A7 | `finalize_onboarding` → Verification CTA | Two buttons: "Verify now" / "Skip for now" | `onboardingStep='completed'` | ☐ |
| A8 | Tap **Skip for now** | Activation; pinned status banner appears | `verificationSkippedAt` set; `Profile.eloScore=350` (500 − 150 penalty); `User.status='active'`; `statusMessageId` set | ☐ |

### Phase B — Onboarding @GN01001 (Telegram ID 782065541) — full real flow

| # | Action | Expected | DB / log evidence | OK |
|---|---|---|---|---|
| B1 | `/start` cold on @GN01001 | Same as A1 (no bypass) | `User` row, `isEmailVerified=false` | ☐ |
| B2 | Onboarding Mini App → enter real corp `.edu`/`.ac.uk` email → Send OTP | OTP delivered via Resend; same code logged to stdout | `emailOtp` set; `emailOtpExpiresAt` future | ☐ |
| B3 | Enter OTP | Email verified | `isEmailVerified=true`; `universityDomain` set | ☐ |
| B4 | Conversational onboarding: Magic Prompt + photos + profile data | Same as A4-A6. **Choose opposite gender + matching preference** so a match can form with @gennetysupport | All fields persisted | ☐ |
| B5 | `finalize_onboarding` → Verification CTA | CTA shown | `onboardingStep='completed'` | ☐ |
| B6 | Tap **Verify now** → Persona hosted-flow opens in browser → complete liveness | Returns to bot; activation pending Persona webhook | `personaInquiryId` set; `verificationStatus='pending'` | ☐ |
| B7 | Wait for Persona webhook (sandbox) | Pipeline runs: selfie pulled to `SUPABASE_SELFIE_BUCKET`, Rekognition `CompareFaces` against each photo | Log: `[verification-pipeline]` lines; `Profile.photoFaceScores[]` populated 1:1 with `photos[]`; `verificationStatus='verified'`; `verifiedAt` set; `verifiedSelfiePath` set | ☐ |
| B8 | Bot DMs "✅ Verification complete" | Activation; pinned status banner appears | `User.status='active'`; Elo seed via vision pass (if `ELO_VISION_SEED_ENABLED=true`) updates `eloScore` | ☐ |

### Phase C — Menu surface (both accounts)

| # | Action | Expected | OK |
|---|---|---|---|
| C1 | `/menu` | Main menu with `CUSTOM_EMOJI_MENU_ID` title icon | ☐ |
| C2 | My Profile | Shows generated bio + photos | ☐ |
| C3 | Edit Profile | Allows editing non-identity fields; firstName/age/email/universityDomain are **disabled** | ☐ |
| C4 | Pause Matching → Resume | `status` flips `paused` → `active`; status banner reflects it | ☐ |
| C5 | Settings → change language | Language flips; subsequent bot replies switch | ☐ |
| C6 | Wait 1 min → status banner edited | `status-timer` worker live-edits the pinned message | ☐ |

### Phase D — Force match batch

| # | Action | Expected | OK |
|---|---|---|---|
| D1 | Run `pnpm --filter @gennety/bot exec tsx scripts/dev/force-match-batch.ts` | Log: `eligible=2 pairs=1`; one `Match` row inserted with `status='proposed'`; `match_score_logs` row with breakdown | ☐ |
| D2 | Both accounts receive streamed pitch DM | Pitch streamed via `sendMessageDraft`; Synergy score 70–99; deadline 24h; Accept/Decline buttons; **for @GN01001's partner card** (verified by partner), `CUSTOM_EMOJI_VERIFIED_ID` shown next to name in pitch caption | ☐ |
| D3 | Wait 5 min | `proposal-countdown` worker edits "⏳ 23h left" plate | ☐ |

### Phase E — Blind decision + Calendar (happy path)

| # | Action | Expected | OK |
|---|---|---|---|
| E1 | @gennetysupport taps **Accept** | DB: `acceptedByA=true`, status still `proposed`; @GN01001 receives **neutral** `matchPeerDecided` (does NOT reveal accept/decline) | ☐ |
| E2 | @GN01001 taps **Accept** | Atomic transition → `negotiating`; both receive `matchBothAccepted` DM with `MESSAGE_EFFECT_MATCH_ID`; Calendar Mini App button attached | ☐ |
| E3 | Check `Match.proposedTimes` in DB | Array of 30 DateTimes: 6 dates × 5 slots (17:30, 18:00, 18:30, 19:00, 19:30) | ☐ |
| E4 | @gennetysupport opens Calendar → pick 3 slots → Save (MainButton) | Mini App switches to `waiting` state; `availableTimesA[]` length 3 | ☐ |
| E5 | @GN01001 receives `matchSchedulePeerProposed` DM | DM contains button to open Calendar | ☐ |
| E6 | @GN01001 opens Calendar | Peer slots visible as `peer-only` (blue/peer color); polling refreshes ~4s | ☐ |
| E7 | @GN01001 taps one peer-only slot → Save | Single overlap → auto-lock; `Match.agreedTime` set; `Match.status='negotiating_venue'`; both receive vibe-prompt DM | ☐ |

### Phase F — Concierge venue

| # | Action | Expected | OK |
|---|---|---|---|
| F1 | @gennetysupport sends vibe text e.g. "quiet cafe" | `vibeTextA` saved; `parsedCategoryA` normalized to `cafe` | ☐ |
| F2 | @gennetysupport opens Location Mini App → search "Khreshchatyk" → pick result | `vibeLatA`, `vibeLngA`, `vibeAddressA` saved; per-side ACK DM "Location saved ✅ Now tell me the vibe" appears | ☐ |
| F3 | @GN01001 sends vibe text, then opens Location Mini App and drags marker | `vibeTextB`, `vibeLatB/LngB`, `vibeAddressB` saved | ☐ |
| F4 | After 4-th field saves | Google Places `searchNearby` fires; log `[venue]` shows ranked candidates; `venueName`/`venueAddress`/`venueLat`/`venueLng`/`venueGoogleMapsUri` populated | ☐ |
| F5 | Both receive `scheduled` confirmation DM | Contains 📅 phrase wrapped in `date_time` MessageEntity (Kyiv timezone) — tappable on iOS/Android adds to calendar; `googleMapsUri` on its own line is auto-linkified | ☐ |
| F6 | Tap `📅` entity on mobile Telegram | OS calendar sheet opens with the right local date | ☐ |
| F7 | Tap maps URL | Opens Google Maps to the real venue | ☐ |

### Phase G — Date lifecycle (use advance-match-clock.ts)

| # | Action | Expected | OK |
|---|---|---|---|
| G1 | `advance-match-clock.ts <id> agreed -<X>h` to reach T-3h | Within ≤2 min: both receive 3 ice-breakers in language; emergency cancel button appears; `icebreakersSentAt` set; `iceBreakersA/B` arrays saved; wingman hints stored but masked | ☐ |
| G2 | `advance-match-clock.ts <id> agreed -2h` (now T-1h) | Female user receives pre-date safety brief; both receive wingman hint reveal (the asymmetric tip about the other); `safetyNoteSentAt`, `wingmanSentAt` set | ☐ |
| G3 | Female user taps "I read this" on safety brief | `safetyAck{A,B}` set | ☐ |
| G4 | `advance-match-clock.ts <id> agreed -28h` (now T+24h) | Both receive feedback DM with `MESSAGE_EFFECT_FEEDBACK_ID`; two buttons (Open form / Send voice) | ☐ |
| G5 | @gennetysupport → Open feedback form → chemistry slider + Y/M/N + free text → Submit | `Match.feedbackByA` populated; new entries appended to A's `negativeConstraints` | ☐ |
| G6 | @GN01001 → "Send voice instead" → record voice note | Whisper transcribes; same pipeline persists `feedbackByB`; LLM appends negative constraints | ☐ |
| G7 | Check `Match.status` after both feedback submitted | `completed` | ☐ |

**Checkpoint Pass 1:** all 35+ items checked. Any unchecked → fix before Pass 2.

---

## Pass 2 — Edge Cases

After Pass 1: `pnpm dev:db:down && pnpm dev:db:up && pnpm dev:db:push`, redo Phase A+B onboarding (faster the second time), then exercise:

### Decision matrix edges

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-1 | Mixed verdict: A Accept, B Decline | A's reveal is `matchPeerWasDeclined` + priority boost (`standbyCount` incremented); B's ack is plain `matchDeclined`. **No** leak to A before B decides. | ☐ |
| P2-2 | Both decline | Both get `matchDeclined` + reveal AFTER both have committed; `Match.status='cancelled'` | ☐ |
| P2-3 | TTL expiry — ghosted accepted partner: A Accept, B silent. `advance-match-clock.ts <id> dispatched -25h`. Wait next /15-min `expiry` cron. | A receives `matchExpiredYouMissedDate` (asymmetric — mentions "you missed a real date"). B receives standard expiry warning. `Match.status='expired'`. | ☐ |
| P2-4 | TTL expiry — both silent (no accept) | Both receive neutral expiry warning; no "you missed a date" leak | ☐ |
| P2-5 | Forgive-once silence: trigger 2 consecutive silent expiries for same user | 1st expiry: warning only, no Elo change. 2nd: `Profile.silentIgnoreCount=2`, Elo decremented, `MatchEvent` row `EXPIRED_SILENT` | ☐ |

### Nudges

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-6 | Proposal phase nudge 1: dispatch → `advance-match-clock.ts <id> dispatched -4h` → next hourly nudge cron | Nudge DM "your match is waiting" sent; `proposalNudge1SentAt` set | ☐ |
| P2-7 | Proposal phase nudge 2: advance dispatched to `-11h` | Second nudge; `proposalNudge2SentAt` set | ☐ |
| P2-8 | Scheduling nudge: enter `negotiating` then leave calendar unopened 6h+ | `schedNudge1SentAt` set; second at 12h | ☐ |
| P2-9 | Quiet hours: simulate trigger inside 23:00–09:00 Kyiv | Nudge deferred to next 13:00 window | ☐ |

### Calendar / venue edges

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-10 | Calendar 0-overlap: A picks slots 1+2, B picks slots 4+5 → both save | Both receive `matchScheduleNoOverlapYet`; gated on actor's set actually changing (re-save same set = no-op) | ☐ |
| P2-11 | Calendar multi-overlap: A picks slots 1+2+3, B picks 2+3 → B saves | `overlapCandidates: [s2, s3]` returned to B; Mini App shows confirm card; tap one → auto-lock | ☐ |
| P2-12 | Venue strict gate: bias `vibeTextA='fancy expensive lounge'` | Strict tier fails (price); relaxed tier (step 2) catches it; venue picked | ☐ |
| P2-13 | Venue: confirm a known-closed place isn't returned | Picked venue has `businessStatus=OPERATIONAL` | ☐ |

### Emergency + reports

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-14 | Emergency cancel: in `scheduled` state, A taps "🚨 Cancel date", types verbatim reason | B receives DM with verbatim text as blockquote + soft Gennety note; `Match.status='cancelled'`; `emergencyCancelledBy=A`; `emergencyReason` matches input exactly; B's `eloScore += 5` (peer boost); A is **not** penalised | ☐ |
| P2-15 | Report Tier 1 (preference): "they were vegan and I'm not" | LLM tier=1; new constraint appended to **reporter's** `negativeConstraints`; reported user untouched | ☐ |
| P2-16 | Report Tier 2 (ethical): "showed disrespectful behavior" | LLM tier=2; reported `strikes=1`; warning DM | ☐ |
| P2-17 | Trigger Tier 2 again on same reported user | `strikes=2`; `status='suspended'`, `suspendedUntil=now+14d`; in-flight matches cancelled | ☐ |
| P2-18 | Report Tier 3 (safety): explicit safety threat | LLM tier=3; reported `status='pending_investigation'` immediately; in-flight cancelled; `Report.adminReviewed=false` | ☐ |
| P2-19 | Duplicate report by same reporter on same match | Second report rejected; user sees `reportDuplicate` | ☐ |
| P2-20 | Suspended user expires (`suspendedUntil` in past) → wait hourly `autoUnsuspendElapsed` cron | Reactivated to `active` within the hour | ☐ |

### Verification rerun

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-21 | @GN01001 (verified) deletes one photo | `verificationStatus='pending'`; pipeline reruns; new `photoFaceScores[]` aligned with new `photos[]` | ☐ |
| P2-22 | @GN01001 uploads a no-face photo (e.g. scenery) | Pipeline bucketed as `no_face` (excluded from quorum); status still `verified` if quorum holds | ☐ |
| P2-23 | @GN01001 uploads a photo of someone else's face | At least one `fail` score → `verificationStatus='rejected'` (impostor rule trumps quorum) | ☐ |
| P2-24 | While pipeline runs, user edits photos again | Stale scores discarded (gated on photo array snapshot); no `photos[i] ↔ photoFaceScores[i]` misalignment | ☐ |

### Pool / matching invariants

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-25 | After a `cancelled` or `expired` match between A & B, force-match-batch again | A & B NOT re-paired (lifetime ban via `matches_pair_canonical_idx`) | ☐ |
| P2-26 | Set one account `status=paused` then force batch | Paused user excluded from candidates | ☐ |
| P2-27 | `verificationStatus='pending_review'` user → force batch | Excluded from candidates regardless of `User.status` | ☐ |
| P2-28 | `unverified` (skipped Persona) user → force batch | Included; carries `UNVERIFIED_ELO_PENALTY` | ☐ |

### Embeddings / freshness

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-29 | Edit Profile → change hobbies | `embeddingDirty=true`, `embeddingDirtyAt` set | ☐ |
| P2-30 | Wait ≤5 min for `embedding-refresh` cron | `embeddingDirty=false`; new embedding written | ☐ |

### Re-engagement chain

| # | Scenario | Expected | OK |
|---|---|---|---|
| P2-31 | Fresh `/start`, tap consent, then ignore the bot 15 min | Step-1 re-engagement DM at +15m; `reEngagementStep` advances 0 → 1; `reEngagementNextAt` set for +2h | ☐ |
| P2-32 | Reply at any point during chain | `reEngagementNextAt=null`, `reEngagementStep` reset | ☐ |
| P2-33 | Reach `onboardingStep='completed'` | `reEngagementNextAt` nulled permanently | ☐ |

---

## API + Mini App spot-checks (run in parallel with UI)

| # | Check | Command / location | OK |
|---|---|---|---|
| API-1 | Public API up | `curl http://localhost:3101/v1/ping` → `{"ok":true}` | ☐ |
| API-2 | Calendar state poll | DevTools Network on Mini App: `GET /v1/calendar/state` every ~4s, 200 OK | ☐ |
| API-3 | Calendar pick response | `POST /v1/calendar/pick` body contains `mySlots`, `peerSlots`, `bothPicked`, and one of `agreedTime` / `overlapCandidates` | ☐ |
| API-4 | Location autocomplete debounce | Type 1 char → no request; type 2 chars → request after 350ms; rapid typing → only last request fires | ☐ |
| API-5 | Public API auth | `curl /v1/me` without JWT → 401 | ☐ |
| API-6 | Admin API auth | `curl localhost:3100/admin/audience` without bearer → 401; with bearer → 200 | ☐ |
| API-7 | Persona webhook HMAC | Replay webhook with bad signature → 401/403; with valid signature & known inquiry → idempotent (rerun has no effect) | ☐ |

## External service validation summary

| Service | What we asserted | OK |
|---|---|---|
| OpenAI (onboarding agent) | Tool-loop respects forbidden combos (no `request_photos` in same turn as `request_context_dump`); language matched | ☐ |
| OpenAI (embeddings) | `vector(1536)` written after dump | ☐ |
| OpenAI (Whisper) | Voice OTP / dump / feedback transcribed | ☐ |
| OpenAI (vision Elo seed) | `eloScore` updated post-verification when `ELO_VISION_SEED_ENABLED=true` | ☐ |
| Persona | Hosted flow completes; webhook HMAC verified; idempotent | ☐ |
| AWS Rekognition | Admission uses `CompareFaces`, `DetectFaces`, and `DetectModerationLabels`; `photoFaceScores[]` remains 1:1 with `photos[]`; thresholds 0.85/0.75 applied | ☐ |
| Google Places (New) v1 | Picked venue: `businessStatus=OPERATIONAL`, rating ≥4.0, ≥30 reviews, price tier ≤MODERATE for food | ☐ |
| Resend | OTP email arrived at @GN01001's corp address | ☐ |
| Supabase Storage | Selfie in `SUPABASE_SELFIE_BUCKET`; signed URLs work; 90-day retention scrub cron is scheduled | ☐ |

---

## Notes / discovered issues

(Fill during execution.)

| # | Phase | Issue | Severity | Status |
|---|---|---|---|---|
|   |   |   |   |   |
