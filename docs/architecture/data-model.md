<!-- WHEN_TO_READ: You are adding, changing, or reading a PostgreSQL/Prisma table, enum, or column, or you need to know which subsystem owns a piece of data. Contains every table definition (users, matches, events, ledgers, venues, ...). Grep for the table name rather than reading top to bottom. -->
<!-- SOURCE: ARCHITECTURE.md (lines 165-1605) — migrated 2026-09-01 -->

## Data Models (PostgreSQL + Prisma)

Source of truth: [`packages/db/prisma/schema.prisma`](../../packages/db/prisma/schema.prisma).
This section is an architectural map, not a manually authoritative schema dump;
when columns diverge, Prisma wins.

### Enums

| Enum | Values |
|---|---|
| `UserStatus` | `onboarding`, `active`, `paused`, `frozen`, `suspended`, `pending_investigation`, `banned`. User-owned changes go only through `services/account-status-transitions.ts`: CAS `active ↔ paused`, transactional `active|paused → frozen`, and CAS `frozen → active`; moderation-owned states cannot be overwritten. Freeze commits match cancellations atomically before external partner effects. |
| `Language` | `en`, `ru`, `uk`, `de`, `pl` |
| `OnboardingStep` | `consent`, `language`, `conversational`, `completed` |
| `Theme` | `light`, `dark` — the EFFECTIVE app-wide UI theme; `dark` is the brand default. Two-valued on purpose: a server-rendered PNG card has no "follow the device" to follow |
| `ThemeMode` | `system`, `light`, `dark` — how that theme was CHOSEN. Exists because the native iOS picker offers the platform-standard third state; `system` never reaches a renderer, the client resolves it and reports the result in `theme` |
| `Gender` | `male`, `female` |
| `GenderPreference` | `men`, `women`, `both` |
| `Platform` | `telegram`, `mobile`, `both` |
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
| Identity | `id`, `telegramId` (unique BigInt — synthetic **negative** id for mobile-only users), `telegramUsername` (public `@handle`, captured opportunistically for `t.me/` coordination links), `email`, `universityDomain`, `firstName`, `surname`, `age`, `gender`, `preference`, `major`, `language`, `platform`. `id` is the only immutable identity: `telegramId` is **re-pointable** by the phone-based login (`services/account-linking.ts`) — a `User.phone` unique collision transfers the sharing Telegram account's id/username onto the row that owns the number, deletes the empty registration row it came from, promotes `platform` `mobile` → `both`, and clears the now-stale `statusMessageId`. Anything caching a `telegramId` must resolve through the DB rather than assume permanence. **A positive `telegramId` no longer implies the bot can message that user (2026-08-02).** `POST /v1/auth/telegram` stores the REAL Telegram id on an app-only account, and a bot cannot initiate a chat with someone who never pressed Start — so `platform` is the only canonical reachability check, and a `telegramId: { gt: 0 }` filter must be paired with `platform in (telegram, both)`. `workers/profiler.ts` and `workers/re-engagement.ts` were filtering on the id alone and are fixed; such a row is promoted to `both` when it actually starts the bot. |
| Lifecycle | `status` (`UserStatus`), `onboardingStep`, `aiMemoryExportPreference`, `aiMemoryExportPreferenceAt`, `hasConsented`, `consentedAt`, `termsAccepted`, `termsAcceptedAt`, `policyVersion`, `researchOptIn`, `createdAt`, `updatedAt`. `policyVersion` records WHICH version of the Terms + Privacy Policy was accepted (`LEGAL_DOCS_VERSION` from `packages/shared`), because GDPR Art. 7(1) puts the burden on us to demonstrate what was agreed to and a timestamp alone cannot once the documents change. Null for consents recorded before 2026-08-01. |
| UI theme | `theme` (`Theme`, default `dark`) — the EFFECTIVE light/dark theme, honored by every Mini App (via the shared `theme.css` tokens) and both server-rendered PNG cards. `themeMode` (`ThemeMode`, default `dark`) records how it was picked: the bot's two-state toggle writes mode = theme, the iOS picker can also write `system`, and then the client keeps `theme` in step with the phone by re-PATCHing on every appearance flip — that re-report is the only reason a Telegram card matches an app set to follow the device. `themeChosenAt` marks the explicit pick (stamped by iOS too) so the onboarding theme step shows once. |
| Email OTP | `emailOtp`, `emailOtpExpiresAt`, `isEmailVerified` |
| Registration v2 | `phone` (unique E.164, written from a trusted Telegram `message.contact` or a verified native-app code), `phoneVerifiedAt` (the general-track contact gate), `registrationTrack` (`student`/`general`, null = pre-fork legacy). Matching admits the union of track-valid cohorts: `general + phoneVerifiedAt`, or `student`/legacy + `isEmailVerified` and a stored email. `phone` is also the **cross-rail login key**: both rails resolve an existing account through it — the mobile side in `findOrCreateMobileUserByPhone` (`public/mobile-user.ts`, which also promotes `telegram` → `both`), the Telegram side in `services/account-linking.ts` (PRODUCT_SPEC §1.1). A collision where both the sharing row and the owning row carry real data is the one case neither rail resolves automatically. |
| Conversational state | `messageHistory` (`Json[]`), `lastMessageAt`, `lastPreMatchAnnounceAt`. AI-memory response bodies are deliberately not retained here: a typed `context_dump` is replaced by a non-sensitive receipt marker after parsing, and on the legacy tool-loop path the advisory `raw_dump` tool argument is stripped from the persisted assistant turn for the same reason. |
| Re-engagement | `reEngagementStep` (0–5), `reEngagementNextAt` |
| Trust & safety | `strikes`, `suspendedUntil` |
| Telegram UI | `statusMessageId` (pinned banner) |
| Push (mobile) | `pushToken`, `pushPlatform` |
| Verification | `biometricConsentAt` / `biometricConsentVersion` (explicit Art. 9(2)(a) consent, captured on its own screen; `beginLivenessCheck` refuses to mint a session without it, so the gate is server-side and both clients are bound by it), `verificationStatus`, `personaInquiryId` (unique), `verifiedAt`, `verificationSkippedAt`, `verifiedSelfiePath`, `faceMatchScore`, `faceMatchedAt`, `selfiePath` (legacy). Matching admits only `verified` plus the persisted pre-flip cohort (`unverified` with non-null `verificationSkippedAt`). `personaInquiryId` keeps its historical name but now holds the AWS Face Liveness session id (the provider swap was deliberately schema-free); it stays the `(session, faceMatchedAt)` idempotency marker. `pendingLivenessSessionId` is deliberately a SEPARATE column: it holds the session currently in flight (written at `/init`, cleared at a terminal outcome) purely so `completeLivenessCheck` can refuse a client-supplied session id the user did not mint. It cannot be folded into `personaInquiryId`, which means "the session that produced the stored reference selfie" and is what `triggerVerificationRerun` reruns against — a not-yet-completed session must never land there. Production-like startup fails closed unless liveness is enabled and configured (AWS credentials + `LIVENESS_STS_ROLE_ARN`), verification is mandatory, and Rekognition/profile-media validation are enabled — there is no sandbox escape hatch any more. |
| Attribution | `referralSource` (`tg:start_param` / `mobile:utm=…` / `referral:USER_ID`) |
| Tickets (feature-flagged) | `ticketBalance` — materialized ticket-wallet balance; running sum of `TicketLedger.delta` (see `ticket_ledger`). `ticketDiscountPct` / `ticketDiscountGrantedAt` / `ticketDiscountExpiresAt` / `ticketDiscountConsumedAt` — one-time famine single-ticket discount (PRODUCT_SPEC §3.5b; active ⇔ `pct > 0 AND consumedAt IS NULL AND expiresAt > now`), owned by `services/ticket-discount.ts`. `ticketDiscountSource` (`famine` | `event_feedback`) names WHICH mechanism filled that one slot — analytics only, never read by pricing; see `event_feedback`. |
| Premium (feature-flagged) | `premiumUntil` / `premiumSince` / `premiumProvider` (`telegram_stars`\|`app_store`\|`referral`) / `premiumAutoRenew` / `premiumExternalId` — Gennety Premium subscription head (PRODUCT_SPEC §3.8 / §Premium). Materialized from the append-only `subscription_ledger`; active ⇔ `premiumUntil > now`. `premiumExternalId` is the recurring anchor (Stars charge id / App Store `originalTransactionId`) used to reconcile renewals + find the owner from a webhook. Owned by `services/premium.ts`; inert-to-write unless `PREMIUM_FEATURE_ENABLED`, but an existing entitlement is honored regardless of the flag. `provider: "referral"` marks a complimentary comp grant (`grantComplimentaryPremiumMonths`) that never sets an auto-renew anchor. | `premiumReminder3dAt` / `premiumReminder1dAt` are the expiry-reminder once-markers (PRODUCT_SPEC §3.8): the 3-day and 24-hour DMs are sent at most once per PAID PERIOD, so every path that advances `premiumUntil` clears both — otherwise a renewing user is warned once in their life and every later period lapses in silence. Set for BOTH reminder cohorts (PRODUCT_SPEC §3.8): a non-auto-renewing entitlement whose access really is ending, AND a live recurring Telegram Stars subscription, which is warned that the coming charge is taken from the Star balance with no card fallback. (Until 2026-08-24 this was non-renewing only, which left the recurring cohort — the one that can actually lose a subscription to an empty balance — with no warning at all.) A recurring **App Store** subscription is still never marked: Apple runs its own billing retry and there is no Star balance to top up, so neither message is true for that rail. One pair of markers serves both cohorts because they are mutually exclusive at any instant (`premiumAutoRenew` true vs false). Swept by `workers/premium-expiry-reminder.ts` off `@@index([premiumUntil])`, which exists because that hourly sweep asks one question of the whole table and the column is null on most rows. **`activateOrExtendPremium` may only ever EXTEND `premiumUntil`** (a `max()` against the stored value): a monthly subscriber who buys a 3/6-month package holds an expiry months out, and their next 30-day renewal carries an earlier one — writing it through would delete the package they just paid for. `revokePremium` stays the one path allowed to shorten it.
| Referral (feature-flagged) | `referralVerifiedCount` (referrer's materialized tally of invited friends who cleared verification — the milestone-ladder progress), `referralCountedAt` (invitee-side once-marker: this user was already counted toward their referrer, CAS null→now), `referralInviteePremiumAt` (invitee-side once-marker for the welcome Premium month). Referral program (PRODUCT_SPEC §3.9 / `REFERRAL_PRODUCT_SPEC.md`), owned by `services/referral.ts`; rewards themselves live in `ticket_ledger` (`referral_milestone`) + `subscription_ledger` (`referral`). Inert unless `REFERRAL_FEATURE_ENABLED`. |
| Promo (feature-flagged) | `promoRedeemedAt` — once-marker for the promo welcome gift's wow screen + grant guard. Independent promo-code program (PRODUCT_SPEC §3.10 / `PROMO_CODES_PRODUCT_SPEC.md`), owned by `services/promo.ts`; attribution reuses `referralSource` as `promo:<CODE>` (mutually exclusive with `referral:*`); the reward lands exactly-once in `PromoRedemption` + `ticket_ledger` (`promo`) + `subscription_ledger` (`promo`). Inert unless `PROMO_FEATURE_ENABLED`. |
| Synthetic test profile (temporary) | `syntheticAt` — non-null on a seeded stand-in used to balance the gender skew during the friends-and-family production test (PRODUCT_SPEC §3.1c). One marker, three consequences, and each is enforced at exactly one place so a new caller inherits it: `buildCandidateSql` excludes it (keeping every single-seeker path — the paid Rematch, the §3.1b auto-resume probe — from ever surfacing one); `updateEloScores` no-ops on a pair carrying it; the admin classifier files the account as `test`. Written only by `scripts/seed-synthetic-profiles.mjs` via `services/synthetic-profiles.ts`, never by the running product, and null on every real account — so with no seeded rows the whole mechanism is unreachable regardless of `SYNTHETIC_FILL_ENABLED`. Such a row is `platform: "mobile"` with a negative `telegramId` in the `-778_000_00x` band and **no phone or email**: `registrationTrack: "general"` + `phoneVerifiedAt` satisfies the contact rail on its own, and a fake number would squat on `User.phone`'s unique index forever. |

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

### `onboarding_step_events`

Append-only onboarding funnel telemetry (one row per step transition), written
best-effort from the collector's post-commit path in
`services/onboarding-analytics.ts` — never inside the save transaction, so a
telemetry failure can't abort a user's onboarding. Columns: `userId`, `step`
(an `ONBOARDING_QUESTIONS` key or `verification`), `kind`
(`asked`/`answered`/`skipped`), `dwellMs` (hesitation on the step = the gap
since its latest `asked`; null on `asked` rows), `language`, `platform`,
`createdAt`. Stores **only** the step key, its outcome, and timing — never the
user's answer text. Drop-off is derived, not stored (a still-`onboarding` user
whose latest `asked` step has no matching resolution is stuck there). Indexed
`(userId, createdAt)` and `(step, kind, createdAt)`; `onDelete: Cascade` from
`users`. Powers `GET /admin/analytics/onboarding-funnel`.

### `profiles` (1:1 with `users`)

Columns (≈ 25):

| Group | Columns |
|---|---|
| Demographics | `userId` (unique), `height`, `hobbies` (`String[]`), `partnerPreferences`, `psychologicalSummary` (redacted signal-only AI-memory summary or onboarding fallback; never the raw pasted export), `negativeConstraints`, `ageRangeMin`, `ageRangeMax` (stated preferred-**partner** age band, user-editable post-onboarding; read by the match engine as the soft `V_agePref` multiplier — see [PRODUCT_SPEC.md](../product/product-spec.md) §3.2) |
| Vector | `embedding` (`vector(1536)`), `embeddingDirty`, `embeddingDirtyAt` |
| Elo | `eloScore` (default 500), seeded from the server-side mean of all per-photo vision scores; `eloMatchesPlayed`; `eloSeededAt`; auditable aggregate/per-photo output in `eloSeedDetails` |
| Photos | `photos` (`String[]` of static Telegram `file_id` or Supabase path), `profileMedia` (`Json[]` structured display media; empty legacy rows normalize from `photos[]`), `referenceFaceEmbedding` (`Json?` legacy self-photo identity-anchor metadata — retained, no longer written by the upload flow since identity moved to liveness-only, 2026-06-23), `uploadedPhotoHashes` (`String[]`, strictly 1:1 with `photos`; perceptual hash or `""` sentinel at every index), `pendingPhotoCandidates` (`Json[]` legacy consensus pool — retained, no longer written), `acceptedPhotoCount` (`Int`), `photoFaceScores` (`Float[]`, 1:1 with `photos`) |
| Geo / radius | `matchRadius` (`campus_only` / `citywide`), `homeCity`, `homeCountryCode`, `homeCityKey`, `homePlaceId`, `latitude`, `longitude`, `locationUpdatedAt`, `timeZone` (IANA, derived from the dating city; drives the Profiler's local-time batch windows). `homeCityKey` must be a **launched market** (`packages/shared/src/markets.ts`; PRODUCT_SPEC §1.3) — `validateHomeLocationPayload` (`public/home-location.ts`) is the single writer and canonicalizes name + coordinates from the market, so Telegram and the `/v1/*` API are gated by one check. Rows created before that gate keep their city and are offered a one-tap move (`handlers/menu/city-switch.ts`). A city the picker offers but we have NOT launched never reaches this column at all — it becomes a [`city_waitlist_entries`](#city_waitlist_entries-11-with-users) row instead. |
| Match priority | `lastMatchedAt`, `missedWeeks`, `standbyCount`, `lastMissedAt`, `silentIgnoreCount`, `starvationPausedAt` (nullable; stamped only by the D10 pool-exhaustion auto-pause — `services/pool-exhaustion.ts` — never by an ordinary user-chosen menu pause, so `autoResumeStarvedUsers` only ever probes accounts it paused itself; see PRODUCT_SPEC.md §3.1b) |
| Profiler (Phase 1b) | `profilerStartedAt`, `profilerNextAt`, `profilerActiveQuestionId`, `profilerBatchRemaining`, `profilerAnswerWindowUntil`, `profilerQuestionMessageId` — scheduler + capture state for the post-onboarding Q&A batches that fuel icebreakers/hints (see [PRODUCT_SPEC.md](../product/product-spec.md) §Phase 1b). `profilerActiveQuestionId` is the concurrency token: every answer/skip claims it with a compare-and-set, so exactly one reply resolves a question. `profilerNextAt` is dual-purpose — the next batch window while idle, and the **stall deadline** of the question currently in flight (6 h), which is what lets the worker reclaim a question the user never answered. `profilerAnswerWindowUntil` is the much shorter (90 min) deadline for *implicitly* treating plain text as that question's answer; it is cleared the moment the user does anything else, so an active question can never swallow an unrelated message meant for the menu agent. `profilerQuestionMessageId` anchors the question message, so an explicit Telegram reply is still recognised after the window closed, a resolved question can have its Skip keyboard stripped, and a question reclaimed as an implicit skip can be **deleted** — otherwise a dead question keeps sitting in the chat inviting an answer nothing can route (PRODUCT_SPEC §Phase 1b). Indexed `@@index([profilerNextAt])` for the worker sweep. |
| Relationship intent | `relationshipIntents` (`String[] @default([])`, whitelist-validated in app code — NOT a Prisma enum, mirroring `socialRole`, so a fifth point on the axis costs no migration). Zero or more ordered values out of `spark` \| `open` \| `falling` \| `longterm` (`@gennety/shared` `relationship-intent.ts`), picked on the last of the Mini App's own profile screens. **An ARRAY rather than a single value** (founder decision 2026-08-26): people who want a bright story and would also go somewhere serious were being made to guess which half to declare. `normalizeIntents` is the only writer's gate — it dedupes, sorts into axis order, and accepts a bare string, so the chat and the `/v1/*` rail (which answer with exactly one value) need no change and a row is never stored in two orders. Read by the soft `V_intent` multiplier and by nothing else, which is what two rules ride on: it deliberately does **not** feed the embedding (through `psychologicalSummary` it would arrive at `V_explicit`'s weight 0.65 — the strongest term, the opposite of its purpose — and be wiped by the next About-me edit), and it is **never shown to the partner** (owner-only in My Profile with a "only you can see this" line; absent from the pitch and from `SerializedMatch`). Empty on legacy rows and on any client without the screen; `intentMultiplier` returns exactly 1.0 when EITHER side is empty, and scores two sets by the SMALLEST gap between them, so any overlap is neutral. See [PRODUCT_SPEC.md](../product/product-spec.md) §1.3 / §3.2. |
| Vibe (matching) | `fridayVibeText`, `vibeFocusText` (raw onboarding §1.3 answers), `energyAxis` / `orientationAxis` (`Float?` `[-1,1]`, scored by `V_research` quadrant proximity), `socialRole` (`String?` initiator/participant/observer — whitelist-validated in app code, **stored but not scored** in v1), `anchorTags` (`String[]`), `vibeExtractedAt`. Written at finalize by `services/vibe-axes.ts`; the raw Friday text is also folded into `psychologicalSummary`. See [PRODUCT_SPEC.md](../product/product-spec.md) §1.3 / §3.2. |
| Audit | `createdAt`, `updatedAt` |

### `city_waitlist_entries` (1:1 with `users`)

One person waiting for Gennety to open in their city. Written by the waitlist
branch of `POST /v1/telegram-onboarding/city/select`; read by the Mini App's
routing, the bot's `/start` card, and the admin waitlist view.

| Column | Notes |
|---|---|
| `userId` | `@unique`, `onDelete: Cascade`. One row per person: re-picking replaces the city, picking a launched market deletes the row. |
| `cityKey` | Canonical `<country>:<slug>`, validated against `WAITLIST_CITIES` before the write (`public/city-waitlist.ts`). Indexed with `createdAt`. |
| `city`, `countryCode` | Frozen from the catalog at join time, so the admin view reads without resolving keys and a later rename cannot rewrite what the person actually chose. |
| `createdAt`, `updatedAt` | Audit. |

**Why a separate table and not a flag on `profiles`.** `homeCityKey` is the hard
matching boundary — `buildCandidateSql` joins on an exact equality — so a
waitlist key sitting there would eventually pair the second person waiting in
Berlin with the first, for a date in a city with no curated venues, no ads and
no ops. Two different tables make that impossible rather than merely
discouraged; `validateHomeLocationPayload` still refuses every unlaunched city,
unchanged. The two are mutually exclusive by construction: `/city/select` clears
one when it writes the other.

**Not a queue.** No worker, no position, no ordering promise. The "you'll be
first" line on the waitlist screen is copy about intent; what exists is one row
per person per city, which is the demand signal behind "which market opens
next". Do not add a priority column without a product decision that says what it
would mean.

Not to be confused with [`waitlist_applications`](#events--waitlist_applications),
which is event admission and has nothing to do with cities.

### `matches`

Columns (≈ 40). Drives the entire matching → scheduling → date lifecycle. See
[PRODUCT_SPEC.md](../product/product-spec.md) §3–4 for the state machine.

Application invariant: a user occupies at most one live row across `proposed`,
`negotiating`, `negotiating_venue`, and `scheduled`. (One exception, and it is
not reachable in production: the demo puppet is excused from it, because it is a
prop shared by every visitor rather than a person who can be double-booked —
DEMO_MODE.md → "The guarded branches in production code".) Eligibility queries exclude
both match relations, and `createProposedMatch` locks both user rows in sorted
order before re-checking and inserting. If legacy/corrupt data contains several
live rows, all current-match surfaces choose explicitly by product progression:
`scheduled` → `negotiating_venue` → `negotiating` → `proposed` (newest wins ties),
never by PostgreSQL enum declaration order.

| Group | Columns |
|---|---|
| Identity | `id`, `userAId`, `userBId`, `status` (`MatchStatus`), `createdAt`, `updatedAt` |
| Pitch & synergy | `pitchForA`, `pitchForB`, `synergyScore` (pair-level, clamped 70–99), `synergyReason` / `synergyReasonB` (the 1–2 sentence rationale, stored **per side in that side's own language** like the pitches — `synergyReason` is A's, kept under the original name for legacy rows + the founder report; a null `synergyReasonB` falls back to A's at render. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.3) |
| Decision (blind invariant) | `acceptedByA`, `acceptedByB` (tri-state `null`/`true`/`false`), `rejectionReasonA`, `rejectionReasonB`, `dispatchedAt`, `pitchMessageIdA`, `pitchMessageIdB`. **`dispatchedAt` is load-bearing far beyond the TTL it names:** the expiry sweep, the countdown worker and both nudge cadences all filter `dispatchedAt: { not: null }`, so a `proposed` row that keeps it null is invisible to every one of them at once while still occupying both participants' single live-match slot — i.e. both users silently leave the matching pool for good (production held one such row for 123 hours). `services/dispatch-queue.ts` → `disposeUndeliveredMatch` is what guarantees a dispatch attempt never leaves that state: a pitch on record for either side starts the TTL, a pitch that reached nobody retires the row. Anything that creates a `proposed` match must go through that queue (all three creation paths — drop batch, demo driver, paid Rematch — do). |
| Peer-wait shimmer (§3.6b) | `peerWaitMessageIdA/B` + `peerWaitEditedAtA/B` — the FALLBACK line only, for clients that cannot render a `<tg-thinking>` draft. The rich path needs no column: the draft is ephemeral and simply stops being re-issued when the wait ends. The fallback is a real message that must be edited as the wording climbs and deleted when the wait ends, so its id has to survive a PM2 restart — an in-memory map would strand a permanent "waiting for them…" line in the chat after any deploy. `peerWaitStartedAtA/B` is the **per-side wait anchor** the five-tier wording ladder is measured from; nothing else in the row answers "how long has this side been waiting" (`acceptedByA/B` are booleans, `availableTimesA/B` carry no submission time, `updatedAt` moves for unrelated reasons). All four are written only by `workers/peer-wait-shimmer.ts` — single-writer on purpose, so the action handlers that kick off a shimmer cannot race it; they render tier 1 unconditionally, which is true by construction since they fire the instant the user commits. The anchor is RELEASED when a wait ends, so a later wait on the same match restarts at tier 1 instead of opening on the 24h deadline copy. |
| Prime Time (feature-flagged) | `primeTimeUnlockedAt`, `primeTimePaidById` — the paid evening band (§3.6). Scoped to the MATCH rather than to a user, and that is forced rather than chosen: a date locks when the two availability sets intersect, so a pass that opened the band for one side would buy nothing. Written by the `successful_payment` settle, and ALSO — without money moving — the first time a premium user marks a prime slot (`shouldPersistUnlock`), so a subscription lapsing before the date cannot re-lock a slot the pair already agreed on. `primeTimePaidById` is null for a band opened by a subscription, which is what tells the §9.1 refund there is nothing to return. |
| Calendar scheduling | `proposedTimes` (`DateTime[]`, server-side allowlist of valid slots: 6 dates × 14 slots/date, every 30 min from 13:00 to 19:30 — also the "is the calendar actually open?" signal the peer-wait predicate reads, since `ticketStatus` defaults to `pending` even with tickets off), `availableTimesA`/`availableTimesB` (`DateTime[]`, each side's marked availability), `agreedTime` (set after a single exact overlap is agreed; multi-overlap is confirmed in the Mini App), `calendarMessageIdA/B` (current Telegram post-accept CTA per side: accepted/waiting, then Calendar — **never** the Date Ticket card, which is a separate untracked message; edited on status changes and cleared after agreement. An in-place edit is only correct while the tracked card is still the newest message in the chat: a counter-proposal and the post-ticket-gate Calendar both delete and resend instead, because Telegram edits raise no notification and both land under newer messages — PRODUCT_SPEC §3.6 / §3.5b). `schedulingIteration` and `pickedTimeA/B` are deprecated — retained for backwards-compat with in-flight rows mid-deploy and will be dropped in a follow-up cleanup migration. |
| Concierge venue | `vibeTextA`, `vibeTextB`, `vibeLatA/LngA`, `vibeLatB/LngB`, `vibeAddressA/B` (Mini App map-picker label), `parsedCategoryA`, `parsedCategoryB`, `venueName`, `venueAddress`, `venueLat`, `venueLng`, `venueGoogleMapsUri`, `venuePhotoName` (the single venue-imagery source: a Google Places photo resource name, rebuilt to a media URL at date-card render with the server-side key, never persisting Google's bytes; curated venues get theirs resolved from their stored `placeId` at assignment via `fetchPlacePhotoName`), `venuePhotoUrl` (**retired 2026-07-25**, no longer read/written), `venuePromptAskedAt` |
| Date lifecycle | `icebreakersSentAt`, `iceBreakersA`/`B` (`String[]`), `safetyNoteSentAt`, `safetyAckA`/`B`, `wingmanHintA`/`B`, `wingmanSentAt`, **`terminalInviteSentAt`** / **`terminalReminderSentAt`** (nullable; `terminal_invite_sent_at` / `terminal_reminder_sent_at`, 2026-09-11 — exactly-once markers for the Telegram Date Terminal invite at T-45m and reminder at T-15m, each claimed BEFORE the DM is sent; PRODUCT_SPEC §Phase 4 / §6.4a), `emergencyCancelledBy`, `emergencyReason`, `feedbackByA`/`B`, `feedbackPromptedAt`, **`dateAttendedA`/`B`** + **`attendanceOutcomeA`/`B`** (did the date actually happen, answered at T+24h — PRODUCT_SPEC §Phase 4. Written ONLY by a human answer, never by the evidence classifier, which picks the question's wording and nothing else. `null` means "not answered" and is NOT `false`: `Match.status = 'completed'` is stamped by the feedback prompt whether or not anyone showed up, so it cannot answer this. Attendance is a property of the PAIR — one credible `true` settles the match — and the two columns exist because the sides can disagree, which is a real `disputed` state rather than something to collapse. The outcome is a plain string like every other match sub-state here; whitelist in `services/attendance.ts`, deliberately separate from `feedbackBy*` because that blob is LLM-distilled into the answerer's `negativeConstraints` and "she never turned up" is not a trait to penalise future candidates on), `dateCardFileIdA`/`B` (Telegram `file_id` cached per side for My Date; that side is cleared transactionally on language/theme change, and cache writes compare the rendering language/theme against the current participant so a concurrent stale render cannot repopulate it) |
| Nudges | `nudge1SentAt`, `nudge2SentAt` (legacy), `proposalNudge1SentAt`, `proposalNudge2SentAt`, `schedNudge1SentAt`, `schedNudge2SentAt`, `proposalDeadlineNudgeSentAt` (idempotency for the single deadline-anchored "window closing" DM ~2h before the 24h TTL — see [PRODUCT_SPEC.md](../product/product-spec.md) §3.5), `venueNudge1SentAt`/`venueNudge2SentAt` (the same 6h/12h pair for the venue step, which had no reminder at all) |
| Planning stall (§3.5c) | `schedulingOpenedAt` — when `startScheduling` actually opened the Calendar, and the anchor every scheduling-phase reminder counts from (it replaced `dispatchedAt`, which also covers the up-to-24h decision window, so a late-accepting pair could get "pick a time" seconds after the Calendar card; null rows fall back to `dispatchedAt`). `stallCheckInSentAtA/B` + `stallConfirmedAtA/B` — the "still in?" question and its 🟢 answer, **per side** unlike every nudge column above, because both participants can independently go quiet and each needs their own question and answer. A confirmation is only eligible when it predates the question it answers, which is what makes each sent question confirmable exactly once (a stale green tap can't keep pushing the 48h deadline). Owned by `services/match-stall.ts`; driven by the existing hourly `match-nudge` cron. |
| Date Ticket (feature-flagged) | `ticketPriceCents`, `ticketPaidA/B`, `paidForPartnerByA/B`, `partnerPaidSeenAt` / `partnerPaidNudgedAt` (goodwill-cover read-receipt: first-seen stamp gating the payer's "she saw it ❤️" DM, and the completion-nudge guard — §3.5b), `ticketStatus` (`pending`/`partial`/`completed`/`refund_pending`/`refunded`/`expired` — string, not a Prisma enum), `ticketExpiresAt`. `refund_pending` is the durable retry boundary: scheduling opens only after the provider/wallet reversal succeeds. Monetization sub-state machine that runs while `status = negotiating`; inert when `TICKET_FEATURE_ENABLED` is off. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.5b. |
| Pre-date coordination (feature-flagged) | `coordOfferSentAt`, `coordInitiatorId`, `coordMethod` (`share_self`/`request_partner`/`proxy` — string, not a Prisma enum), `coordChosenAt`, `coordPartnerConsent` (Variant B only), `coordResolvedAt`, `proxyOpenedAt`, `proxyClosesAt`, `proxyClosedAt`. Sub-state machine running on a `scheduled` match; inert when `COORDINATION_FEATURE_ENABLED` is off. See [PRODUCT_SPEC.md](../product/product-spec.md) §Phase 4. |
| Allocation source (feature-flagged) | `source` (`weekly`/`rematch`/`synthetic`/`campus`/`event` — string, not a Prisma enum, so a new value costs no migration; default `weekly`, stamped INSIDE the creating transaction by `createProposedMatch`), `rematchPaidById` (the buyer of a paid on-demand run; null for weekly pairs). Weekly-optimizer analytics filter to `source = 'weekly'` so neither on-demand runs nor test fill bias the scoring A/B — and a `synthetic` pair additionally writes NO `MatchScoreLog` at all, because a partner who declines by construction says nothing about scoring quality. An `event` pair (LAUNCH_EVENTS §11) is the one source born **pre-accepted**: `createProposedMatch` takes `preAccepted` and writes `status: "negotiating"` with both `acceptedBy*` true, because two people who both said yes at the party have already answered the question a `proposed` row exists to ask — and it arms `ticketExpiresAt` in the same CAS, so the row can never reach `negotiating` invisible to both the ticket sweep and the stall chain (§3.5b's own rule, one stage earlier). See [PRODUCT_SPEC.md](../product/product-spec.md) §3.11 / §3.1c / `REMATCH_PRODUCT_SPEC.md` / `LAUNCH_EVENTS_PRODUCT_SPEC.md` §11. |
| Venue change v2 (feature-flagged) | `venueChangeStatus` (null/`liking`/`agreed`/`settled`/`lapsed` — string, not a Prisma enum), `venueChangeProposerId`/`ProposedAt` (session initiator — first like / express mint), `venueLikesA/B` (`Json[]` server-resolved like snapshots), `venueChangeName`/`Address`/`Lat`/`Lng`/`MapsUri`/`PlaceId`/`PhotoUrl`/`PhotoName` (agreed venue snapshot), `venueChangeExpiresAt` (payment deadline)/`ResolvedAt`, `venueChangePaidById`/`PaidAt` (settle stamp), `venueChangePayDeclinedAt` (vestigial v2 — his decline now ENDS the change/closes the session rather than stamping a lingering `agreed` state, so this is no longer written or read for a decision), `venueChangeOfferPaySentAt` (wish-card guard), `venueChangePingSentToA/BAt` (board-invite guards), `venueChangeExpressAt` (her hidden unilateral mint), `venueChangeTier` (`base`/`premium` of the agreed venue, stamped at agreement — drives the §Premium fee waiver: a premium venue, or a base venue settled by a premium user, is free), `venueChangeCount` (`Int @default(0)` — settled changes so far, capped by `VENUE_CHANGE_MAX_PER_DATE` (2); incremented inside BOTH settle CASes, the paid one and the Premium free one, which is why the cap cannot be derived from `venue_change_purchases`: a free settle writes no purchase row, so a subscribing pair and every demo visitor would be uncapped), `venueChangeComment` (legacy v1, no longer written). Paid multiplayer venue-board sub-state on a `scheduled` match — a lapse never cancels the match; inert when `VENUE_CHANGE_FEATURE_ENABLED` is off. **`settled` and `lapsed` end the SESSION, not the date**: either can be restarted into a fresh `liking` round while `venueChangeCount` is under the cap, and the restart wipes every `venueChange*` field above (both `venueLikes*` included) in the same compare-and-set that writes the new round's first like — these columns are one slot, not a history, so a partial reset would let round one's hearts agree round two and would keep the peer-wait shimmer dead via a stale `venueChangePaidAt`. Only the four entry points that perform that reset (board state, catalog, like submission, express mint) consult `evaluateVenueChangeRestart`; every other action keeps reading `evaluateVenueBoardEligibility`, which still refuses a finished session outright. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.7b / §3.8. |

Indexes: `(status, createdAt)`, `(userAId, userBId)`, `(ticketStatus, ticketExpiresAt)` (ticket-expiry cron sweep), `(status, coordOfferSentAt)` (coordination offer sweep), `(coordMethod, proxyClosedAt)` (proxy open/close sweeps), `(venueChangeStatus, venueChangeExpiresAt)` (venue-change expiry sweep), plus the functional
`matches_pair_canonical_idx` on `LEAST/GREATEST(user_a_id, user_b_id)` —
created out-of-band by `ensureMatchPairIndex()` at boot — that backs the
**lifetime ban** anti-join (a user never sees the same partner twice).

### `match_score_logs` (1:1 with `matches`)

Frozen score breakdown captured at match creation — `scoreExplicit`,
`scoreResearch`, `scoreLeague`, `scorePenalty`, **`scoreAgePref`** (stated
preferred-partner age-band multiplier; defaults to `1` so rows logged before the
factor existed read as neutral), **`scoreIntent`** (relationship-intent
agreement, also defaulting to `1` — and neutral on every row while
`INTENT_FLOOR` is 1.0), `scoreTotal`,
`embeddingDistance`, `starvationBonus`. Powers
`/admin/analytics/algorithm` so component weights can be A/B-tuned without
scanning the hot `matches` table.

**`scoreTotal` is recomposed from the averaged breakdown, and the expression
that does it is shared with the ranker** (`composeScore`, `match-engine.ts`).
It used to exist twice — once where `scoreCandidate` ranks and once where
`createProposedMatch` persists — so every new multiplier had to be added to
both or the audit row would describe a formula the engine never ranked on. One
function now serves both, and a test asserts the two agree to 12 decimals.

Embedding freshness is fail-closed. Embedding-feeding edits mark the profile
dirty and attempt a 30-second user-scoped refresh. `runWeeklyBatch()` first
processes a snapshot of the entire dirty backlog (independent of the periodic
worker's 20-row cap) through a bounded parallel pool, then eligibility requires
`embeddingDirty = false` in both Prisma and raw-vector paths. The vector update
compares `embeddingDirtyAt` *and* the captured embedding-source fields, so an
edit that lands in the same timestamp millisecond cannot be cleared by an older
generation. Preflight logging is aggregate-only (`scanned/refreshed/failed/
stillDirty`), and excluded dirty users never enter standby accounting.

### `match_events`

Append-only audit trail (`actionType` ∈ `MatchEventActionType`). Drives regular
Elo updates, expiry telemetry, and the dashboard's "ignored you" counter.
Emergency cancellation's small peer boost is applied directly by
`handlers/date/emergency.ts`, not through `match_events`. Indexed by
`(matchId, createdAt)`, `(actorId, createdAt)`, `(targetId, createdAt)`,
`(actionType, createdAt)`.

**Two of the eight enum values are never written** (measured 2026-08-08, after a
demo run that reached the post-date feedback produced no row for either):
`PROPOSAL_SHOWN` and `DATE_COMPLETED` exist in `MatchEventActionType` and have
**no write site anywhere** in `apps/bot/src` or `packages`. The six that are
emitted are `ACCEPTED`, `DECLINED`, `EXPIRED_SILENT`, `EXPIRED_PEER_IGNORED`,
`CHEMISTRY_POSITIVE`, `CHEMISTRY_NEGATIVE`. This matters to anyone reading the
table as a funnel: a date that actually happened leaves **no** `DATE_COMPLETED`
row, so completion must be read from `Match.status = 'completed'` (set by
`date-lifecycle.ts` at the T+24h feedback prompt), and dispatch from
`Match.dispatchedAt` rather than from `PROPOSAL_SHOWN`. The values are kept in
the enum because dropping one is a migration on a shared production enum for no
behavioural gain; treat them as reserved, not as data.

### `reports`

Post-match user-vs-user reports. LLM-triaged into `tier` 1/2/3
(`reasonSummary` is the distilled rationale). `adminReviewed` flips on the
manual-queue clear. Unique `(reporterId, matchId)` blocks duplicates. See
[PRODUCT_SPEC.md](../product/product-spec.md) §5 for tier policy. Tier 2/3 status changes
and cancellation of every in-flight match are committed in the same database
transaction; partner compensation and Telegram/Expo notifications run only
after commit and never weaken the cancellation safety gate.

### `user_blocks`

One user's block of another (App Store guideline 1.2). Sibling of `reports` and
deliberately unlike it: no text, no tier, no moderation queue, no consequence
for the blocked account. Unique `(blockerId, blockedId)` makes a retry the same
row rather than a second one or an error. `matchId` is the surface the block was
filed from, kept for moderation context, nullable with `SetNull` — a block must
outlive the match that produced it. `onDelete: Cascade` from `users` on both
sides.

**Directional in storage, symmetric in every consumer.** The row records who
blocked whom because the blocker's own list has to show and undo it; the
candidate SQL (`buildCandidateSql`) and the drop batch (`loadExcludedPairs`)
both read it in both directions. That symmetry is what stops the block from
leaking its own existence by being one-sided.

Writing it and cancelling a live match between the two happen in one
transaction (`services/user-block.ts` → `claimMatchCancellation`); ticket
refunds and the partner's cancellation notice run only after commit, on the same
rail freeze and moderation use. See [PRODUCT_SPEC.md](../product/product-spec.md)
§Blocking.

### `email_otps`

Mobile-side OTP store. **Distinct from `users.emailOtp`**: keyed by `email`
(not `userId`) because mobile users start the funnel before a `User` row
exists. `code` is bcrypt-hashed; raw is only delivered via the email provider. Tracks
`attempts` and `consumedAt` for replay protection. Request creation takes a
transaction-scoped PostgreSQL advisory lock keyed by normalized email, so
concurrent requests across processes cannot bypass the resend cooldown or send
multiple competing codes.

### `live_activity_tokens`

APNs push tokens for the native app's Live Activities (ActivityKit). One row
per (user, `activityType` ∈ `match_decision`/`date_day`, `kind` ∈
`start`/`update`), unique composite — the single-live-match invariant means a
user never runs two activities of one type, so re-registration upserts in
place. A token APNs reports dead is deleted so the next activity re-registers
cleanly. `onDelete: Cascade` from `users`. Written by
`public/routes/live-activity.ts`; consumed by
`services/push.ts → sendLiveActivityUpdateToUser` (the per-activity `update`
token) and `→ sendLiveActivityStartToUser` (the per-TYPE `start` token).

**The two kinds are not interchangeable, and that is the whole point of the
composite key.** An `update` token exists only while an activity is running, so
it cannot be the thing that starts one; the `start` token is minted once per
attributes type and survives the app being killed. `date_day` uses both — the
lifecycle push-starts the card at T-5h on a phone whose owner has not opened
the app, then updates it — while `match_decision` deliberately registers
neither: the only thing that changes over its 24 hours is the clock, and the
system runs that itself (PRODUCT_SPEC §Phase 4, iOS ARCHITECTURE §Live
Activities).

### `phone_otps`

Native-app phone-code challenges (Registration v2 general track on iOS —
the Telegram one-tap `message.contact` rail doesn't exist there). Twin of
`email_otps`, keyed by E.164 `phone` (the funnel starts before a `User` row
exists). `provider` records the delivery rail: `telegram_gateway` stores our
own bcrypt `codeHash` (verified locally), `twilio_verify` delegates code
generation/checking to Twilio (`codeHash` null, `providerRequestId` = the
Verification SID). `attempts`/`consumedAt` mirror the email OTP state
machine; per-phone creation is serialized with a transaction-scoped advisory
lock, and a durable per-phone daily cap backs the in-memory rate limiter.
Indexed `(phone, createdAt)`. Written by
`services/phone-verification.ts`; consumed by `public/routes/phone-auth.ts`.

A third `provider` value, **`console`**, is written only when
`OTP_LOG_TO_CONSOLE` is set — dev and the demo deployment, which
`identityTrustConfigurationErrors` are the only runtimes allowed to set it. It
prints the code and calls no provider at all. This exists because both of those
deployments run on PRODUCTION's `TWILIO_*` credentials and `/v1/auth/phone` is
mounted unconditionally, so before 2026-08-08 a code requested against
`demo-api.gennety.com` sent a real SMS billed to the production account.
Verification branches on `provider === "twilio_verify"` (remote check) and
treats **everything else** as locally hash-verified — deliberately that way
round, so a rail added without a matching branch is refused for want of a
`codeHash` rather than handed to a provider that never issued it.

### `user_sessions`

Active mobile refresh tokens. Access JWTs are stateless; refresh tokens are
hashed here for server-controlled rotation/revocation.

### `bot_sessions`

grammY session adapter persistence (Prisma-backed). Keyed by Telegram chat id.

**It is the one store an account cannot cascade into, so account deletion
erases it explicitly** (`services/account-deletion.ts`, added 2026-08-08). The
key is the CHAT id and there is no relation to `users`, so nothing in the
Prisma cascade reaches it. Two consequences, and the second is what actually
broke a flow:

- **GDPR.** `SessionData` holds `pendingPhotos` (Telegram `file_id`s of the
  erased profile), `contextDumpBuffer` (a pasted AI-memory export) and
  `activeMatchId`. A hard delete that left them behind was not erasure.
- **The next account in that chat inherited the state.** A session left with
  `expectingPhoto: true` put a brand-new account into the photo stage while the
  onboarding collector was still several questions away, so three uploads
  produced a Continue button that finalized onboarding early — and the finalize
  guard then refused, permanently (PRODUCT_SPEC §1.3).

The delete rides the same transaction as `user.delete`, so a storage-cleanup
failure leaves the session intact along with the account it belongs to.
**A Telegram caller must ALSO reset `ctx.session` in place**: grammY writes the
live session back after the handler returns and would otherwise resurrect the
row it just deleted. `handlers/menu/settings.ts` has always done this; the demo
`/restart` (`demo/commands.ts`) did not, which is where the defect surfaced.

### `system_knowledge`

Curated knowledge entries surfaced to the menu/onboarding agents. Each row:
`key` (unique), `title`, `content`, `category`, `priority`, `active`.

**Two namespaces share this table, and only one of them may reach a prompt.**
`admin/utils/cache.ts` uses it as the JSON cache for the heavy analytics
queries (`category = 'admin_cache'`, keys prefixed `admin_cache:`).
`fetchKnowledgeBase` (`services/prompt-builder.ts`) is the single place that
enforces the split, filtering on **both** markers plus a post-query guard — a
row carrying only one of them is exactly the shape of the bug this prevents.
Until 2026-08-01 that query had no filter at all, so every analytics blob
(user counts, gender funnel, city centroids, growth) was injected into the menu
agent's system prompt at `priority: 0`, i.e. above the code-owned playbook:
~23k characters on every turn, for every user. The block is additionally capped
at 4k characters with a warning, because the failure mode is silent.

**Product rules do NOT live here.** They live in `services/product-playbook.ts`
— code-owned, flag-aware and unit-tested. The five legacy rule rows
(`profile_rules`, `emergency_protocol`, `university_verification`,
`match_timing_faq`, `zero_chat_philosophy`) drifted badly from the product and
were retired by `packages/db/prisma/seed-knowledge.ts`, which now seeds nothing
and only deactivates them. What remains is an extension point for genuine
operator notes.

### `messages`

Mobile chat agent history — multimodal, one row per turn, with optional
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

### `chat_events`

Append-only timeline of what actually happened in a user's Telegram chat: every
durable message the bot SENT (`direction = out`) and every action the user TOOK
(`direction = in`) — typed text, a voice note's transcript, a button tap, a Mini
App submission, a settled Stars payment. Columns: `userId` (cascade),
`direction`, `kind` (`text`/`photo`/`album`/`video`/`video_note`/`voice`/
`document`/`user_text`/`user_voice`/`user_media`/`user_contact`/`callback_tap`/
`mini_app_action`/`payment`), `surface` (coarse product area derived from
callback prefixes / Mini App page), `summary` (truncated to 300 chars),
`actions` (`Json?` — the buttons offered: `[{label, data?, webApp?}]`),
**`media`** (`Json?` — the attachments: `[{kind, ref}]`, where `ref` is a
Telegram `file_id` the admin media proxy can re-download; never the bytes),
`telegramMessageId`, `matchId` (free-form, no FK — mirrors `rematch_purchases`),
`createdAt`. Indexed `(userId, createdAt)` and `(telegramMessageId)`.

**`media` is read from the API RESULT, not the request payload** (added
2026-07-31). Much of the product's media goes out as raw bytes — a
satori-rendered date card, a bundled кружок, a generated voice note — so the
outgoing payload carries no `file_id` at all; Telegram assigns one on the way
back. Reading the result is therefore the only capture point that works for
every send, and it is what makes `GET /admin/media?type=telegram&ref=…` able to
show the image weeks later. Video, video note, animation and sticker store
their POSTER frame rather than the moving file, because that proxy streams
images; a voice note stores `{kind}` with no `ref`, which still tells the admin
transcript one was sent. Before this the table recorded only the sentence
("(photo card, no caption)", "sent a photo"), so the admin dialog reader could
say that something visual happened and never show it — every image in every
conversation was invisible.

It exists because the menu agent could not see its own product. Outbound
messages are written from ~276 scattered call sites while `User.messageHistory`
only ever held the agent's own turns, so a user answering "why?" directly under
a bot message was answered against conversation from days earlier (PRODUCT_SPEC
§2.1). Read back by `services/prompt-builder.ts` as the agent's "Recent chat
timeline" (last 12 events per turn).

**It is untrusted input to a tool-calling prompt, and treated as such.** The
rows are rendered inside an explicit data fence whose standing rule is that
nothing within it is an instruction; `renderChatTimeline` neutralises the fence
marker and markdown headings in every field it emits (summaries AND button
labels) so a row cannot close the block early and have the remainder read as
prompt. The bodies that a *different* user authored never reach the table at
all: `withRedactedSummary` (`services/outbound-recorder.ts`) makes the verbatim
emergency-cancellation relay and the proxy-chat relay store a neutral marker
instead of the text. Both matter because the reader's own menu agent holds
tools that write to the reader's profile.

**Written at three boundaries, not per call site:**

| Boundary | Module | Covers |
|---|---|---|
| grammY **API transformer** on `bot.api` | `services/outbound-recorder.ts` | Everything the bot sends — handlers, cron workers, the date lifecycle, Mini App routes — because they all share the one `Api` (`setMainBotApi(bot.api)`). |
| Inbound **middleware** (after `botRateLimit`) | `handlers/interaction-recorder.ts` | Typed text, media, contact share, and button taps — stored by the button's own visible label, resolved from the message's `reply_markup`. |
| Explicit calls in `/v1/*` initData routes | `recordMiniAppAction` | Mini App submissions (venue-change board, calendar picks, venue intent, ticket use, post-date feedback), which never touch the chat. |

Only `send*` methods are recorded: every `edit*` is skipped because the pinned
status banner and the pitch's reply-deadline button re-render **every minute per
user**. Ephemeral sends are excluded two ways — `withEphemeralSends` marks the
self-deleting "thinking" status beats (`services/ai-stream.ts`), and a
`deleteMessage` deletes the row it created, so an untagged path self-heals. A
stream that edits one message through several chunks marks its transient send
ephemeral and records the FINAL text once via `recordOutboundMessage`.

**Recording covers every real Telegram chat from `/start` onward** (founder
decision 2026-07-31, PRODUCT_SPEC §2.1). It used to begin only at
`onboardingStep = 'completed'`; the cost was that registration was the one
stretch of the conversation the admin dialog reader could not see. Two
consequences the code depends on:

- The `chatId → user` cache keeps a **hit** for 5 minutes but a **miss** for
  only 10 seconds. The first `/start` reaches the inbound recorder before the
  handler that creates the `User` row, so it resolves to "no such user";
  caching that for the full TTL would silently discard the next five minutes of
  that chat, i.e. most of registration.
- `resolveChatTarget` no longer reads `onboardingStep` at all — a row existing
  is the whole test. `invalidateChatTarget` survives as the seam for a chat
  that changes owner (the phone-based account adoption in
  `services/account-linking.ts` re-points a `telegramId` at a different row).

Every write is fire-and-forget and swallows its errors: the recorder sits in
the path of every outgoing Telegram call and must never fail a send. Swept
after 30 days by `workers/retention.ts`.

**Redaction (`redactSensitiveSummary`, added 2026-08-01).** Widening the scope
to onboarding put the typed OTP reply in range, and `email_otps` / `phone_otps`
deliberately store that code bcrypt-hashed — a cleartext twin here for 30 days
would undo that decision for no product gain. A message that is NOTHING BUT a
4–8 digit code (optionally spaced or dashed) is therefore replaced with
`(entered a code)` before the row is written. The rule is anchored to the whole
message on purpose: an inline `\d{4}` would also swallow a year, a price or a
house number and make the timeline lie about ordinary conversation. Redaction
runs inside `recordChatEvent`, not at the call sites, so no recorder path can
forget it. The phone number is still never stored — the contact share is
recorded as the event, not the digits. The AI-memory export branch is retired
(`AI_MEMORY_EXPORT_ENABLED=false` and the feature is not offered), so no pasted
export reaches this table; if it is ever revived it must be masked here first.

### `client_events`

Клиентская воронка нативного приложения (iOS 6.2). Одна строка на событие;
`props` — `Json` с не более чем одним скаляром. Колонки: `id` (UUID **от
клиента**), `userId` (nullable, cascade), `installId`, `type`, `props`,
`occurredAt`, `receivedAt`, `appVersion`/`appBuild`/`osVersion`/`locale`.
Индексы `(type, occurredAt)`, `(installId, occurredAt)`, `(receivedAt)`.

**Правило, из которого следует всё остальное: сюда попадает только то, чего
сервер не видит в принципе.** Уход с шага онбординга ДО отправки, отказ в
системном разрешении, исход нативной проверки живости, показ пейволла и
тикет-гейта без покупки, фатальная клиентская ошибка. Регистрация,
верификация, матч, решение и свидание — это вызовы API, они уже наблюдаются, и
дублирующее событие создало бы второй источник правды, при расхождении с
которым никто не знает, какому верить. Перечень закрыт с обеих сторон
(`services/client-events.ts` → `CLIENT_EVENT_TYPES`, дословно совпадает с
`AnalyticsEvent.type` в iOS-репо).

**`id` генерирует клиент, и он же ключ идемпотентности.** Батч, записанный до
того, как оборвалась сеть, при повторной доставке не задваивает строки:
первичный ключ ловит это на уровне БД, а `createMany({ skipDuplicates: true })`
не даёт повтору уронить весь запрос. Дубль ВНУТРИ одного батча снимается
отдельно, до вставки: `skipDuplicates` разрешает конфликт со строками в
таблице, а не с соседней строкой того же `createMany`.

**Две отметки времени, и обе несущие.** `occurredAt` — часы устройства, то есть
единственное, что знает клиент: батч уходит и до авторизации, так что
серверного времени в нём взяться неоткуда. `receivedAt` (`@default(now())`) —
наши часы, и по ним же считается ретеншен. Телефон со сбитой датой искажает
воронку ровно до тех пор, пока анализ смотрит только на первую; свип по
`occurredAt` такую строку либо пережил бы, либо стёр в день приёма.

**PII и свободный текст сюда не попадают, и это свойство конструкции, а не
договорённости.** Значения `props` проверяются по ФОРМЕ
(`^[a-z0-9_]{1,32}$`), а не по списку: короткий `snake_case` не вмещает ни
имени, ни телефона, ни координаты, а проверка по списку значений отбрасывала
бы события нового клиента до ближайшего деплоя сервера. Ключ у каждого типа
ровно один (`PROP_KEY`), лишний — повод отбросить событие.

**Неизвестный `type` отбрасывается и считается в `dropped`, но НЕ роняет
батч.** Клиент и сервер выкатываются независимо, сборка из App Store живёт
месяцами; любая другая трактовка означала бы, что одна сторона ломается о
вторую.

Каскад от `users` намеренный — строка с `user_id` удалённого аккаунта не
является стёртыми данными; события, снятые до авторизации, `user_id` не имеют
вовсе и уходят по ретеншену (90 дней, `workers/retention.ts`).

### `user_activity_days`

One row per `(UTC day, user, platform)` on which the person DID something — the
DAU/MAU substrate. Columns: `activityDate` (`@db.Date`), `userId`, `platform`
(`telegram` | `ios`), `firstSeenAt` / `lastSeenAt` (real UTC instants),
`events`. Composite PK `(activityDate, userId, platform)`; `onDelete: Cascade`
from `users`.

**It is an aggregate, not a second event log, and that is the decision.**
`chat_events` already records every inbound action — a typed message, a voice
note, a tapped button, a Mini App submission, a settled payment — so a parallel
`user_activity_events` table would be a second source of truth about the same
fact plus a second write on every update. What `chat_events` cannot be is the
substrate, for one reason: `workers/retention.ts` deletes it after **30 days**
(measured — production's oldest surviving row sits exactly at that boundary),
so a metric computed from it has no history and no trend. This table is what
survives.

**Rolled up per DAY because that is the smallest shape both metrics can be
answered from.** DAU is a `COUNT` over one day; MAU is a `COUNT(DISTINCT
user_id)` over a window. Unique users are not additive, so daily counters alone
could never produce a monthly number — a person active on twelve days is one
monthly active user, and summing DAU overcounts by exactly how loyal the base
is. At ~50–100× fewer rows than the events it summarises it stays cheap: 10k DAU
is 10k rows a day.

**`activityDate` is a UTC calendar day, and the boundary is why.** Not the
reflex "store everything in UTC": UTC midnight falls at 02:00–03:00 Kyiv, deep
inside the product's own quiet hours (23:00–09:00), while Kyiv midnight lands
while people are still awake. The UTC day therefore cuts fewer sessions in half
than the local one. Revisit it the day a market exists whose night is not
Kyiv's. `firstSeenAt` / `lastSeenAt` are ordinary UTC instants — `activityDate`
is a bucket key, those are timestamps.

**`platform` is a plain string, deliberately not the `Platform` enum.** That one
describes an ACCOUNT and has a `both` value; this describes one day on one
surface, where `both` is meaningless — a user active on two surfaces is two
rows, which is what makes a per-platform DAU breakdown possible at all. MAU
still counts them once, because every window number goes through
`uniqueUsers()`.

**Written from ONE choke point** (`services/activity.ts` → `markUserActive`,
called by `recordChatEvent` whenever `direction === "in"`). Every inbound path
in the product already funnels through that function, so a seventh inbound path
is counted the day it is written with nobody having to remember. `direction:
"out"` is deliberately not activity: the bot sends the pinned banner, the drop
pitch and the nudges on its own schedule, so counting those would measure our
delivery rather than the user's engagement.

The write is fire-and-forget and swallows its errors — it sits on the path of
every update and must never cost a user their action — so
`workers/activity-rollup.ts` re-derives the same rows from `chat_events` nightly.
That reconcile is what turns a best-effort write into a reliable metric, and it
is the reason the live path is allowed to be best-effort. It cannot be the only
mechanism: the timeline is retained 30 days, so a reconcile repairs the recent
past and is never a source of history.

Test and synthetic accounts are excluded on **read**, not on write
(`admin/utils/activity-source.ts`, sharing `ADMIN_TEST_TELEGRAM_IDS` with
`user-health-source.ts` so two dashboards cannot disagree about who counts).
Filtering at write time would bake one definition of "test account" into data
collected months earlier.

**It has a second reader with a different shape of question (2026-08-29):**
`GET /admin/analytics/cohort-retention` groups users by the day they registered
and asks whether each was active in a window ending N days later. DAU/MAU ask
"how many distinct people on this day"; cohort retention asks "of the people who
arrived on day X, how many came back". Both read the same rows, so **the two
must agree about who counts** — `loadCohortUsers` deliberately reuses
`loadActivityRows`'s exclusion verbatim (`syntheticAt: null` plus the same
`ADMIN_TEST_TELEGRAM_IDS`), because a numerator and denominator drawn from two
definitions of the population can produce a retention rate above 100%.

One consequence that is easy to misread: because this table is the substrate,
**a cohort older than the table reads as `no-data`, never as 0%**. The
`activityCoverageFrom` field on the response is what says which is which, and it
deliberately does NOT apply the test filter — it answers "what does the table
cover", not "who is in it".

### `media_validation_rejections`

Append-only audit of upload-time profile-media rejections. Stores only
`userId`, coarse `mediaType` (`photo`/`video`), `rejectionReason`, and
`createdAt`; raw media, hashes, provider payloads, face crops, and biometric
material are never persisted here. Written by the photo/video validation
wrappers before a rejected asset can be committed to `profiles`.

### `ticket_ledger` (feature-flagged)

Append-only audit of every ticket-wallet movement or payment/refund transition
(`userId`, `delta`, `reason` ∈ `photo_bonus`/`video_bonus`/`student_bonus`/
`referral_milestone`/`promo`/`welcome_gift`/`store_purchase`/`spend_match`/`refund`/`gate_payment`/
`gate_processing`/`gate_settled`/`gate_surplus_pending`/
`gate_refund_pending`/`gate_refunded`/**`premium_gate`**, plus the retired legacy
`verification_bonus` that survives only on historical rows and is never written
anymore, optional
`matchId`/`amountCents`/**`amountStars`**/`bundleSize`/`externalPaymentId`,
`createdAt`;
`onDelete: Cascade` from `users`). The running sum of `delta` equals
`User.ticketBalance`, which is materialized for fast reads; both are written in
the same transaction by `services/ticket-wallet.ts`. Photo/video onboarding
bonuses are idempotent via `Profile.photoBonusTicketAt` / `videoBonusTicketAt`;
the first-pitch welcome gift and the Registration v2
student bonus (+2 at university-email verification) use a serializable ledger
claim on `welcome_gift` / `student_bonus`.
**`externalPaymentId`** is either the unique provider charge id (Telegram Stars
`telegram_payment_charge_id`) for a paid store/date-gate purchase or a synthetic
id for an exactly-once wallet reversal. The synthetic forms in use are
`wallet-expiry-refund:<matchId>:<payerId>` (the §3.5b expiry rail) and
`refund:match:<matchId>:<userId>:<slot>` — the **dead-match refund**
(`services/ticket-refund.ts`, PRODUCT_SPEC §3.5b): when a live match dies before
the date, every paid slot returns to its payer as a wallet ticket, and the unique
index is what makes that exactly-once across the six paths that can trigger it
(freeze / hard delete / moderation via `cancel-in-flight-matches.ts`, emergency
cancellation, and both §3.5c stall endings). One row per slot, so a payer who
covered both sides gets two rows and a partial failure stays resumable. The
planner deliberately stands down on `ticketStatus ∈ {refunded, refund_pending,
expired}`, which the expiry rail owns. For the date gate, zero-delta
`gate_payment` rows retain the charge needed by `refundStarPayment`; their
settlement reason advances atomically with the match-slot CAS to `gate_settled`
or a durable refund/surplus state. The hourly worker retries pending provider
refunds and wallet credits; a `gate_payment` row still unprocessed after five
minutes is treated as an abandoned pre-transaction charge and safely refunded.
**`premium_gate`** (added 2026-08-22) is a **zero-delta** row marking a date
slot covered by an active Gennety Premium subscription (PRODUCT_SPEC §3.5b).
Zero-delta because Premium spends nothing — not money, and deliberately not a
wallet ticket, which would have a subscriber paying for the very thing the
subscription promises. It exists purely so a reader can tell "Premium covered
this date" from "the gate lapsed and the Calendar opened for free": those two
are otherwise indistinguishable on the row, and the difference is the whole
measure of whether the subscription pays for the dates it hands out. Written
best-effort by `settlePremiumSlots` (`handlers/matching/ticket-gate.ts`) — an
audit write must never cost someone the date their subscription just paid for —
so it is a strong signal rather than a guarantee. `reason` is a plain `String`
column, so the value needed no migration.

**`amountStars`** (added 2026-08-01) freezes the Stars actually charged on a
paid row, exactly as `rematch_purchases` / `venue_change_purchases` already do.
Star prices are env-tunable (`TICKET_BUNDLE_STARS`), so a reader must never
re-derive a historical price from `bundleSize`; before it, a Stars purchase
recorded no money figure at all and the admin revenue view had nothing to show.
Nullable — free grants, spends, and the App Store rail (which carries
`amountCents`) leave it null, and rows predating the column keep reading as
"price unknown" rather than as zero.
Indexed `(userId, createdAt)`.
Inert unless `TICKET_FEATURE_ENABLED`. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.5b.

### `subscription_ledger` (feature-flagged)

Append-only audit of every Gennety Premium subscription movement (`userId`,
`provider` ∈ `telegram_stars`/`app_store`/`referral`/`promo` (the last two
complimentary comp grants — referral / promo-code rewards, no auto-renew anchor), `event` ∈
`started`/`renewed`/`cancelled`/`expired`/`refunded`, unique `externalPaymentId`,
`periodStart`/`periodEnd`, `amount`/`currency`, optional `note`, `createdAt`;
`onDelete: Cascade`
from `users`). Mirrors `ticket_ledger`: the unique `externalPaymentId` (the
Telegram Stars recurring charge id, or `appstore:<transactionId>`) makes provider
redelivery exactly-once, so a renewal is applied at most once. `User.premiumUntil`
/ `premiumSince` are the materialized head, written in the same transaction by
`services/premium.ts`. `note` is the free-text churn reason captured after an
in-chat cancellation (the menu agent's `offer_cancel_premium` flow →
`recordInChatCancellation` + `attachCancellationReason`, PRODUCT_SPEC §3.8); it
is only ever set on `cancelled` rows. The Stars rail settles through the
`sub:premium`
`successful_payment` path; the iOS rail through `services/appstore-premium.ts`
(`POST /v1/premium/appstore/transaction` + the App Store Server Notifications
webhook, owner found by the `originalTransactionId` anchor on
`User.premiumExternalId`). Indexed `(userId, createdAt)`. Inert unless
`PREMIUM_FEATURE_ENABLED`. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.8 / §Premium.

### `promo_codes` / `promo_redemptions` (feature-flagged)

Independent promo-code program (PRODUCT_SPEC §3.10 / `PROMO_CODES_PRODUCT_SPEC.md`,
gated by `PROMO_FEATURE_ENABLED`; owned by `services/promo.ts`). `promo_codes` is
ONE reusable campaign code (`code` unique + uppercased, per-code `ticketReward` /
`premiumMonths`, nullable `maxRedemptions` cap, materialized `redeemedCount`,
`expiresAt`, `active`, `note`) shared in ad materials; managed out-of-band by
`scripts/promo-codes.mjs`. `promo_redemptions` is the exactly-once + cap-safe
audit/guard: a unique `userId` (one code per human, first-touch) and
`@@unique([promoCodeId, userId])`, created in the same transaction as the atomic
guarded `redeemedCount++`. Reward deltas live in the ledgers (`ticket_ledger`
`promo`, `subscription_ledger` `promo`) via unique `externalPaymentId`
`promo:<codeId>:<userId>`. Attribution reuses `User.referralSource` as
`promo:<CODE>` (mutually exclusive with `referral:*`); `User.promoRedeemedAt` is
the wow-screen once-marker. iOS deferred-deep-link attribution uses an in-memory
TTL fingerprint→code store (`services/promo-attribution.ts`, coarse IP+UA+lang
hash, one-shot match), matching the single-process `usage-limiter` pattern.
`onDelete: Cascade` from `promo_codes` / `users`. Inert unless
`PROMO_FEATURE_ENABLED`. See [PRODUCT_SPEC.md](../product/product-spec.md) §3.10.

### `rematch_purchases` (feature-flagged)

Append-only audit of every paid Rematch (PRODUCT_SPEC §3.11 /
`REMATCH_PRODUCT_SPEC.md`, gated by `REMATCH_FEATURE_ENABLED`; owned by
`services/rematch.ts` + `services/rematch-refund.ts`). Mirrors `ticket_ledger`:
the unique `externalPaymentId` (Telegram Stars `telegram_payment_charge_id`)
makes a redelivered `successful_payment` exactly-once **and** preserves the
charge key `refundStarPayment` needs later. Columns: `userId`, `status`
(`processing` → `settled` | `refunded_no_candidate` | `refunded_ineligible` |
`refunded_undelivered` | `refund_failed` — string, not a Prisma enum, which is
why the fourth value cost no migration. `refunded_undelivered` is the pitch that
reached NEITHER side, §3.11 — deliberately distinct from `refunded_no_candidate`
because the two say opposite things about the pool, and it is the only refund
that means the product failed rather than the city being thin), `amountStars`/`amountCents` (price
frozen at purchase), `resultMatchId` (free-form, no FK, so deleting a match never
breaks the payment trail), `framing` (which gift framing the partner's pitch
used), `resolvedAt`/`refundError`, `createdAt`. Rows are written ONLY from the
`successful_payment` trust boundary, and written **before** the engine runs, so a
crash mid-run still leaves a durable record that money moved; the hourly
`rematch-refund` sweep refunds rows stranded in `processing`. There is **no
materialized head on `User`** — the rate limits are derived from these rows, so
there is no counter that can drift out of sync with the money. Indexed
`(userId, createdAt)` (limit lookup) and `(status, createdAt)` (sweep).
`onDelete: Cascade` from `users`. Inert unless `REMATCH_FEATURE_ENABLED`.

### `venue_change_purchases` (feature-flagged)

Append-only audit of every paid venue change (PRODUCT_SPEC §3.7b, gated by
`VENUE_CHANGE_FEATURE_ENABLED`; owned by `handlers/matching/venue-change.ts` +
`services/venue-change-refund.ts`). Deliberately a table of its own rather than
`ticket_ledger` rows: a venue change is a one-off purchase, not a wallet
movement, so it follows `rematch_purchases` rather than the date gate.

Columns: `userId`, `matchId` (free-form, no FK, so deleting a match never breaks
the payment trail), `status` (`processing` → `settled` | `refunded_race` |
`refunded_stale` | `refund_failed` — string, not a Prisma enum), unique
`externalPaymentId` (the Telegram Stars `telegram_payment_charge_id`),
`amountStars` (frozen at purchase — `VENUE_CHANGE_STARS` is env-tunable),
`resolvedAt`/`refundError`, `createdAt`. Indexed `(userId, createdAt)` and
`(status, createdAt)` (sweep). `onDelete: Cascade` from `users`.

The row is written from the `successful_payment` trust boundary **before** the
`agreed → settled` CAS, so a crash mid-settle still leaves a durable record that
money moved, which the hourly `venue-change-refund` sweep refunds. The unique
charge id is also what distinguishes the two "the CAS claimed nothing" cases: a
`P2002` on insert is a redelivered payment (idempotent no-op), while a
successful insert is a genuinely second charge and must be refunded. Before this
table existed both looked identical and a second charge from the same payer was
silently kept, while a failed refund lost the Stars with no row to reconcile
from. Inert unless `VENUE_CHANGE_FEATURE_ENABLED`.

### `prime_time_purchases` (feature-flagged)

Append-only audit of every paid evening-band pass (PRODUCT_SPEC §3.6 /
`PRIME_TIME_PRODUCT_SPEC.md`, gated by `PRIME_TIME_ENABLED`; owned by
`services/prime-time-purchase.ts`). Deliberately its own table rather than
`ticket_ledger` rows, for the reason `rematch_purchases` and
`venue_change_purchases` already give: this is a one-off purchase, not a wallet
movement.

Columns: `userId`, `matchId` (free-form, no FK, so deleting a match never breaks
the payment trail), `status` (`processing` → `settled` | `refunded_race` |
`refunded_stale` | `refunded_match_died` | `refund_failed` — a plain string, not
a Prisma enum), unique `externalPaymentId` (the Telegram Stars
`telegram_payment_charge_id`), `amountStars` (frozen at purchase —
`PRIME_TIME_STARS` is env-tunable), `resolvedAt`/`refundError`, `createdAt`.
Indexed `(userId, createdAt)` and `(status, createdAt)`. `onDelete: Cascade`
from `users`.

The row is written from the `successful_payment` trust boundary **before** the
`primeTimeUnlockedAt` CAS, so a crash mid-settle still leaves durable proof that
money moved, which the hourly sweep refunds. The unique charge id is also what
separates the two ways the CAS can claim nothing: a `P2002` on insert is a
redelivered payment (idempotent no-op), while a successful insert followed by a
zero-count claim is a genuinely new charge that bought nothing — both sides held
an invoice open and the other one landed first — and is always refunded.

**`refunded_match_died` is the §9.1 rail** and has no equivalent in the two
sibling tables: a live match that dies before the date returns the pass in
**Stars**, on the same four call sites that already return a Date Ticket
(`cancel-in-flight-matches.ts`, `emergency-cancel.ts`, and both endings of the
§3.5c stall chain). Keyed on the purchase row rather than on
`Match.primeTimeUnlockedAt`, because a band opened by a SUBSCRIPTION cost
nothing and has nothing to return — the row is the only thing that knows the
difference.

### `meme_unlock_purchases` (feature-flagged)

One paid reveal of a partner's meme (§3.12, gated by `MEME_UNLOCK_ENABLED`;
owned by `services/meme-unlock.ts`). Columns: `userId` (the buyer), `matchId`
(free-form, no FK — same rule as the two siblings above), `subjectUserId` (whose
meme was shown, recorded so a later moderation report can be traced to what was
actually revealed), `status`, unique `externalPaymentId`, `amountStars` (frozen
at purchase), `resolvedAt`/`refundError`, `createdAt`. Indexed
`(userId, createdAt)` and `(status, createdAt)`; `onDelete: Cascade` from
`users`.

**`@@unique([userId, matchId])` is the entitlement itself**, and this is the
design. Unlike Prime Time — which opens a band for the PAIR and is therefore
keyed by match alone — this reveal is bought by one person and changes nothing
on the partner's side, so the row is keyed by buyer AND match. That index is what
makes "already unlocked" a database fact rather than a query over payment
history, and what stops a reused invoice link from charging twice. The two unique
constraints also separate the two ways an insert can fail: a `P2002` where the
existing row carries the SAME charge id is a redelivered `successful_payment`
(idempotent no-op), while a DIFFERENT charge id is a second purchase of an
entitlement already held (always refunded).

**A refunded row is DELETED, not flagged** — the one place this rail departs from
every other purchase table, and it follows directly from the row being the
entitlement: a `refunded_*` row left in place would permanently block that buyer
from ever purchasing the reveal again. The trade is that reversals reach the
founder feed but not `services/purchases.ts`, so the only `refunded` status that
read model will ever surface here is a refund that FAILED — which is exactly the
row ops needs to find. Statuses: `processing` → `settled` | `refunded_gone` |
`refunded_undelivered` | `refunded_stale` | `refund_failed` (a plain string, not
a Prisma enum, matching the siblings).

### `short_video_analyses` (feature-flagged)

Cache of "what is this TikTok / Reel about", keyed by the platform's own id
(§Phase 1b, gated by `SHORT_VIDEO_LINKS_ENABLED`; owned by
`services/short-video/`). Columns: `platform` (enum `tiktok | instagram`),
`externalId`, `canonicalUrl`, `description`, `authorName`, `posterFileId`,
`model`, `createdAt`/`updatedAt`. Unique on `[platform, externalId]`.

**Keyed per VIDEO, with no user attached** — deliberately, and it is the whole
point of the table. The work is per video, not per person: two users sharing the
same viral reel get the same sentence, so the second share costs no fetch, no
vision call and no upload (measured 28 ms against 4.6 s cold). Share stubs are
resolved to the platform's id *before* lookup, so every share button on both
platforms collapses onto one row.

**Nothing in a row is private**, which is why there is no FK and no retention
sweep here. The caption and cover frame are what the platform serves to anyone
logged out; the description is derived from them. This is emphatically **not** a
per-user analysis history — what identifies the user is their `ProfilerAnswer`
row, which cascades with the account exactly as it always did, and a GDPR
deletion has nothing extra to remove.

`posterFileId` is bot-scoped, exactly like `ProfilerAnswer.memeFileId`: a
pointer minted by @gennetybot is unresolvable by the demo bot, and the two run
against separate databases, so a row can never reach a bot that cannot open it.
It is minted by uploading the cover frame ONCE, because both platforms sign
poster URLs with an expiry measured in days while the §3.12 reveal fires days
after capture — a stored CDN URL would be dead by the time somebody paid for it.
On re-analysis an existing pointer is kept when a fresh mint fails: an old,
working pointer beats null.

The URL itself is NOT read from here at reveal time — it is denormalised onto
`ProfilerAnswer.memeSourceUrl` when the answer is recorded, because the answer
row is what the reveal already reads and it is what a re-answer must be able to
clear. This table is a cache; the answer row is the fact.


Inert unless `PRIME_TIME_ENABLED`, with one deliberate exception: the dead-match
refund is NOT gated on the flag. Money outlives flags, and a pass already paid
for must come back even if the feature was switched off in between.

### `ad_spend`

The founder's own record of acquisition spend (PRODUCT_SPEC has no section for
this — see `AD_SPEND_TRACKING_DESIGN.md`), entered by hand through the admin
dashboard's `/ad-spend` page and read by `/admin/dashboard`'s
`cacPerPayingUsdCents`/`cacPerActiveUsdCents`/`ltvCac`/`roas`/
`adSpendByChannel`. The other purchase tables above record money coming IN;
this is the one table recording money going OUT, and it is the only source
those four fields have — before it existed they were hard-coded `null`.

Columns: `channel` (must already be the OUTPUT of `normalizeChannel`
(`growth.ts`) — `organic` | `referral` | `mobile` | `web:*` | `tg:<slug>` — or
the literal sentinel `"unattributed"`), `category` (one of
`AD_SPEND_CATEGORIES`, plain string not a Prisma enum — same reasoning as
`Match.source`: a new category costs no migration), `periodStart`/`periodEnd`
(a free date range, not an ISO-week bucket — see below), `amount` + `currency`
(what was actually paid, in whatever currency), `amountUsdCents` (frozen at
entry, never recomputed by a later FX move — the same rule `TicketLedger.
amountStars` already follows), `note`. `@@unique([channel, category,
periodStart, periodEnd])` — re-entering the same combination updates the row
instead of duplicating the spend.

**Category owns the attribution window, not channel** — the two-axis model
this table is built around. `AD_SPEND_ATTRIBUTION_WINDOW_DAYS[category]`
(`admin/utils/ad-spend.ts`) is how many days PAST `periodEnd` a conversion is
still counted before an entry is treated as matured: `performance_ads` 3,
`influencer` 14, `offline_event` 28, `other` 7, and `content_production` /
`agency` **null** — those categories buy nothing trackable at all (a retainer,
a production shoot) and are excluded from every per-channel/CAC computation,
counting only toward the founder's own P&L total
(`totalMarketingSpendUsdCents`). A `null`-window category MUST be logged
against `"unattributed"` — enforced both server-side
(`categoryRequiresUnattributed()`, the route refuses a mismatch) and by the
dashboard form, because the form is not the only client of this API.

**Why a range instead of the ISO-week bucket the original design used**:
performance ads convert in hours, an offline event's word of mouth trickles in
for weeks, and one calendar-week bucket cannot express both. `computeAcquisitionCost`
(`admin/utils/ad-spend.ts`, pure — no Prisma inside, fed by already-fetched
arrays from the route) is what turns rows into CAC/CPL/ROAS/LTV:CAC; `divCents()`
returns `null` — never `0` or `Infinity` — on a non-positive numerator or
denominator, so "no data" and "acquired for free" stay distinguishable
everywhere this feeds a dashboard card.

**`ltvCac`/`roas` deliberately diverge from `monetization.ts`'s own
revenue-in-window rule.** That rule protects a WEEKLY revenue bucket from
repeat-purchase contamination; here the cohort is defined by an ACQUISITION
event (a payer attributed to a spend entry), not a purchase-timing bucket, so
the value is the payer's full lifetime `usdCents` from `loadPayerIndex()`, not
only what they paid inside the attribution window. Once a user is attributed
to a spend entry, everything they have brought in since is exactly the answer
to "was this spend worth it".

Fed to the route by a **second** `users.findMany` selecting `referralSource`
rather than by widening the shared health-classification select — the same
choke-point tradeoff `monetization-source.ts` already makes, because a copy of
`classifyAllUsers`'s rules would cost more than one extra query. Test/synthetic
accounts are excluded via that same classification verdict, no separate check.

`/v1/*` and OpenAPI are untouched — this is admin-only, with no client
surface. No feature flag: the table and routes are always live, and the
weekly Monday-morning founder reminder (`notifyFounderAdSpendReminder`,
`services/founder-notify.ts`) rides `FOUNDER_NOTIFY_ENABLED` alone rather than
a flag of its own — a nudge into a disabled feed has nothing to deliver.

### `events` / `waitlist_applications`

Phase 1 of the offline launch-event subsystem
([LAUNCH_EVENTS_PRODUCT_SPEC.md](../product/domains/launch-events.md)): a founder
creates an event in a launched market, people apply, and the applications are
tiered and moderated. Ticketing, the door scanner and the in-event pairing
rounds are later phases and bring their own tables — nothing here reads a
ticket, because no ticket exists yet.

`events` carries the venue as a **frozen snapshot** (`venueName`,
`venueAddress`, `venueLat/Lng`) with `curatedVenueId` only as a link: the
nightly venue re-validation cron deactivates rows when a place closes, and an
event that already happened must not lose its own address two months later.
`timeZone` is on the row for the same reason `SerializedMatch.timeZone` and
`CalendarState.timeZone` exist — `startsAt` is an instant and every surface
draws it on a wall clock, which for a traveller is not the device's.

`waitlist_applications` is `@@unique([eventId, userId])`, so a re-application
is the same row and a retry is idempotent by construction. **This is an EVENT
admission gate and never an account-level one**: the product's own admission
gates are the contact rail and mandatory liveness (PRODUCT_SPEC §1.1/§1.4),
and a `waitlisted` applicant is a full, matchable user who simply is not on
one door list.

**Admission policy is per event** (`admissionPolicy`), and the default is the
conservative one:

| policy | behaviour |
|---|---|
| `manual` (default) | every verified applicant → `pending_review`; the attractiveness score is a hub SORT KEY and gates nothing |
| `open` | every verified applicant is auto-approved, subject only to capacity and the balancer — "the ticket is the condition" |
| `scored` | the `autoApproveScore` / `reviewFloorScore` thresholds tier automatically |

Three properties of `services/event-admission.ts` are load-bearing and silent
when broken, so each is pinned by a test:

- **The score is READ, never computed.** It is the 0..100 figure the vision
  pass already produced once at verification (`eloSeedDetails.score`,
  `services/elo-seed.ts`). This module never calls OpenAI: a second pass would
  cost money per applicant and could disagree with the score `V_league` is
  already using for the same person. `readAttractivenessScore` falls back to
  inverting a **seeded** `eloScore`, and returns null for an unseeded profile
  rather than inverting the schema default of 500 into a fabricated median.
- **Verification is the floor under every policy.** `screening` is the only
  tier an unverified applicant can hold, and the admin decide route refuses to
  hand-approve out of it — an admin button is not an exception to a product
  invariant. Tiering re-runs for free when the verification pipeline activates
  them.
- **The gender balancer downgrades, never rejects**, and it can correct
  itself. Past `ratioTolerance` an auto-approval of the overrepresented gender
  becomes `pending_review` (a human decision, not a waitlist); an admission
  that moves the share TOWARD target is always allowed even from outside the
  band, because the naive "must land inside tolerance" test blocks the very
  admissions that would fix a skewed cohort. Below `RATIO_GATE_MIN_COHORT`
  (10) it does not gate at all — the first applicant is 100%/0% of the
  admitted set by construction, so a floorless balancer deadlocks the event it
  exists to balance.

`scoreAtTiering` / `genderAtTiering` are **frozen at the moment of tiering**,
the same rule `match_score_logs` follows: a photo edit re-runs the
verification pipeline and can re-seed the score, and a decision already taken
must not silently change its own basis.

The only automatic trigger is the verification pipeline's `verified` branch
(`settleEventAdmission`, beside `settleReferralReward` and on the same
contract — optional dep, best-effort, never blocks activation), ordered
**after** the Elo seed so the score exists by the time a `scored` policy reads
it. `POST /admin/events/:id/retier` is the repair path for applications left
in `screening` because the flag was off when their owner verified.

Admin surface: `/admin/events` (CRUD + a lifecycle CAS that refuses an illegal
transition by name), `/admin/events/:id/pipeline` (funnel, admitted ratio,
capacity fill, and a score **decile histogram** rather than a per-user list —
names beside attractiveness scores is a spreadsheet waiting to be exported),
`/admin/events/:id/applications` (the moderation grid), `.../decide`,
`.../bulk-approve` (capacity-bounded, per-row CAS so a founder in another tab
loses one row rather than the batch), and `/admin/events/:id/feedback` — the
post-event read (§11): every `unsafe` row **in full, with the reporter named**,
the rating distribution and mean, safety counts, and a funnel of
`pairings → metConfirmed → mutualThumbs → matchesCreated`. That funnel is the
only place the party's actual yield is visible; `responseRatePct` is `null` on
an empty denominator, never `0`. Pipeline denominators exclude test and
synthetic accounts via the same `classifyAllUsers` verdict monetization uses,
and report `excludedTestUsers`; an empty denominator is `null`, never `0`.

Gated by `EVENTS_FEATURE_ENABLED`, and off is genuinely inert rather than
merely quiet: without the flag the pipeline hook is not even wired as a dep,
so no registration can land in a queue nobody is watching, and every admin
route answers **404** — the subsystem is not part of the API surface at all.

### `event_ticket_tiers` / `event_tickets` / `event_staff_tokens`

Phase 2 of the same subsystem: the free ticket, the door code, and the people
who read it. **There are no money columns anywhere in these three tables, and
their absence is the design** (founder decision 2026-08-29) — the ticket is the
entry *condition*, not a product, so there is no price, no charge id, no refund
state and no claim TTL to expire an unpaid hold. `handlers/payments.ts` is not
touched by this phase.

**`event_ticket_tiers` is where capacity actually lives**, and `claimed` is the
only counter in the product incremented by a **conditional atomic update**
(`SET claimed = claimed + 1 WHERE claimed < capacity`) rather than by a
count-then-insert. Two people racing for the last seat both read "49 of 50"
under any read-first scheme; here one statement updates a row and the other
updates zero. It runs in the INTERACTIVE `$transaction` form — the array form
cannot short-circuit, so a CAS written that way is an after-the-fact report
rather than a guard, which cost this codebase a double reward once
(DECISIONS.md 2026-08-27). `kind` is `free_rsvp | vip_guestlist` and
`requiresAdmission` is derived from it at creation; **readers must filter on
`kind`**, because the two are equivalent only by that derivation and the schema
lets them diverge — at which point `requiresAdmission` silently hides an
ordinary open tier from the one screen that can claim it.

**`event_tickets` is `@@unique([eventId, userId])`**, so a second tap returns
the ticket already held instead of consuming another seat — the idempotency is
the index's, not the handler's. `qrNonce` is the rotatable half of the door
code: rotating it kills every code already in the wild for that ticket, which
is what "my code leaked" actually does. `checkedInAt` carries the **single-use
guarantee, and it is the database's rather than the signature's** — two doors
scanning one screenshot in the same second produce one admission and one
`already_used`, via the same CAS shape. `checkedInByTokenId` records which door
opened, so a disputed entry has an owner rather than only a timestamp.
`perkRedeemedAt` is the same CAS again, for the same reason: a bar with two
staff phones pours one cocktail. Revoking a ticket releases its seat with
`GREATEST(claimed - 1, 0)` — a counter allowed to go negative silently inflates
capacity for everyone after it.

**`event_staff_tokens` is the fourth auth rail in the product**, and it exists
because venue staff are not users: no account, no Telegram, no profile, no place
in the matching pool, so neither rail of `requireCanvasAuth` can describe them.
A token is bcrypt-hashed (so it cannot be looked up by equality — every live
token *for the named event* is compared, bounded by how many doors one party
has), scoped to one event, and revocable, so a phone left behind a bar cannot
admit anyone to the next party. The raw value is shown once at mint and never
again.

The door code itself is stateless and lives in no table: an HMAC-SHA256 payload
(`services/event-qr.ts`) carrying version, ticket, event, nonce and a 90-second
expiry. Short on purpose — the TTL is what makes a forwarded screenshot useless,
and a client that fetched one code and displayed it forever would hand that
property back. The signature is verified BEFORE expiry (so a forged expired code
reads as forged), and the two strings are length-checked before
`timingSafeEqual`, which throws on a length mismatch and would otherwise answer
500 at a door.

Surfaces: `/v1/events/*` (attendee — `requireCanvasAuth`, so one screen serves
the Mini App and the native client identically) and `/gk/:eventId/*` (the door —
staff token, deliberately outside `/v1` because it is not the product's client
API and must not inherit its shape by accident). The attendee surface reports a
tier as `none | pending | admitted | reserve` and **never a score, a threshold
or the cohort ratio**; it reports `spotsLeft` rather than the raw
claimed/capacity pair. Every door refusal is an HTTP **200** with a named
outcome, because staff have to say a different sentence to the person in front
of them and a 4xx with one message makes the portal useless exactly when it
matters.

Both routers answer **404** with the flag off, so Phase 2 is as inert as Phase
1. `/v1/*` is nonetheless a real client contract now, and `openapi/gennety-v1.yaml`
deliberately does **not** describe it: the native client has no event screen
yet, and a spec entry for a surface no client generates from is a contract that
drifts unobserved. It is added with the iOS work, not before.

### `event_rounds` / `event_round_pairings`

Party Mode — the in-event pairing engine (LAUNCH_EVENTS_PRODUCT_SPEC §9). Every
~35 minutes at a `live` event, everyone present who is not sitting out is paired
with someone they have not met yet tonight, given a named spot and two digits to
say out loud, and left alone.

**There is no message column anywhere in either table, and that is the design
rather than an omission.** Party Mode lives INSIDE the NO IN-APP CHAT invariant
instead of carving an exception out of it the way the pre-date proxy chat does:
the conversation it arranges happens in a room, so the product's whole
contribution is deciding who stands where. The interaction surface is exactly
three things — read your pairing, say you found each other, take a break.

**The allocator is the product's own.** `selectRoundPairings`
(`services/event-rounds.ts`) enumerates edges and hands them to the same
`scorePair` + `greedyPair` the Thursday drop runs, which is the §Campus Radar
rule applied again: a second pairing implementation is a second definition of a
good match, and the two diverge silently. Three things differ, each deliberate:

- **The candidate set is the room**, loaded by `loadAttendees` rather than by
  `loadEligibleUsers`. The matching pool's eligibility — the 24-hour candidate
  cooldown, the single-live-match rule, the contact rail — is all wrong here:
  someone with a date already scheduled for Friday is exactly the person who
  should still be meeting people at a mixer on Wednesday, and refusing to pair
  them would be the product enforcing a rule about matching against something
  that is not matching. What IS shared is the field list — the mapping is typed
  as `BatchUser`, so a field added there is a compile error in the loader rather
  than an undefined the scorer silently reads as a zero.
- **Same-city is dropped.** `areMutuallyCompatible` was split so Party Mode can
  call `preferencesAgree` — the half that is about the people — without the half
  that is about where they live. Standing in the venue is stronger proof of
  locality than a profile column, and someone who changed their dating city
  after being admitted must not become unpairable at a party they are at.
- **`V_league` is lifted, not removed** (`EVENT_LEAGUE_FLOOR`, 0.4). The weekly
  engine floors at 0.05, i.e. "effectively never matched" — right when the
  product is choosing ONE person for someone, wrong in a room where the
  alternative to a slightly mismatched pairing is standing alone for twenty
  minutes.

The lifetime pair ban is respected in full (founder decision §14.2):
`loadExcludedPairs` is exported and called here, so the party and the Thursday
drop agree on who is off-limits rather than each deriving it.

**`@@unique([eventId, index])` is the round's double-open guard, and it is
load-bearing rather than tidy.** The round row and ALL of its pairings are
created in one interactive transaction, so a second worker tick racing to open
round N loses on that constraint and writes no pairings at all. That is what
makes "a user is in at most one pairing per round" true without a constraint
Prisma cannot express — a uniqueness spanning two columns in either order, the
same shape `matches` solves with its boot-created canonical-pair index.
`planCurrentRound` is a pure function of the event's start time and the clock,
so two ticks a minute apart inside one window agree on the index; the tick only
decides how LATE a round opens.

**Nothing here is ever penalised.** An unconfirmed pairing simply lapses — no
Elo, no `silentIgnoreCount`, no `standbyCount`. An event is a party, not a
contract, and the §3.1c rule that scripted outcomes must not become data applies
with more force to outcomes nobody agreed to. The sit-out priority bump takes
`composeScore`'s `starvationBonus` slot but lives **in memory, per event**, so it
can never leak into the weekly famine measure; losing it fails in the safe
direction (someone is paired on merit), which is the test the same file's
durable `EventTicket.pausedAt` deliberately fails — an opt-out lost to a deploy
would re-enter somebody who had just asked to be left alone.

`metConfirmedA/B` is **blind until both**, the §3.4 rule again: a single
confirmation is indistinguishable from none on the other side's screen, so the
first tapper cannot learn the answer before giving their own. `thumbsA/B` and
`matchId` are written by Phase 4 and are unused today.

**The live view carries no partner photo, on purpose.** The photo rail
(`public/partner-photos.ts`) is match-scoped end to end, so a face here would
mean widening a live security path for a dark feature — and at a party the thing
that finds someone is the spot plus two digits said out loud. A face turns that
into scanning the room comparing people, which is the behaviour §9.3 exists to
keep out of the venue.

Surfaces: `GET /v1/events/:id/live`, `POST /v1/events/:id/pairings/:pid/met`,
`POST /v1/events/:id/pause`. Delivery is a `event.round` push, deliberately NOT
in `TIME_SENSITIVE_PUSH_TYPES` — the recipient is at a party holding their
phone, and punching through Focus is for something that matters when nobody is
looking at the screen.

### `event_feedback`

Phase 4 of the same subsystem: the post-event loop (LAUNCH_EVENTS §11). One
row per (event, attendee) — `rating Int?` (1..10), `safety String?`
(`everything_fine` | `uncomfortable` | `unsafe`), `text String?` — with
`@@unique([eventId, userId])`, so a second submission is an upsert rather than
a second opinion, and `@@index([eventId, safety])` for the hub's safety cut.

**`unsafe` is acted on at WRITE time, and that is why there is no
`reviewedAt` column.** The row fires `notifyFounderEventSafetyFlag` in the same
call that stores it, so the founder learns of it in seconds rather than when
someone next opens the hub; the hub then lists those rows in full, with the
reporter's identity, because a safety report is not anonymous to the person who
has to act on it. Adding a review marker would invite the opposite reading —
that a report waits in a queue.

**And it is exempt from retention.** `workers/retention.ts` sweeps this table at
90 days like `proxy_messages`, EXCEPT rows carrying `safety: "unsafe"`, which
are kept indefinitely — the same treatment `reports` already gets. The
predicate is written as an explicit `OR: [{ safety: null }, { safety: { not:
"unsafe" } }]` rather than a negation, because in SQL `NOT (safety = 'unsafe')`
is neither true nor false for a NULL and would silently retain every row that
carried no safety answer at all, which is most of them.

`onDelete: Cascade` from both `events` and `users`.

**`EventTicket.recapSentAt` is the fan-out marker, and it is per ATTENDEE
rather than per event.** A recap is a fan-out over everyone who walked through
the door, so a per-event stamp would let one unreachable phone either strand the
rest (stamp last) or make the whole event look delivered (stamp first). It is
written only AFTER a successful send, so a failed one is simply retried by the
next tick — the same reasoning that puts `safetyNoteSentAt` on the side rather
than on the pair.

**`User.ticketDiscountSource`** (`famine` | `event_feedback`) tells the two
mechanisms apart after the fact. There is ONE discount slot per user and they
share it, so without the column a 40% discount is indistinguishable from a
famine perk that happened to be small. **Analytics and audit only** — pricing
reads `ticketDiscountPct`, never this. The collision rule is asymmetric and
deliberately comparison-free: famine REPLACES whatever is in the slot, while
event feedback only ever fills an EMPTY one, because overwriting a live 77%
famine discount with the smaller perk would take something away from a user as
a reward for helping us (PRODUCT_SPEC §3.5b).

Surfaces: `GET /v1/events/:id/recap`, `POST
/v1/events/:id/pairings/:pairingId/thumbs`, `POST /v1/events/:id/feedback`, and
`GET /admin/events/:id/feedback`. A mutual thumbs-up becomes a real `Match`
with `source: "event"` — see `match-engine.ts`'s `preAccepted` allocation, which
is what lets the row be born at `negotiating` rather than asking two people a
question they have already answered.

### `profiler_answers`

One row per (user, Profiler question) — `questionId`, `priority`
(`ProfilerPriority`), `answerText`, `skipped`, `skipReturned`, `cycleId`;
`@@unique([userId, questionId])`, `onDelete: Cascade` from `users`. `cycleId`
carries the drop cycle the row was last written in, which is also what makes a
**situational** question (`refresh: "cycle"` in the bank) eligible to be asked
again next cycle — its new answer overwrites the row, since only the current
snapshot is useful icebreaker fuel. Backs the
Phase 1b Profiler (see [PRODUCT_SPEC.md](../product/product-spec.md) §Phase 1b): timed
post-onboarding Q&A that is the **primary source** for icebreakers
(`date-lifecycle.ts`) and wingman hints (`wingman-hint.ts`).
Deliberately NOT read by the matching engine. Written by
`handlers/profiler/router.ts` + `services/profiler.ts`; scheduled by
`workers/profiler.ts`. The question bank is first-party data in
`packages/shared/profiler-questions.ts`.

**`memeFileId` / `memeKind` — Telegram is the store, we hold the pointer
(2026-09-04).** Questions that declare `acceptsImage` (today only humour: "send
your favourite meme") accept a picture as their answer. `answerText` then holds
the vision-written one-sentence DESCRIPTION — that is what every downstream
generator reads, and they only ever consume text — while `memeFileId` holds the
Telegram `file_id` the picture arrived as. Nothing goes to a bucket, exactly as
`voice_prompts.telegramFileId` and the profile photos already work, so there is
no retention sweep and no `collectOwnedPaths` entry to keep in step; the `users`
cascade takes the pointer with the account.

`memeKind` (`ProfilerMediaKind`: `photo` | `sticker`) exists because Telegram
`file_id`s are type-tagged — `sendPhoto` with a sticker's id fails outright.
Everything that is not a still sticker was captured as a plain JPEG thumbnail, so
two values cover the whole space the capture path can produce.

Both columns are written **only** on the path where the description came from the
picture. A caption fallback (vision down, or the model refused the content)
records text and no pointer, which is what makes the §3.12 paid reveal safe
without a moderation pass of its own: an unsafe image never gets a pointer, so it
can never be re-sent. The columns move together with `answerText` in one upsert,
so a text answer clears a pointer a previous image answer left — the two describe
one answer and must never disagree.

### `voice_prompts`

One optional recording per user (`@@unique([userId])`, `onDelete: Cascade`) —
PRODUCT_SPEC §1.3b, VOICE_PROMPT_PRODUCT_SPEC.md. Columns: `telegramFileId` /
`storagePath` (exactly one is set — Telegram is the store on its rail, our
bucket on the native one), `durationSec`, `mimeType`, `fileSize`, `waveform`
(normalized 0..100 peaks), `transcript`, `validationVersion`/`validatedAt`.

**Not an entry in `Profile.profileMedia`.** A Telegram voice note cannot join a
media group, so it is a separate `sendVoice` regardless; keeping it out leaves
`parseProfileMediaItem`, `sendProfileMediaCard` and the
`photos[i] ↔ photoFaceScores[i]` invariant completely untouched. The unique
constraint enforces "0 or 1" in the database rather than in application code,
and a re-record overwrites the row — there is no history and nothing to
reconcile.

**`transcript` is an embedding input, and its home is the whole design.**
`refreshDirtyEmbeddings` (`workers/embedding-refresh.ts`) reads it straight from
this column and appends it to the composed input, exactly as it already does for
`partnerPreferences` and `negativeConstraints` — neither of which is folded into
`psychologicalSummary` either. Folding was the first draft and was reversed
(DECISIONS 2026-08-21) for two reasons that are properties of the data rather
than of taste: `handlers/menu/edit-profile.ts` replaces `psychologicalSummary`
wholesale, so the About-me editor would silently wipe it; and a transcript
changes on every re-record, so `appendVibeToSummary`'s `includes()` idempotency
would append rather than replace and multiply the voice's weight in the vector.

**`storagePath` must stay covered by `collectOwnedPaths`**
(`services/account-deletion.ts`). A native-uploaded clip leaves BYTES in
`SUPABASE_VOICE_BUCKET`; the row cascades away on deletion and the audio would
not, silently. The path is written as `${userId}/…` precisely so that filter
matches it.

Written by `services/voice-prompt.ts` (the single writer, which also marks the
profile dirty and refreshes in one place) and read by `handlers/matching/pitch.ts`,
`workers/embedding-refresh.ts` and `public/routes/voice-prompt.ts`. Inert unless
`VOICE_PROMPT_ENABLED`.

### `profile_music_tracks`

Up to three Spotify tracks a person pinned to their profile (decision
2026-09-11): `position` 0..2, `@@unique([userId, position])` +
`@@unique([userId, spotifyTrackId])`, `onDelete: Cascade`. Columns mirror the
`MusicTrack` contract — `spotifyTrackId`, `title`, `artists` (joined with ", "),
`albumName`, `coverUrl` (Spotify's CDN URL; bytes are never copied),
`spotifyUrl` (built as `open.spotify.com/track/<id>`, not taken from Spotify's
response), `previewUrl` (null for every app registered after 2024-11-27),
`explicit`, `refreshedAt`.

**A cache of Spotify's metadata, not our data.** The Developer Terms allow only
temporary caching and require what is shown to be current, so the nightly
`refreshStaleMusicTracks` re-reads rows older than a week and deletes a track
Spotify no longer serves. `refreshedAt` is indexed for that scan.

**Display-only, by contract.** The Developer Policy forbids analysing Spotify
content for "building profiles of users" and ingesting it into any ML/AI model,
so no embedding, matcher, pitch or prompt reads this table.
`services/music/ai-boundary.test.ts` fails when a reader appears outside
`services/music/profile-music.ts` (the single writer) and
`public/matches-service.ts` (the partner's tracks on the pitch). Inert unless
`PROFILE_MUSIC_ENABLED`.

### `date_bump_sessions`

One row per match, created by the first shake (PRODUCT_SPEC §6.2). Columns:
`matchId` (unique, cascade), `userAShakeAt` / `userBShakeAt` (NULL = that side
has not bumped; the sides follow `Match.userAId`/`userBId`, never arrival
order, or a retry by one person would look like the pair), `isVerified` +
`verifiedAt`, `icebreakerDeck` (`Json?`).

**It is the only thing in the product that OBSERVES attendance rather than
asking about it**, which is why it is permitted to write `Match.dateAttended*`
while the T+24h evidence classifier is forbidden from doing so. The rule that
separation protects is "only a human answer becomes data" (`services/
attendance.ts`), and a Bump is a human answer — two people, deliberately, at
the venue, at the time — while a classifier reading a proxy chat is a guess.

`isVerified` and `verifiedAt` are separate because the rewards are
transactional with the flag flip: reliability, the bonus ticket, the attendance
write and the deck all ride the same compare-and-set, so a repeated shake
cannot re-run any of them.

The deck is deliberately NOT `Match.iceBreakersA/B`. That pair is sent five
hours BEFORE the date to someone still deciding what to wear; this one is
unlocked by the pair actually meeting and is written for a conversation already
under way. The earlier one is untouched.

### `user_scratch_maps`

One row per user, created lazily on their first recorded tile (PRODUCT_SPEC
§6.4). Columns: `userId` (unique, cascade), `exploredTiles` (`String[]`),
`exploredPercent`, `discoveredVenues` (`String[]`).

**Tiles, not coordinates, and that is the privacy design rather than a storage
choice.** `exploredTiles` holds geohash precision 6 — roughly 1.2 km × 0.6 km —
so the column can say "they have been around Podil" and can never say which
building. Every other geo column in this schema is per-purpose and per-match
(`Match.vibeLat*` is a departure pin for ONE date); this is the first that
accumulates, which is why the shape of what is stored has to carry the
guarantee rather than a rule someone has to remember.

Written only when `User.scratchMapOptIn` is true, and only from a foreground
ping (the user has the map open) or a verified Date Bump. Nothing writes from
the background — there is no background-location entitlement in the iOS app and
no such permission requested in the Mini App, so that promise is structural.

`exploredPercent` is materialized rather than derived because the client draws
it on every frame and the denominator is a per-market constant the database
does not know. `discoveredVenues` holds `CuratedVenue.id` values free-form (no
FK), so deleting a venue from the catalog never erases someone's history of
having been there — the same rule `TicketLedger.matchId` already follows.

### Date Radar presence (in memory, no table)

The last forty-five minutes before a date are held in a process-local `Map`
(`services/date-radar.ts`), not in Postgres, and that is the design rather than
a shortcut. Every other geographic column in this schema is per-purpose and
per-match; a table of where two people were, minute by minute, on the evening
they met is the one artefact this feature must not create. The window bounds
the data's usefulness at forty-five minutes, so an in-memory lifetime is the
honest one — a restart loses it and the next ping restores it within seconds.

Same single-process caveat as `services/usage-limiter.ts` and
`services/promo-attribution.ts`: correct while the bot runs as one PM2 process,
and something to revisit the day that stops being true. An entry also expires a
few minutes after its last ping, so a phone that has gone quiet reads as
`unknown` rather than as a stale ETA.

### The Scratch Map and the Campus Radar

`services/scratch-map.ts` owns the tiles; `services/campus-radar.ts` owns the
Bonus Campus Drop. They share a section because they are the two halves of
§Scratch Map / §Campus Radar and nothing else — one is per-person and
per-neighbourhood, the other per-university.

**The scratch map's privacy guarantee is `packages/shared/src/geohash.ts`, not
a rule at the call sites.** A tile is precision 6 (~1.2 km × 0.61 km), so
nothing narrower than a neighbourhood is REPRESENTABLE. The module deliberately
exposes no decode-to-a-point: handing callers a centre invites treating a tile
as a location, which is the exact conversion it exists to prevent. `tileBounds`
returns the box, which is what a map layer and a tile count both actually need.

**The denominator is a constant of the city.** `tilesInMarket` walks the
market's circle once per process and counts the tiles whose centre falls inside
it — 2915 for Kyiv, which is π·21² km² to within a percent. Deriving it from
tiles anyone has visited would make everyone's percentage move whenever a
stranger walked somewhere new, and a person who explored nothing would watch
their own number fall.

**Two writers, and the second is the interesting one.** A foreground ping is
the ordinary path. A verified Date Bump also writes — the venue and its tile,
for both sides — and it is allowed to for the same reason the Bump may write
`dateAttended*` while the T+24h evidence classifier may not: it is not a guess
about where someone was. It rides the bump's success path fire-and-forget, and
swallows its own errors, because a souvenir must never cost someone the date
their reliability and bonus ticket depend on.

**`discoveredVenues` holds Google Place ids, not `CuratedVenue.id`.** The
catalog has no uniqueness constraint and the seeder writes one row per
`universityDomain` — Kyiv holds ~538 rows for ~127 real venues — so a row id
would give two people who sat in the same café different histories. Every other
reader in the product already dedupes by `placeId`.

**The Campus Radar needs no baseline table.** "Verified inside the window" IS
the growth, and it is a `verifiedAt` range on rows we already keep; a stored
baseline would be a second fact about the same cohort, wrong from the first
missed tick with nothing to notice. Its cooldown is read the same way — off the
newest `Match` with `source = "campus"` for that domain, which is the record of
the last drop rather than a counter that can drift from it.

**The Bonus Campus Drop reuses the real allocator.** `previewDropBatch(ids)`
takes a restriction, never an exemption: the ids are handed to
`loadEligibleUsersForIds` as its filter, so a user in the cohort who fails
ordinary eligibility is still excluded. A second pairing implementation would
be a second definition of what a good match is, and the two would diverge
silently. It carries a pre-batch blackout for exactly the reason Rematch does —
a single-cohort run can take a candidate the globally-optimal Thursday batch
needed — and it deliberately leaves starvation counters alone: incrementing
them would punish a lively campus, resetting them would hand one a priority
advantage in the next batch.

Inert without `CAMPUS_DROP_ENABLED`; the worker is not scheduled at all.

### `no_match_notices`

Audit row for the empathetic "no match this week" DM. `tier` is the
consecutive-famine count; `dropDate` is truncated to the UTC day of the cron
firing, and `(userId, dropDate)` is unique — both an idempotency guard and
the data source for the dashboard's churn-warning trend.

### `referral_events`

Виральная воронка шеринга: ровно те её шаги, которые сервер ВИДИТ САМ.

Существующая реферальная связка (`User.referralSource` → `referral:<id>`,
`User.referralCountedAt`) отвечает на вопрос «кто кого привёл и когда тот
активировался», но не на вопрос «сколько приглашений для этого понадобилось».
Без знаменателя K-фактор не раскладывается на `i × c`: «мало кто делится»
неотличимо от «делятся, но по ссылке не приходят».

`kind` — `share_sheet_opened` | `invite_sent` | `invite_link_clicked`, обычная
строка, а не Prisma enum (та же причина, что у `Match.source` и
`AdSpend.category`: новый шаг воронки не должен стоить миграции). Закрытый
перечень живёт в `services/referral-events.ts` — единственная запись в таблицу
проходит через этот файл.

`dedupeKey` детерминированный и `@unique` — он И ЕСТЬ гарантия идемпотентности:

- клик — `click:<referrerId>:<hash(clicker)>:<UTC-день>`, поэтому человек,
  десять раз нажавший `/start`, даёт единицу в знаменатель конверсии, а не
  десять; сутки — потому что переход, повторённый через неделю, это уже другое
  событие (вернулся подумав);
- шеринг и отправка — по id подготовленного Telegram-сообщения, то есть ровно
  один акт каждого вида.

Идентификатор кликнувшего кладётся ОТПЕЧАТКОМ (sha256, 16 hex), а не в
открытом виде: ключу нужно только равенство, и в аналитической таблице нет
причин хранить то, из чего можно восстановить человека.

`invite_sent` приходит от КЛИЕНТА (`POST /v1/referral/share-result`), и это не
недоверие к серверу, а факт: `savePreparedInlineMessage` только готовит
сообщение, а выбрал ли человек чат — знает лишь колбэк `WebApp.shareMessage`.
Считать отправкой подготовку значило бы завысить `i` на все передуманные
шеринги.

`referrerId` нулевой у клика по ссылке удалённого аккаунта: внешний ключ
отверг бы такую строку целиком, а терять этот клик значит отдать органике то,
что на самом деле было виральным переходом.

### `hdyhau_responses`

Ответ на онбординговый вопрос «откуда вы про нас узнали».

Зачем он нужен при существующем `referralSource`: тот отвечает, по какой
ССЫЛКЕ человек пришёл, а этот — что человек СЧИТАЕТ источником. Расхождение
между ними и есть тёмное сарафанное радио: пришёл «органикой», а говорит «друг
рассказал лично» — значит, привёл его живой человек, которого ни одна ссылка
не зафиксировала. Доля таких ответов среди неразмеченного притока —
единственная ПРЯМАЯ калибровка `K_wom` (остальное выводится из формы кривой).

`userId` — первичный ключ: вопрос задаётся один раз, второго ответа у человека
нет, есть исправленный первый. `promptVersion` хранит, какую формулировку и
какой набор вариантов человек видел: добавить вариант задним числом и сравнить
с периодом, когда его не предлагали, значит объявить ростом появление кнопки.

`answer` проверяется по закрытому перечню (`@gennety/shared` → `hdyhau.ts`),
поэтому в таблицу физически не попадает ни имя, ни ссылка, ни что-либо ещё,
что человек мог бы вписать руками.

Наполняется только при `HDYHAU_SURVEY_ENABLED`; по умолчанию флаг выключен,
потому что МЕСТО вопроса в онбординге — продуктовое решение, ещё не принятое
(журнал решений, 2026-09-08).

### `virality_days` / `virality_cohorts`

Предагрегат виральности. Считается ночью (`workers/virality-rollup.ts`), а не
на запросе, по одной причине: получить K-фактор одной когорты — значит пройти
регистрации за окно наблюдения, воронку шеринга за то же окно и активации
приглашённых, которые могли случиться позже, и всё это для пяти дней зрелости
и каждого кластера. На запросе это скан `users` за месяцы с джойном на
профили, а читателей у метрики двое и оба ходят регулярно: дашборд и Hermes.

Два зерна, потому что величины разной природы:

- **`virality_days`** — зерно «календарный день привлечения». Здесь живёт
  непрямая виральность: базовая органика (скользящее среднее за
  `BASELINE_WINDOW_DAYS` = 14 ПРЕДЫДУЩИХ дней, сам день в неё не входит —
  иначе всплеск поднимал бы собственную планку), её σ, прирост сверх базы и
  `K_wom`. Разбивка притока: `organicSignups` (атрибуции нет вовсе — это и
  есть ряд, образующий базу), `referralSignups` (личная инвайт-ссылка — прямая
  виральность, считается отдельно), `seedSignups` (всё остальное размеченное —
  знаменатель `K_wom`).
- **`virality_cohorts`** — зерно «когорта × день зрелости». Одна когорта даёт
  пять строк (D1/D3/D7/D14/D30), а не пять колонок, поэтому добавить D60 —
  вставка, а не миграция.

`scope` — `global` | `city:<key>` | `university:<domain>`. Кластерный срез
хранится СТРОКАМИ, а не колонками: число кластеров растёт с каждым запущенным
городом, число колонок расти не должно. В таблицы попадают только кластеры,
набравшие ≥5 регистраций за отчётное окно (`MIN_CLUSTER_SIGNUPS`) — город с
тремя регистрациями даёт K, который меняется втрое от одного человека.

Три правила чтения, без которых числа отсюда вредны:

1. **Невычислимое — `null` с кодом причины, никогда `0`.** `womStatus` — `ok`
   | `immature` (окно базы не набрано) | `no-seed` (нулевой знаменатель).
2. **`mature: false` означает, что окно наблюдения ещё не закрылось.** Строка
   всё равно пишется, чтобы матрица не зияла, но это ПОЛ, а не результат.
3. **Доля шага воронки больше единицы означает недосчёт.** Активации
   восстанавливаются из `referralCountedAt`, существовавшего всегда, а клики и
   инвайты — только с появления `referral_events`, поэтому у исторических
   когорт `clickRate`/`activationRate` равны `null`, а не 200%.

Прогон переписывает окно ЦЕЛИКОМ (удаление + `createMany` в одной транзакции,
а не построчный upsert): это и быстрее, и снимает строки срезов, которые за
окно перестали проходить порог кластера, — при upsert они остались бы навсегда,
показывая устаревшие числа рядом со свежими.

### `founder_reports`

Snapshot of a weekly founder matches report (feature-flagged ops feed, gated by
`FOUNDER_NOTIFY_ENABLED`). Built after the Thursday batch by
`notifyFounderWeeklyMatches` (`services/founder-notify.ts`) and read by the
tokenized report page (`GET /v1/founder/report/:token`). Columns: `token`
(unique crypto-random URL token = the page's sole authorization, never logged),
`weekOf` (UTC day of the batch), `dataJson` (the assembled `WeeklyMatchesReport`
snapshot — pairs + user cards + photo refs; **never** `psychologicalSummary` /
AI-memory dumps), `expiresAt`, `createdAt`. Indexed `(createdAt)`.
`expiresAt` (added 2026-07-26) bounds how long a leaked link is worth anything:
the token is the sole authorization AND rides in the URL, so it also lands in
reverse-proxy access logs and browser history. New rows get 90 days; a **null**
means never-expires, so rows predating the column keep working. Both the page
and its media proxy check it. Standalone model (no user
relation); PII lives only in the snapshot. Because no foreign key can cascade
into JSON, the shared account-deletion service explicitly deletes every report
whose snapshot contains the departing `userId` before deleting the User row.

### `curated_venues`

First-party, hand-curated first-date venues currently scoped by
`universityDomain`. This is the **primary** source for the concierge venue picker
when a same-domain venue pool exists; Google Places is the fallback for
cross-domain city matches (see [PRODUCT_SPEC.md](../product/product-spec.md) §3.7). Standalone model (no user
relation) — the venue pool is now first-party data we own, not a per-request
Places lookup. Columns: `name`, `address`, `lat`, `lng`, `googleMapsUri`,
`category` (validated against the shared whitelist in app code, not a Prisma
enum), `priority` (1 best … 3 acceptable), `tier` (`base`/`premium`/
`alternative`, whitelist-validated in app code — a `premium` venue may exceed
the ≤ MODERATE price cap and is shown-but-locked in the venue-change board
unless a participant has Gennety Premium; an `alternative` venue is the
operator's heavier-cuisine pool (Georgian / Uzbek / Azerbaijani /
Middle-Eastern / Central-Asian), board-only but unlocked and ungated by
Premium — a cuisine classification, not a price tier; the auto-assign picker
reads only quality-qualified `base` rows with positive non-premium price
evidence for commercial/admission venues, so neither non-base tier is held to
the student price cap; PRODUCT_SPEC §3.7 / §3.7b / §3.8), `vibeTags`, `active`,
`lastVerifiedAt`, plus `placeId` (Places resource id for exact re-fetch),
`utcOffsetMinutes` + `openingHours` (Places `regularOpeningHours`, for the
open-at-slot check), `hoursConfidence`, and `isHubFallback` (`is_hub_fallback`,
default `false`, 2026-09-11 — pins a city's hub-fallback venue: when Venue
Intent V2 ends with an empty pool, a pinned row that is open at the slot wins
the fallback pick, the one nearest the pair's midpoint if a city pins several;
migration `20260911120000_date_terminal_and_hub_fallback` pins Kyiv's, ТРІШКИ
БІЛЬШЕ на Золотих Воротах. PRODUCT_SPEC §3.7).

**`hoursConfidence` decides whether a row can be auto-assigned at all**, so it
is worth reading as a gate rather than as metadata. `seed-venues.mjs` derives it
at import (`provider` when Places returned hours, `unknown` when it did not),
and the two values that matter are written by an operator in the city manifest:
`always_open` admits the venue at any slot, `operator_confirmed` clears the
evidence bar while still honouring a recorded schedule. `hoursEvidenceAdmits`
(`services/venue-intent-v2.ts`) is the single reader and fails closed on
everything else, which is the opposite of `isVenueOpenAt` — the §3.7b board's
predicate, which treats "no schedule" as "no reason to exclude". Both are right
for their own caller (PRODUCT_SPEC §3.7), and the split is why public space —
which Google never gives hours for — is invisible to the concierge until
someone marks it. Six Kyiv parks sat unassignable on exactly that until
2026-08-09. The mark belongs in `scripts/curated-venues.<city>.expansion.json`,
not only on the built row: `sync-venues:kyiv --apply` rebuilds rows from Places
and carries over only what the manifest declares (`facetTags`,
`hardCapabilities`, and now `hoursConfidence` + `reviewNote`).

Venue imagery comes exclusively from Google Places — never from the operator.
The legacy operator-supplied `photoUrl` column is **retired 2026-07-25** (never
populated — 0/537 rows — so every curated pick silently shipped a photo-less
date card); it is no longer read or written and the column is kept only so the
change stays additive. What replaced it is **`photoRefs`, a stored array of
Places photo resource names refreshed by the re-validation cron** (2026-08-20):
that cron already issues one Place Details call per venue per night, and Place
Details is billed by the most expensive field requested rather than by their
sum, so carrying `photos` in it costs at most what it already cost.

That is what the §3.7b venue-change board reads. It used to resolve the same
refs itself, one Place Details call per venue per board open, cached only in
process memory (`withCuratedPhotos`) — so every deploy threw the whole city
away and the next board paid for all of it again. `withCuratedPhotos` survives
as the **fallback**, not the main path: it covers a venue the nightly scan has
not reached yet (a full Kyiv cycle is ~10 nights at 30 **places** a night) and
the Places sweep's own rows in a city with no curated catalog. The date card
reads its cover from these same refs since 2026-08-23 and falls back to
resolving one from `placeId` at assignment (`fetchPlacePhotoName`) only for a
venue the scan has not reached — before that it hardcoded null and bought the
answer again on every single assignment, while this column sat filled.

**The "~10 nights" is only true because the cron counts PLACES.** Until
2026-08-23 it scanned rows, so each real venue was re-fetched once per
`universityDomain` copy and the walk also included unlaunched markets: 1712
rows, a 57-night cycle, and `photoRefs` reaching **0 of 275 Kyiv places** while
landing on 90 rows in cities nobody can match in. See `venue-revalidation.ts`.

**An empty Places answer never overwrites stored refs.** An absent `photos`
field is indistinguishable from a partial 200, so the cron treats empty as "no
news" — the same rule it already applies to `rating`/`priceLevel`. Writing one
through would blank a venue on the board until its next scan, i.e. ~10 nights,
against the 5 minutes the in-process cache held an empty answer for.

**There is no uniqueness constraint on this table, and the seeder writes one row
per `universityDomain`** — Kyiv holds 538 active rows for 127 real venues, five
copies of each (90 premium rows = 18 venues), identical in every field a reader
uses (verified against production: 0 drift across 111 duplicated venues).
**Every reader must therefore dedupe by `placeId`** — including the WRITER:
`venue-revalidation.ts` did not until 2026-08-23, which is what made copies
drift on `lastVerifiedAt` at all (it refreshed them one at a time) and cost one
Places request per copy. It now settles every copy in a single `updateMany`, so
in steady state the copies agree on that column too.
`venue-intent-v2.ts` has deduped
since it shipped; `services/venue-change.ts` did not until 2026-08-03, and the
result was a board showing the same three places four times each once its scope
moved from `universityDomain` (which took exactly one copy) to `cityKey` (which
takes all five). Both readers now sort so the most recently verified copy wins,
so which duplicate survives is a decision rather than insertion order.
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

### `place_cache`

The Google Places response cache, one row per `place_id`. Written and read by
`services/place-cache.ts`; the only layer between us and a re-bought Place
Details request.

**Why it exists.** People choose a departure point from a short list — metro
stations, campus buildings, a couple of squares — so the same handful of places
is resolved over and over across every user in a city. Before this, each of
those resolutions was its own Place Details request, and the only cache in the
product lived in process memory (`services/venue-change.ts` → `photoCache`) and
went cold on every deploy: a release threw a warmed city away and the next board
open re-bought it.

**The 30-day TTL is contractual, not housekeeping.** Google's terms permit
caching Places *content* for at most 30 days, while `place_id` itself may be
stored indefinitely — which is why the id is the primary key and everything else
hangs off `refreshedAt`. A row past its TTL is a **miss**, not a stale hit: the
caller re-fetches and overwrites. `prunePlaceCache` then deletes what expired,
so the table neither grows without bound nor holds content longer than
permitted, even for a place nobody asks about again. The prune runs on the
nightly re-validation tick and deliberately runs **before** that tick's
no-API-key early return, and in demo mode where the scan itself is suppressed —
the deadline applies to a deployment that cannot re-fetch just as much as to one
that can.

Columns: `place_id` (PK), `name`, `address`, `lat`, `lng`, `photo_refs`,
`refreshed_at` (the TTL clock, not a birthday), `created_at`. Indexed by
`refreshed_at` for the pruner. Writes are field-scoped, so the photo path
(`photo_refs` only) cannot blank the coordinates `/v1/location/resolve` stored,
and vice versa — which is also why a cached row with no coordinates is treated
as a miss by the resolver rather than as a place with no location.

**Photo bytes are absent by design and must stay absent.** Caching Google's
images is not permitted — the same rule under which the date card streams them
at render time and keeps nothing (`services/date-card/photo-source.ts`). This
table stores photo *resource names* only. The Place Photo bill is reduced by
issuing fewer requests instead: the proxy accepts only the two widths the client
renders (each distinct width is separately billed), and board tiles defer
loading until they are near the viewport (`apps/webapp/src/photo-defer.ts`).

An **empty** `photo_refs` array means "the answer we cached carried no photos",
which is not the same as "this place has none" — an absent `photos` field is
indistinguishable from a partial 200 (`fetchPlacePhotoNames`), so an empty
answer is never persisted and never read as authoritative.
