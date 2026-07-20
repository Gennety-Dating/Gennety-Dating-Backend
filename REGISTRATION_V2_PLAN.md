# Registration v2 — Dual-Track Auth + Mandatory Liveness (Production Plan)

> Status: **IMPLEMENTED through Phase 5 (2026-07-07)** — phone rail (ca9a0ac),
> sign-up fork (0ac8f15), mandatory liveness (a7f49be), matching union gate
> (756e776), student bonus (dd6c391), copy/admin/docs (this commit). D1–D4
> resolved per the inline recommendations. Remaining: Phase 6 (dev-bot E2E walk
> of both tracks, deploy + staged flag flip). Authored 2026-07-07.

## Product decision (from the founder)

Production opens beyond university students while keeping a first-class
university community:

1. **Two registration tracks** with an explicit fork at sign-up:
   - **Student track** — university email OTP (existing flow).
   - **General track** — phone number (Telegram one-tap `requestContact`) for
     users arriving via external ad channels.
2. **Mandatory Liveness (Persona)** for BOTH tracks. The current two-step
   "soft skip + Elo penalty" path is removed for new users; verification
   becomes a hard activation gate.
3. **Student loyalty**: registering with a university email is actively
   rewarded (free Date Tickets at email verification) because the domain is a
   stronger trust + community signal and improves ranking/recommendations.

## Current state (verified in code, 2026-07-07)

- Prod contact gate: university-email OTP only (`ALLOWED_EMAIL_DOMAINS`),
  enforced in the onboarding Mini App (`onboarding.tsx` phases
  `email` → `otp`), the onboarding agent (`send_otp_email`/`verify_otp`
  tools), and `/v1/telegram-onboarding/complete`.
- Prod matching hard-gates on `universityDomain IS NOT NULL` in **three**
  places: `buildCandidateSql` (rule 4), `loadEligibleUsers` (both queries),
  and the `findCandidatesFor` seeker check (`match-engine.ts` ~905, ~1252,
  ~1293).
- Verification: Persona liveness + Rekognition face-match is skippable
  (`verificationSkippedAt`, `UNVERIFIED_ELO_PENALTY = 150`); pool excludes
  only `rejected`/`pending_review`; `verified` auto-activates
  (`verification-pipeline.ts` ~748).
- The phone rail this plan builds is the full set: `User.phone @unique` +
  `phoneVerifiedAt` schema, `handlers/onboarding/phone.ts` (trusted
  `contact.user_id === from.id` path, E.164 normalize, P2002 "number taken"),
  Mini App `PhoneGate` (poll `/state` until verified), track-aware
  `/complete` gate (`phone-required`), match-engine phone gate, agent-prompt
  adaptation, tests. It lands as ONE BRANCH of the fork, not a replacement of
  the email gate.
- Ticket wallet already supports idempotent ledger-claim grants
  (`verification_bonus`, `welcome_gift`) — the student bonus reuses this
  exact mechanism.

## Architecture decisions

- **`User.registrationTrack`** (`student` | `general`, nullable for legacy):
  explicit column set at the fork. Derivable from data, but explicit is
  cleaner for gates, analytics, and future "upgrade to student" flows.
- **Contact gate is track-aware**: student → email OTP; general → phone
  one-tap. `/complete` returns `email-required` or `phone-required` by track.
- **Mandatory liveness is enforced at ACTIVATION, not in the pool SQL.**
  New users can never become `active` without `verified`, so the weekly pool
  stays clean by construction; the pool gate keeps its current
  `notIn (rejected, pending_review)` shape. Legacy active users are
  grandfathered (see D1).
- **Matching contact filter** becomes the union rail in all three gate sites:
  `(is_email_verified AND university_domain IS NOT NULL) OR
  phone_verified_at IS NOT NULL`.
- **Feature flags**: `PHONE_AUTH_ENABLED` (fork + phone rail visible) and
  `MANDATORY_VERIFICATION_ENABLED` (hard gate). Ship dark, flip together at
  launch; either can be rolled back independently.
- **Mobile/Expo stays email-only in v1** — phone one-tap is a Telegram
  affordance; SMS OTP for mobile is deliberately out of scope (no SMS
  provider today).

## Work plan (phases ≈ solo focused days)

### Phase 0 — Build the phone rail (~1–1.5 d)
- Schema: `User.phone String? @unique`, `phoneVerifiedAt DateTime?`,
  `registrationTrack String?` → `db:push`.
- `packages/shared` `normalizePhoneE164` (+ tests).
- `handlers/onboarding/phone.ts` + router registration (contact handler with
  the own-number trust check and 5-language inline copy).
- Mini App `PhoneGate` component + `/v1/telegram-onboarding/state` exposing
  `isPhoneVerified`/`phone`.
In prod everything lands behind `PHONE_AUTH_ENABLED` and does NOT yet replace
the email gate.

### Phase 1 — Registration fork (~2–3 d)
- New Mini App phase `path` after `consent`: two cards — "🎓 University
  email" (sells the ticket perk) vs "📱 Phone number". Persists
  `registrationTrack`; back-navigation map updated; five-language i18n.
- Student track → existing `email`/`otp` screens; general track → `PhoneGate`;
  both continue to `city` unchanged.
- `/v1/telegram-onboarding/complete`: track-aware gate
  (`email-required` | `phone-required`).
- ~~Website pre-registration handoff (`auth_<token>`) pre-verifies email →
  auto-select student track, skip email screens (current skip logic reused).~~
  **Removed 2026-07-19** — the website no longer runs onboarding; it routes to
  the `/app` platform chooser and everyone onboards natively. The generic
  skip-what's-resolved logic stays (for dev-bypass / mobile-first), but no
  pre-filled state originates from the web anymore.
- Onboarding agent: track-aware prompt + finalize gate — email OTP tools only
  for student track; general track never asked for email.
- Tests: fork state machine, both `/complete` gates (incl. phone-required),
  agent gate tests.

### Phase 2 — Mandatory liveness (~1.5–2 d)
- Verification CTA (`handlers/onboarding/verification.ts`): remove the
  skip fork for new users behind `MANDATORY_VERIFICATION_ENABLED`; CTA
  becomes "Verify to start matching" (copy states it's required). Legacy
  skip callbacks stay registered for in-flight users.
- Activation only via the pipeline's `verified` outcome (already
  auto-activates). `pending_review`/`rejected` messaging updated: rejected →
  guided photo-edit rerun (existing path); pending_review → "we're
  reviewing" + admin queue.
- Re-engagement: extend the drop-off chain to cover the "stalled at
  verification CTA" state (today the chain targets onboarding drop-off).
- Admin: alert/ordering for `pending_review` backlog — with no skip escape,
  review latency directly blocks activation (infra failures route here by
  design).
- `UNVERIFIED_ELO_PENALTY` becomes legacy-only (grandfathered users keep it).
- Tests: activation gate, CTA rendering per flag, legacy callback tolerance.

### Phase 3 — Matching engine integration (~1–1.5 d)
- Replace `universityDomain IS NOT NULL` with the union contact rail in
  `buildCandidateSql`, `loadEligibleUsers` (both queries), and the
  `findCandidatesFor` seeker check.
- Educational homogamy: `major`/domain absent for general users → verify the
  existing present-factor renormalisation handles it (spec says yes; add a
  test with a mixed student/general pair).
- Curated venues: scoped by shared `universityDomain` → general/mixed pairs
  automatically use the Places fallback (no code change; add a test).
  Backlog: city-scoped curated pool.
- Elo: every new user is now vision-seeded at verification — no scoring
  change needed.
- Student ranking: educational homogamy + shared-domain curated venues
  already prefer student-student pairs; an explicit student-affinity bonus is
  deliberately DEFERRED until accept/decline data shows a gap.
- Tests: matching SQL integration tests → union-gate matrix (email-only /
  phone-only / both / neither).

### Phase 4 — Student loyalty perks (~0.5–1 d)
- New `TicketLedger` reason `student_bonus`: **+2 Date Tickets** granted once
  at university-email verification (idempotent serializable ledger claim,
  same pattern as `verification_bonus`). Stacks with welcome gift +
  verification bonus → students start with a visibly fuller wallet.
- Grant DM in 5 languages explaining the mechanic; fork-screen copy sells the
  perk BEFORE the choice; My Tickets copy mentions the student bonus.
- Backlog (not v1): 🎓 student badge on the pitch/match card, student-only
  curated venues, campus events.

### Phase 5 — Copy, admin, docs (~1–1.5 d)
- Copy audit: onboarding visual scenes + menu i18n move to a shared neutral
  tone; student flavor gated on track (the campus vibe stays for students
  rather than being neutralized across the board).
- `my-profile` / serializers: show "verified via phone" when no domain.
- Admin audience/gender analytics: student vs general segmentation.
- Docs: PRODUCT_SPEC core principles (dual-track replaces "Hyper-Local
  Student Focus (Corporate Email)"; identity-verified becomes mandatory),
  ARCHITECTURE (schema, API, gates), AGENTS guardrails ("corporate email
  mandatory" → track-aware; verification "stays meaningful" → "is
  mandatory"), deploy.md (new flags).

### Phase 6 — QA + rollout (~1 d)
- Full typecheck + test suites; E2E walk of both tracks on the dev bot
  (dev-bypass updated for phone).
- Deploy: `db:push` (additive columns only), env flags dark → staged enable.

**Total: ≈ 8.5–11.5 focused days.**

## Phase 6 — manual E2E checklist + rollout order (2026-07-07)

Everything automatable is done: full workspace suite green (bot 1506 / webapp
108 / shared 139), integration matrix green on the docker test DB, full build
green, dev-bypass stamps `registrationTrack=student`. What remains needs real
Telegram accounts on the dev bot (`@gennetytestbot` + ngrok for the Mini App):

1. **Student track**: /start → fork shows both cards (with
   `PHONE_AUTH_ENABLED=true` in `.env.local`) → pick "university email" →
   OTP → city → …handoff. Expect: `registrationTrack=student`, +2 tickets DM
   (`TICKET_FEATURE_ENABLED=true`), My Tickets balance 2.
2. **General track**: second account → pick "phone" → one-tap share → PhoneGate
   auto-advances → city → …handoff. Expect: `phone`+`phoneVerifiedAt` set,
   track=general, NO student bonus, My Profile shows no 🎓 line.
3. **Mandatory liveness** (`MANDATORY_VERIFICATION_ENABLED=true`): CTA has no
   Skip; complete Persona sandbox → auto-activate; check the stalled account
   gets `verifyReminderNudge` after ~15 min idle.
4. **Track switch**: on the fork pick phone, go back, pick email — /complete
   must demand the CURRENT track's rail.
5. **Matching smoke**: seed a student+general pair in one city → run the batch
   → pair matches (union rail).

Rollout order (deploy.md has the full entry):
1. Deploy code + `db:push` (additive `users.phone`/`phone_verified_at`/
   `registration_track`) + Mini App bundle — flags still off → zero behavior
   change.
2. Flip `PHONE_AUTH_ENABLED=true` + `MANDATORY_VERIFICATION_ENABLED=true`
   (+ `TICKET_FEATURE_ENABLED` when monetization launches) → restart.
3. Watch: activation funnel (verification-stall cohort), pending_review
   backlog, `/admin/analytics/audience` registrationTracks split.
Rollback = flip flags back; columns stay.

## Decision points (recommendations inline — confirm before Phase 2)

- **D1. Legacy users.** Recommend **grandfather**: existing active users
  (including Persona-skippers with the Elo penalty) keep matching; mandatory
  liveness applies to new registrations + anyone re-entering onboarding.
  Optional later: re-verification campaign with a ticket incentive.
- **D2. Student bonus size.** Recommend **2 tickets** (≈ $14 value anchor) —
  material enough to steer channel choice, cheap while payments are mocked.
- **D3. General-track copy tone.** Recommend shared neutral base + student
  flavor by track (NOT a blanket adult re-copy — we keep both audiences).
- **D4. Mobile.** Recommend email-only on Expo v1; SMS OTP is a separate
  later project with provider selection.

## Risks

- **Conversion drop** from mandatory liveness — the biggest product risk.
  Mitigation: flags allow instant rollback; funnel dashboards already
  segment by step; watch week-1 activation rate.
- **Persona cost + queue**: every signup now runs an inquiry; and
  `pending_review` (which infra failures route to by design) becomes a hard
  blocker with no skip escape → admin review SLA + backlog alert (Phase 2).
- **One account per number** (P2002) — support path needed for legit
  number-recycling cases (manual admin unlink).
