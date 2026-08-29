# Gennety — Launch Engine, Waitlist Admission & Offline Events

> **Status: SPECIFICATION ONLY (2026-08-29).** No code, no schema, no flags ship
> with this document. Every mechanism below is designed to land additively,
> dark, behind its own feature flags, in four phases. Open founder decisions are
> collected in §14 and MUST be resolved before Phase 1 is implemented.
>
> Product invariants live in [PRODUCT_SPEC.md](PRODUCT_SPEC.md); architecture in
> [ARCHITECTURE.md](ARCHITECTURE.md); deploy in [deploy.md](deploy.md). This
> file owns one subsystem: city-launch events — waitlist admission, founder
> moderation, ticketing, venue check-in, in-event Zero-Chat rounds, and the
> post-event conversion loop back into the core 1-on-1 dating pipeline.

---

## 0. The brief vs. the codebase — corrections made before designing

The commissioning brief described a Next.js / Supabase-RLS / Server-Actions
stack and an existing `calculateAttractivityScore` function. **Neither matches
this repository**, and per AGENTS.md ("report the mismatch before making
behavior-changing assumptions") the divergences are stated here rather than
silently absorbed:

1. **The real stack** is a single Node.js process (`apps/bot`): grammY bot +
   Express public `/v1/*` API (:3101) + Express admin API (:3100), Prisma over
   Postgres+pgvector, Vite/TS Mini Apps served statically, node-cron workers.
   Supabase is used as a **hosted Postgres and object storage**, not as an
   auth/RLS/Realtime platform. There are no Server Actions, no Supabase Auth
   users, and **no RLS policies anywhere in the product** — access control is
   enforced server-side (JWT for the native app, Telegram `initData` HMAC for
   Mini Apps, bearer key for admin). This spec therefore delivers the
   *equivalent guarantees* as an explicit access-control map (§3) instead of
   RLS DDL. Introducing RLS for one subsystem would create a second,
   half-covered authorization model — worse than none.
2. **`calculateAttractivityScore` does not exist.** The real primitive is the
   AI-vision attractiveness pass: `scoreAttractivenessFromBuffers`
   (`services/vision/score-attractiveness.ts`) producing a 0..100 score per
   photo, run once by `seedEloFromVisionDefault` (`services/elo-seed.ts`) on
   the verification pipeline's `verified` branch, persisted as
   `Profile.eloScore` (Elo 200..800, `mapScoreToElo`) with the full audit in
   `Profile.eloSeedDetails`. §4 hooks admission into **that** — a stored,
   already-paid-for score — rather than inventing a second scoring call.
3. **There are no WebSockets in the product**, deliberately. Every "live"
   surface (calendar peer marks, venue-change hearts, ticket gate) is ~4 s
   short-polling from an open Mini App, plus APNs push and rich-draft shimmers
   in chat. Supabase Realtime is **not adopted** here: it would be the first
   WS dependency, it authenticates with Supabase keys the Mini Apps must never
   hold (the demo/prod isolation audit history in DEMO_MODE.md is exactly
   about inherited Supabase credentials), and the in-event cadence (a pairing
   round every 30–45 min) does not need sub-second delivery. §9 uses the house
   idiom: poll fast while the screen is open, push for the moments that matter.
4. **"Waitlist admission" is scoped to EVENTS, never to registration.**
   Today's product has no waitlist: the admission gates are the contact rail +
   mandatory liveness (PRODUCT_SPEC §1.1/§1.4), and those are product
   invariants this spec is forbidden to weaken. An application row here gates
   entry to a *launch event / batch drop*, not to the account or to ordinary
   Thursday matching. A user who is `waitlisted` for an event is still a
   full, matchable user.
5. **Zod validation** exists in the repo's spirit as hand-rolled validators
   (`validateFactValue`, route-level guards); the public API does not carry a
   Zod dependency today. New routes below follow the existing validation idiom;
   adding Zod is a separate dependency decision (AGENTS.md: ask first).

Everything else in the brief maps cleanly onto primitives that already exist
and are reused rather than re-implemented: the ticket wallet + append-only
`ticket_ledger` (§3.5b), Telegram Stars + StoreKit rails (`handlers/payments.ts`),
HMAC signing (`public/init-data.ts`, the referral-card `sig` pattern), the
blind-decision machinery (§3.4), reports and blocks (§Phase 5), the Date
Bump / Date Radar / Living Canvas geolocation primitives (§6), and the
admin analytics API with its 15-min `getOrCompute` cache.

---

## 1. Concepts and product rules

### 1.1 Vocabulary

- **Event** — a founder-created offline gathering in a launched market
  (`SUPPORTED_MARKETS`, `packages/shared/src/markets.ts`): a city-launch
  party, a campus night, a curated mixer. Lifecycle:
  `draft → upcoming → live → concluded | cancelled`.
- **Batch drop** — an event used as an admission cohort ("the September Kyiv
  drop"). Same entity; `kind: "launch" | "batch" | "mixer"` is descriptive.
- **Waitlist application** — one user's request to attend one event. Created
  automatically at onboarding completion for the user's market's next open
  event (opt-out), or explicitly from the event screen.
- **Admission tier** — the application's state:
  `auto_approved | pending_review | waitlisted | approved | revoked`.
  `approved` is the manual twin of `auto_approved`; both admit.
- **Gatekeeper** — venue staff scanning QR codes. Not a `User`; authenticated
  by a per-event staff token (§8).
- **Round** — one in-event mini-pairing wave ("Meet Anna near Bar Counter #2,
  code #42").

### 1.2 Invariants inherited from the core product (non-negotiable)

- **No user-to-user free text.** In-event interaction is structured only:
  mission cards, the mutual "crossed paths" ping, and status chips. The §Phase 4
  proxy-chat carve-out is NOT extended to events — two people at the same
  venue can talk with their mouths.
- **Blind decision.** The post-event thumbs-up is double-blind: neither side
  learns the other's verdict before committing (§11), byte-for-byte the same
  rule as PRODUCT_SPEC §3.4.
- **Verified only.** An application is only ever tiered for
  `verificationStatus = 'verified'` accounts (plus the grandfathered
  pre-flip skip cohort, same predicate as `buildCandidateSql` filter 1/4).
  An unverified applicant sits in a pre-tier `screening` state and is tiered
  automatically the moment the verification pipeline activates them.
- **Blocks are absolute.** `user_blocks` (either direction) excludes a pair
  from every round pairing and from the recap screen.
- **Attractiveness numbers never reach a user.** Tier names are shown
  ("you're in" / "you're on the reserve list"); scores, thresholds and ratios
  are admin-only — the same rule §2.1 applies to `explain_my_match`.
- **A person's position inside the venue is never shown to another user as a
  coordinate.** A round names a *spot* ("Bar Counter #2"), never a location —
  the same shape as the Date Radar's masked ETA (§6.3).

---

## 2. Database architecture (Prisma — the repo's schema source of truth)

All models are **additive**. No existing table changes except two nullable
columns on `matches` noted in §11. Prisma generates the DDL via the documented
`db:push` path; every deploy block must verify a zero-`DROP` plan exactly as
deploy.md prescribes.

```prisma
// ─── Events ────────────────────────────────────────────────────────────────

model Event {
  id            String    @id @default(uuid()) @db.Uuid
  /// Launched market key — must exist in SUPPORTED_MARKETS (enforced in the
  /// service, same rule as validateHomeLocationPayload; the DB stores a string).
  cityKey       String    @map("city_key")
  kind          String    @default("launch") // launch | batch | mixer
  status        String    @default("draft")  // draft|upcoming|live|concluded|cancelled
  title         String
  /// Venue is a curated row when possible, else a frozen snapshot — an event
  /// must survive the venue row being deactivated by the nightly revalidation.
  curatedVenueId String?  @map("curated_venue_id") @db.Uuid
  venueName     String    @map("venue_name")
  venueAddress  String    @map("venue_address")
  venueLat      Float     @map("venue_lat")
  venueLng      Float     @map("venue_lng")
  startsAt      DateTime  @map("starts_at")
  endsAt        DateTime  @map("ends_at")
  timeZone      String    @map("time_zone") // wall-clock rendering, §3.6 rule
  /// Hard cap on admitted people (sum over tiers is additionally capped per tier).
  capacity      Int
  /// Target gender ratio, male share in [0,1]. 0.5 = balanced. Null = uncontrolled.
  targetMaleShare Float?  @map("target_male_share")
  /// Tolerated deviation before the balancer stops auto-approving the
  /// overrepresented gender (e.g. 0.08 → auto-approve stalls past 58/42).
  ratioTolerance  Float   @default(0.08) @map("ratio_tolerance")
  /// Auto-tiering thresholds, attractiveness 0..100 (from eloSeedDetails.score).
  /// Null → every verified applicant is pending_review (fully manual event).
  autoApproveScore  Int?  @map("auto_approve_score")   // ≥ → auto_approved
  reviewFloorScore  Int?  @map("review_floor_score")   // ≥ → pending_review, < → waitlisted
  /// Admissions open/close independently of the event itself.
  admissionOpensAt  DateTime? @map("admission_opens_at")
  admissionClosesAt DateTime? @map("admission_closes_at")
  createdAt     DateTime  @default(now()) @map("created_at")
  updatedAt     DateTime  @updatedAt @map("updated_at")

  tiers         EventTicketTier[]
  applications  WaitlistApplication[]
  tickets       EventTicket[]
  rounds        EventRound[]
  staffTokens   EventStaffToken[]

  @@index([cityKey, status, startsAt])
  @@map("events")
}

model EventTicketTier {
  id          String  @id @default(uuid()) @db.Uuid
  eventId     String  @map("event_id") @db.Uuid
  event       Event   @relation(fields: [eventId], references: [id], onDelete: Cascade)
  kind        String  // free_rsvp | paid | vip_guestlist
  title       String
  capacity    Int
  /// Claimed count — the atomic capacity guard (§6.2). Never derived at claim
  /// time from COUNT(*): the conditional increment IS the lock.
  claimed     Int     @default(0)
  /// Telegram Stars price; null for free_rsvp / guestlist. USD display derives
  /// from it the way TICKET_BUNDLE_STARS already works — never a second number.
  priceStars  Int?    @map("price_stars")
  /// Whether one wallet Date Ticket may be spent instead of Stars (§6.3).
  acceptsWalletTicket Boolean @default(false) @map("accepts_wallet_ticket")

  tickets     EventTicket[]

  @@index([eventId])
  @@map("event_ticket_tiers")
}

// ─── Admission ─────────────────────────────────────────────────────────────

model WaitlistApplication {
  id          String   @id @default(uuid()) @db.Uuid
  eventId     String   @map("event_id") @db.Uuid
  event       Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)
  userId      String   @map("user_id") @db.Uuid
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// screening | auto_approved | pending_review | waitlisted | approved | revoked
  tier        String   @default("screening")
  /// Attractiveness 0..100 FROZEN at tiering time (copied from
  /// eloSeedDetails.score). Frozen so a later photo edit / re-seed cannot
  /// silently re-tier an already-decided application — same freezing rule as
  /// match_score_logs.
  scoreAtTiering Int?  @map("score_at_tiering")
  /// Gender frozen at tiering (the balancer's input; profile edits post-freeze
  /// do not retro-shuffle the cohort).
  genderAtTiering String? @map("gender_at_tiering")
  tieredAt    DateTime? @map("tiered_at")
  /// Who decided: "auto" or the admin actor. Manual actions overwrite tier and
  /// stamp this — the audit is the row itself plus the admin log line.
  decidedBy   String?  @map("decided_by")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([eventId, userId]) // one application per user per event; retry = same row
  @@index([eventId, tier])
  @@map("waitlist_applications")
}

// ─── Tickets & check-in ────────────────────────────────────────────────────

model EventTicket {
  id          String   @id @default(uuid()) @db.Uuid
  eventId     String   @map("event_id") @db.Uuid
  event       Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)
  tierId      String   @map("tier_id") @db.Uuid
  tier        EventTicketTier @relation(fields: [tierId], references: [id])
  userId      String   @map("user_id") @db.Uuid
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  /// claimed | paid | checked_in | refunded | revoked. `claimed` is a free
  /// ticket's terminal pre-event state; a paid tier goes claimed→paid on the
  /// Stars/wallet settle (claim holds capacity for TICKET_CLAIM_TTL, §6.2).
  status      String   @default("claimed")
  /// Exactly-once money trail — Telegram charge id or synthetic wallet id,
  /// unique like ticket_ledger.external_payment_id. Null for free tiers.
  externalPaymentId String? @unique @map("external_payment_id")
  amountStars Int?     @map("amount_stars")
  /// Rotating QR secret (§7). Regenerated on demand; never the row id.
  qrNonce     String   @map("qr_nonce")
  checkedInAt DateTime? @map("checked_in_at")
  /// Which staff token performed the check-in (audit).
  checkedInByTokenId String? @map("checked_in_by_token_id") @db.Uuid
  /// One complimentary perk (drink) — CAS'd exactly like check-in itself.
  perkRedeemedAt DateTime? @map("perk_redeemed_at")
  claimExpiresAt DateTime? @map("claim_expires_at")
  createdAt   DateTime @default(now()) @map("created_at")
  updatedAt   DateTime @updatedAt @map("updated_at")

  @@unique([eventId, userId]) // one ticket per person per event
  @@index([eventId, status])
  @@map("event_tickets")
}

model EventStaffToken {
  id         String    @id @default(uuid()) @db.Uuid
  eventId    String    @map("event_id") @db.Uuid
  event      Event     @relation(fields: [eventId], references: [id], onDelete: Cascade)
  /// bcrypt hash of the token — the raw value is shown once at creation, the
  /// same treatment email_otps/phone_otps give their codes.
  tokenHash  String    @map("token_hash")
  label      String    // "Front door", "Bar staff"
  revokedAt  DateTime? @map("revoked_at")
  createdAt  DateTime  @default(now()) @map("created_at")

  @@index([eventId])
  @@map("event_staff_tokens")
}

// ─── Party Mode ────────────────────────────────────────────────────────────

model EventRound {
  id         String   @id @default(uuid()) @db.Uuid
  eventId    String   @map("event_id") @db.Uuid
  event      Event    @relation(fields: [eventId], references: [id], onDelete: Cascade)
  index      Int      // 1-based round number within the event
  opensAt    DateTime @map("opens_at")
  closesAt   DateTime @map("closes_at")
  status     String   @default("planned") // planned | open | closed

  pairings   EventRoundPairing[]

  @@unique([eventId, index])
  @@map("event_rounds")
}

model EventRoundPairing {
  id         String   @id @default(uuid()) @db.Uuid
  roundId    String   @map("round_id") @db.Uuid
  round      EventRound @relation(fields: [roundId], references: [id], onDelete: Cascade)
  eventId    String   @map("event_id") @db.Uuid // denormalized for the recap query
  userAId    String   @map("user_a_id") @db.Uuid
  userBId    String   @map("user_b_id") @db.Uuid
  /// Named meeting spot + human code ("Bar Counter #2", 42). Spots are an
  /// event-level JSON list on the admin side; the pairing stores the resolved
  /// label so a later spot edit cannot rewrite history.
  spotLabel  String   @map("spot_label")
  code       Int
  /// Mission card / icebreaker text per side, generated at pairing time
  /// (Profiler answers + psychologicalSummary — the §Phase 4 icebreaker fuel).
  missionA   String?  @map("mission_a")
  missionB   String?  @map("mission_b")
  /// The mutual "we crossed paths" ping — per side, blind until both.
  metConfirmedA DateTime? @map("met_confirmed_a")
  metConfirmedB DateTime? @map("met_confirmed_b")
  /// Post-event double-blind thumbs (§11). Never revealed one-sided.
  thumbsA    Boolean? @map("thumbs_a")
  thumbsB    Boolean? @map("thumbs_b")
  /// Set when a mutual thumbs auto-created a core Match row (§11).
  matchId    String?  @map("match_id") @db.Uuid
  createdAt  DateTime @default(now()) @map("created_at")

  @@index([eventId, userAId])
  @@index([eventId, userBId])
  @@map("event_round_pairings")
}

// ─── Feedback & safety ─────────────────────────────────────────────────────

model EventFeedback {
  id         String   @id @default(uuid()) @db.Uuid
  eventId    String   @map("event_id") @db.Uuid
  userId     String   @map("user_id") @db.Uuid
  /// 1..10 overall, same scale as post-date chemistry.
  rating     Int?
  /// Safety flag: everything_fine | uncomfortable | unsafe — triaged like
  /// report tiers; `unsafe` opens a Tier-3-style manual queue entry.
  safety     String?
  text       String?
  createdAt  DateTime @default(now()) @map("created_at")

  @@unique([eventId, userId])
  @@map("event_feedback")
}
```

**Live-status chips** ("open to meet / in conversation / taking a break") are
deliberately **not a table**. They are ephemeral presence with a minutes-long
honest lifetime — the exact shape the Date Radar solved with an in-process map
and a TTL (§6.3, "nothing is stored"). Same treatment: in-memory per event,
lost on restart, restored by the next poll. A stored chip is a stale chip.

**User relations to add:** `waitlistApplications`, `eventTickets`,
`eventFeedback` back-relations. GDPR: all new tables cascade from `users`, so
`deleteUserAccount` needs **no new code** for rows — but §10 adds pairing rows
to the founder-snapshot scrub check, and the recap serializer must tolerate a
deleted counterpart (render "участник удалил аккаунт", the ledger idiom).

---

## 3. Access control map (what the brief called "RLS policies")

One table, enforced in middleware/services — every row below is a test.

| Data | Reader | Writer | Enforcement point |
|---|---|---|---|
| `events` (public fields) | any authenticated user in that market | admin only | `/v1/events` serializer strips thresholds/ratio/capacity-claimed; admin routes behind `ADMIN_API_KEY` |
| `events` (thresholds, ratios, funnel) | admin | admin | admin router only — fields never enter a `/v1` serializer |
| `waitlist_applications` | own row only (tier, never score) | user creates; **tier written only by the tiering service or admin** | `/v1/events/:id/application` resolves by caller id; no id-addressed read |
| `event_tickets` | own row | claim/settle service; `checked_in_*` only via gatekeeper routes | ownership check on every `/v1` route; staff routes authenticate the token, not a user |
| QR verification | gatekeeper token holder | — | `POST /gk/:eventId/scan` — token bcrypt-checked, event-scoped, revocable |
| `event_round_pairings` | each side sees own side + partner's first name/photo **after round opens**; `thumbs*` never cross-readable | pairing worker; `met_*`/`thumbs*` via CAS'd own-side routes | serializer reads only caller's column — the §3.4 blind rule, same as `acceptedBy*` |
| `event_feedback` | own row + admin | own row (upsert) | unique (event,user); admin aggregate only |
| staff tokens | admin | admin | raw value returned once at mint |

Blind-decision property, restated as an implementation rule: **no `/v1`
response may ever contain the partner's `thumbs*`, `metConfirmed*` (before
mutuality), tier, or score.** The pairing serializer takes a `side` parameter
and selects columns, exactly like `deriveDateState` does today — enforced by a
test that pins the whole serialized object (the §6.4 vocabulary-list lesson).

---

## 4. Waitlist admission & the attractivity engine

### 4.1 Where the score comes from (no new vision calls)

The score already exists: `Profile.eloSeedDetails.score` (0..100), written
once by `seedEloFromVisionDefault` on the verification `verified` branch.
Admission **reads** it; it never re-runs vision. Consequences:

- A verified user is tierable instantly and for free.
- An applicant who verifies *after* applying sits in `screening`; the
  verification pipeline's activation surface gains one fire-and-forget call —
  `tierPendingApplications(userId)` — beside the existing referral-settlement
  hook (`grantReferralRewardsForVerifiedInvitee`), same idiom, same
  "never blocks activation" contract.
- Accounts seeded before `eloSeedDetails` existed (legacy) have `eloScore`
  only; the service falls back to inverting `mapScoreToElo`. Never null-scores
  a verified user into `waitlisted` — missing data routes to `pending_review`
  (fail toward a human, the §1.4 rule 4 principle).

### 4.2 Tiering algorithm (`services/event-admission.ts`, pure + tested)

```ts
tierApplication(app, event, cohort): Tier
// 1. Not verified → screening (re-run at activation).
// 2. score = eloSeedDetails.score ?? invertElo(eloScore); missing → pending_review.
// 3. score >= event.autoApproveScore        → candidate auto_approved
//    score >= event.reviewFloorScore        → pending_review
//    else                                   → waitlisted
// 4. RATIO GATE (only for candidate auto_approved):
//    admittedShare = admitted[gender] / admittedTotal (from cohort snapshot);
//    if admitting this user pushes |share − target| beyond ratioTolerance
//    → downgrade to pending_review (never waitlisted: the balancer defers to
//    the founder rather than silently rejecting a strong applicant).
// 5. CAPACITY GATE: admitted >= event.capacity → waitlisted regardless.
```

Writes are a CAS: `updateMany({ where: { id, tier: "screening" } … })` so the
activation hook and an admin decision racing produce one transition. The
ratio/capacity snapshot is read inside the same transaction as the write; a
lost race re-derives (the drop-batch pattern, not a lock).

**The balancer balances the *admitted set*, not applications** — the founder's
lever for "supply-demand exclusivity" is the pair
(`autoApproveScore`, `capacity`), and the ratio gate only throttles the
overrepresented side's *automatic* lane. Manual approval always wins; the hub
shows the live ratio next to every approve button so the founder overrides
with eyes open.

### 4.3 What the applicant sees

Tier names only, in product language: admitted (ticket CTA), "on the review
list", "on the reserve list — we'll ping you if a spot opens". Waitlist
promotion (capacity freed by refund/revoke) is a worker sweep that promotes
the longest-waiting application of the ratio-needed gender, pings via the
channel-aware notifier (`telegramReachable` / `pushReachable` — the §4.3-map
rule; **never** `telegramId > 0`, the trap the journal documents ten times).

---

## 5. Founder Analytics & Moderation Hub

Extends the existing admin API (:3100, bearer, 15-min `getOrCompute` cache,
`?fresh=1`, `X-Data-*` headers) and the separate dashboard repo
(`~/Desktop/gennety-admin-dashboard` — new tab, ships after the server, the
ordering lesson from the account-health incident).

| Endpoint | Purpose |
|---|---|
| `GET /admin/events` / `POST /admin/events` / `PATCH /admin/events/:id` | CRUD + lifecycle transitions (CAS on `status`, legal transitions only) |
| `GET /admin/events/:id/pipeline` | Live funnel: applicants by tier, auto vs manual counts, admitted gender ratio, score histogram (deciles — the dashboard never receives raw per-user scores in a list it might export), avg score, capacity fill, check-in count |
| `GET /admin/events/:id/applications?tier=&q=` | Moderation grid: card = photos (existing admin media proxy), profile basics, score badge, health class (`user-health.ts` verdict — the test/synthetic exclusion for free) |
| `POST /admin/events/:id/applications/:appId/decide` | `{action: approve\|waitlist\|revoke, reassignEventId?}` — CAS on current tier; revoking an admitted user with a ticket refunds it (§6.4) |
| `POST /admin/events/:id/bulk-approve` | `{minScore}` — one guarded `updateMany` over `pending_review`, capacity-capped, returns count |
| `POST /admin/events/:id/staff-tokens` / `DELETE …/:tokenId` | Mint (raw shown once) / revoke gatekeeper tokens |
| `GET /admin/events/:id/live` | During `live`: checked-in headcount, arrivals-per-15-min, per-tier fill, current round, assist alerts |

Denominators follow the monetization rule: test + synthetic accounts
(`classifyAllUsers`) are excluded from every percentage and shown as
`excludedTestUsers`. Empty denominator → `null`, never 0.

---

## 6. Ticketing, capacity & the ratio engine

### 6.1 Tiers

`free_rsvp` (requires an admitting tier — the application IS the price),
`paid` (Stars; wallet Date Ticket optionally accepted), `vip_guestlist`
(admin-assigned, bypasses admission — the founder's comp list). One ticket per
user per event (`@@unique`), enforced by the constraint, surfaced as "you
already have a ticket" rather than an error.

### 6.2 Capacity without oversell (the concurrency answer)

Capacity is claimed by a **conditional atomic increment**, the same shape as
every CAS in this codebase — and per the 2026-08-27 audit rule it is the
interactive `$transaction(async tx ⇒ …)` form, never the array form:

```ts
await prisma.$transaction(async (tx) => {
  const claimed = await tx.$executeRaw`
    UPDATE event_ticket_tiers SET claimed = claimed + 1
    WHERE id = ${tierId} AND claimed < capacity`;
  if (claimed === 0) throw new TierFullError();
  await tx.eventTicket.create({ status: "claimed", claimExpiresAt: paid ? now + TTL : null, … });
});
```

Two simultaneous last-spot claims: one increments, one reads 0 rows and gets
the honest "tier is full". A paid claim holds the spot for
`EVENT_TICKET_CLAIM_TTL_MIN` (15); the hourly sweep releases expired claims
(`claimed - 1` + row → `revoked`) — the §3.5b ticket-gate deadline lesson:
**the TTL is armed in the same transaction as the claim**, so no row can be
invisible to its own reaper.

### 6.3 Payment

Reuses the rails wholesale — no new payment code paths, only a new payload
tag: `event:<ticketId>` in `handlers/payments.ts`, settled exactly-once via
the unique `telegram_payment_charge_id` (→ `EventTicket.externalPaymentId`),
`pre_checkout_query` re-validating price + that the claim is still alive.
Wallet spend goes through `useTicketFromBalance` with the standard
refund-on-lost-race. iOS: StoreKit consumables credit the wallet, the wallet
pays — the §3.5b "wallet is the only rail on iOS" rule, unchanged.

### 6.4 Refunds

One rule, inherited verbatim from §3.5b: **the event didn't happen for you →
what you paid comes back.** Event cancelled, admission revoked by the founder,
or self-cancel before a cutoff (default T-24h) → Stars refunded via the
durable `venue_change_purchases`-style retry sweep, wallet spends re-granted
(`reason: "event_refund"`, synthetic unique `refund:event:<ticketId>`).
No-show refunds are **not** automatic (same open question as the core
product's no-show ticket, deliberately shared).

---

## 7. Cryptographically signed QR codes

The QR payload is an HMAC-signed token in the idiom the product already trusts
(`initData` verification, the referral card's `sig`):

```
payload = base64url({ v: 1, t: ticketId, e: eventId, n: qrNonce, exp })
qr      = payload + "." + base64url(HMAC_SHA256(EVENT_QR_SECRET, payload))
```

- `EVENT_QR_SECRET` is its own env key (≥32 random bytes; never `JWT_SECRET` —
  the demo/prod shared-secret incident is why every new secret gets its own
  key AND a line in `deploy-demo.sh`'s `MUST_DIFFER` gate).
- `exp` is short (90 s) and the Mini App re-renders the QR on a timer — a
  screenshot forwarded to a friend outside the venue dies in a minute and a
  half. `qrNonce` rotates on demand ("my code leaked") without reissuing the
  ticket.
- **Single-use is enforced by the database, not the signature**: check-in is
  `updateMany({ where: { id: ticketId, checkedInAt: null }, data: { checkedInAt: now, … } })`.
  Two doors scanning the same code: one succeeds, one gets "already inside
  since 21:14" — which is itself the anti-pass-sharing UX (the second holder
  is standing at the door while the screen says the ticket is used).
- Verdicts shown to staff are name + photo thumbnail + tier + "ADMIT / ALREADY
  USED / REVOKED / WRONG EVENT / EXPIRED CODE — ask them to refresh". The
  photo is the human anti-spoof: a signature proves the ticket, the face
  proves the holder.
- **Offline at the door:** the scanner is online-first (it's a phone on
  mobile data hitting `/gk/*`). Degradation is a staff-downloadable guest
  manifest (name + photo + ticket id) fetched while online, with manual
  check-in reconciliation when connectivity returns — a fully-offline
  cryptographic path (device-held keys) is deliberately out of scope for v1
  and listed in §14.

---

## 8. Venue & B2B gatekeeper portal

A new Mini-App-shaped static page, `gatekeeper.html` — but **not**
Telegram-authenticated: staff are not users. Auth is the event staff token,
entered once and kept in `sessionStorage`; every API call carries it as a
bearer to a dedicated router mounted on the public API:

| Route | Does |
|---|---|
| `POST /gk/auth` | token → event descriptor (name, date, counts) |
| `POST /gk/scan` | QR payload → verify signature + exp → CAS check-in → verdict + attendee card |
| `POST /gk/perk/:ticketId` | CAS `perkRedeemedAt` — one cocktail, exactly once, same shape as check-in |
| `GET /gk/stats` | headcount, capacity, arrivals sparkline, open assist alerts (polled ~10 s) |
| `POST /gk/assist/:alertId/ack` | acknowledge an in-app assist request (§10) |

Camera QR scanning uses the native `BarcodeDetector` where present with a
small vendored fallback decoder — **new dependency, flagged in §14** (AGENTS
"ask first" applies). Rate-limited per token; every scan is auditable
(`checkedInByTokenId`).

---

## 9. Party Mode — the in-event Zero-Chat engine

### 9.1 Gate

The "Event Live" view (a state of the Living Canvas, or v1 its own Mini App
page `event.html`) unlocks on `checkedInAt` — the check-in IS the geofence,
the same reasoning that lets the Date Bump write attendance: a staff-scanned
QR at the door is stronger evidence of presence than any client-reported
coordinate, and it costs no location permission. An optional radius check
(`BUMP_VENUE_RADIUS_M`-style, reusing the canvas ping) can tighten later; it
is explicitly **not** the gate.

### 9.2 Rounds

A worker tick (the date-lifecycle `setInterval` family, injected clock so the
demo can replay it) runs while any event is `live`:

1. At `event.startsAt + offset`, then every `EVENT_ROUND_INTERVAL_MIN`
   (default 35), open a round: snapshot present users = checked-in, not
   opted-out (status chip ≠ "taking a break"), not currently in an unexpired
   pairing.
2. **Pair via the existing scorer, restricted** — the §6.6 Campus Radar rule
   ("reuse the real allocator; a second pairing implementation is a second
   definition of a good match"): candidate edges respect mutual gender
   preference, `user_blocks` both directions, and *no repeat pairing within
   this event* (`EventRoundPairing` history). Score = `scorePair` minus the
   league gate softened (`EVENT_LEAGUE_FLOOR`, default 0.4 — a mixer's job is
   breadth; founder-tunable). Greedy max-weight matching, the drop-batch
   allocator's own idiom.
3. **The lifetime pair ban question is answered "soft-ban":** a pair with a
   `matches` row is excluded *if that row is terminal-negative* (declined /
   expired / cancelled) and **paired last-resort-only otherwise** — but see
   §14; this is a founder decision, defaulted conservatively to "never
   re-pair people the core product already banned".
4. Assign spots round-robin from the event's spot list, mint a 2-digit code,
   generate both mission cards in one batched LLM call (Profiler answers
   first, `psychologicalSummary` fallback — the §Phase 4 icebreaker contract;
   deterministic static fallback when the model is down: a round must never
   fail for want of copy).
5. Deliver: push (`event.round`, one of the few genuinely time-critical
   payloads — but **not** added to `TIME_SENSITIVE_PUSH_TYPES`; the user is
   at a party looking at their phone, not behind Focus) + the open Mini App
   picks it up on its 5 s in-round poll.
6. Round closes after `EVENT_ROUND_DURATION_MIN` (default 20): unconfirmed
   pairings simply lapse — no penalty, no Elo, no `silentIgnoreCount` (an
   event is a party, not a contract; the §3.1c "scripted outcomes must not
   become data" principle).

**Odd counts / skew:** the unpaired remainder gets "free round — bar's that
way 🍸" and *priority weight next round* (an in-memory bump, the
`standbyCount` idea scoped to the event). The gender-ratio problem is solved
at admission (§4.2), not mid-round; rounds pair whoever is actually present.

### 9.3 Interaction surface (Zero-Chat, enforced)

Per pairing, each side gets exactly: the partner card (first name, photo,
spot, code), the mission card, one **"we crossed paths"** tap
(`metConfirmed*`, blind until both — then a small mutual celebration, the
Bump's `justVerified` idiom guarding double-fire), and their own status chip.
No free text field exists in the DOM. The `thumbs` verdict is **not**
collectable during the event — it opens at T+2h with the recap (§11), so the
party is never a place someone is visibly swiping on people in the room.

---

## 10. Trust, safety & community moderation

- **Assist button** — one tap, two levels: "find me staff" (routes to the
  gatekeeper portal's alert list + founder ops DM via `founder-notify`) and
  "report a person" (opens the existing §Phase 5 report flow with the pairing
  as context; same tiers, same clamp, same manual queue). The assist tap is
  deliberately *not* an accusation — the block/report separation rule.
- **Blocks**: a block filed mid-event immediately excludes the pair from all
  future rounds (the pairing edge check reads live) and hides each from the
  other's recap. Effect server-side, both platforms, as always.
- **Reported → paused from rounds** for the rest of the event on any Tier ≥ 2
  triage, pending the founder (who is watching the live dashboard during a
  launch event anyway).
- **Post-event feedback** (§2's `EventFeedback`) is prompted at T+18h,
  before the recap unlocks its incentive; `safety: "unsafe"` opens an
  un-dismissable manual-review entry. Feedback is *strongly incentivized,
  not a hostage gate* — recap and thumbs work without it (a mandatory gate
  in front of a safety report inverts its purpose).

---

## 11. Post-event retention & the conversion funnel

- **T+2h (event ends):** thumbs open. **T+18h:** feedback prompt + recap
  push ("вы пересеклись с 4 людьми"). Recap lists only pairings with
  `metConfirmed` mutual OR any pairing the user choose — founder decision
  §14 — default: **met-confirmed only** (a list of people you never found is
  a list of small failures).
- **Double-blind thumbs:** own-side CAS write; nothing revealed on a single
  thumb; a `false` is never announced (the §3.4 mixed-verdict softening —
  silence, not rejection UX).
- **Mutual `true` → the product's whole point:** auto-create a core `Match`
  (`source: "event"`, stamped in the creating transaction like
  `weekly|rematch|campus`), status `negotiating` (both already said yes —
  the pitch/decision phase is skipped, the reveal DM is
  "you both felt it ✨"), flowing into the standard Date Ticket gate →
  Calendar → venue pipeline unchanged. Constraints honored at creation:
  single-live-match (a user already in a live match gets the mutual reveal
  and a "when you're free" deferral — the row is created `proposed`-parked;
  exact mechanics are a Phase-4 implementation note), and the created row
  enters the lifetime pair ban going forward. `EventRoundPairing.matchId`
  links the two.
- **Incentive:** feedback submission grants the existing famine-discount
  mechanism's sibling — a one-time percent-off single ticket
  (`services/ticket-discount.ts` generalized with a `source` field), because
  a *second* discount system would double the №1 lesson of the wallet code.
- **Weekly matching interplay:** event pairings write **no** `matches` rows
  (only mutual thumbs do), so Thursday matching is unaffected by who stood
  next to whom at a party. `match_score_logs` untouched; `source: "event"`
  rows are excluded from the scoring A/B like `rematch`/`campus`.

---

## 12. Concurrency & failure summary (the checklist form)

| Risk | Answer |
|---|---|
| Ticket oversell | conditional `claimed < capacity` increment inside an interactive transaction (§6.2) |
| Double check-in / shared QR | DB CAS on `checkedInAt` (§7); signature+TTL keeps codes short-lived |
| Double perk | CAS on `perkRedeemedAt` |
| Payment redelivery | unique `externalPaymentId`, duplicate = idempotent no-op (house rule) |
| Claim never settled | TTL armed in the claim transaction + hourly reaper (§6.2) |
| Tiering vs admin race | tier CAS on expected current tier |
| Round double-open | `@@unique(eventId, index)` + worker single-flight (`guardedTick`) |
| Mutual-thumbs double match creation | CAS on `matchId: null` in the pairing row |
| Venue offline | manifest fallback + reconciliation (§7) |
| Model down mid-round | static mission fallback; a round never blocks on OpenAI |
| Skewed live ratio | admission-time balancer + round-level sit-out priority; never mid-round exclusion by gender alone |
| User deletes account | Prisma cascade (all FKs); recap tolerates missing counterpart; founder snapshots scrubbed |

---

## 13. Phased roadmap

Each phase = additive `db:push` + flags shipped **dark** + its own deploy.md
block; the demo answer and the iOS answer are stated per phase (AGENTS.md
"Demo Mode Impact Check" / "Two Clients, One Backend").

**Phase 1 — schema, admission pipeline, founder hub.**
Flags: `EVENTS_FEATURE_ENABLED` (master). Tables: all §2. Tiering service +
verification-activation hook + admin endpoints + dashboard tab. No user
surface yet beyond the application row auto-created at onboarding (silent).
iOS: nothing (no surface). Demo: inert (no events in the demo DB).

**Phase 2 — ticketing + gatekeeper.**
Flags: `EVENT_TICKETS_ENABLED`, `EVENT_QR_SECRET`. `events` list/detail in a
Mini App page + `/v1/events/*`; Stars payload `event:*`; `gatekeeper.html` +
`/gk/*`; refund sweep cron. iOS: read-only event screen + wallet-paid ticket
(`openapi/gennety-v1.yaml` additive, generator-run gate — the
`oneOf: [$ref, "null"]` trap is now a standing check). Demo: events shown,
payment settles free like `changeIsFree`; scanning demoed with a staged
token.

**Phase 3 — Party Mode.**
Flags: `EVENT_ROUNDS_ENABLED`. Round worker (injected clock), `event.html`
live view, pairing allocator restriction, mission generation, presence chips,
`event.round` push. iOS: same endpoints; native live view its own slice.
Demo: replayable with the lifecycle-replay idiom (a staged `live` event with
the visitor + puppets from the reserved id band).

**Phase 4 — post-event loop + safety analytics.**
Flags: `EVENT_RECAP_ENABLED`. Thumbs, recap, mutual→Match creation
(`source: "event"` + the two nullable `matches` columns if any prove needed),
feedback + incentive, safety analytics on the hub, `EventFeedback` retention
sweep entry (`retentionTick` gains a table = **three** edits: sweep, sum, log
line — the 2026-08-21 lesson).

---

## 14. Founder decisions — resolved 2026-08-29

**1. Score-gated admission: NO. ✅ RESOLVED — implemented in Phase 1.**
The attractiveness score is a **sort key in the founder hub and gates
nothing**. Admission runs on `admissionPolicy`, per event:

| policy | behaviour | status |
|---|---|---|
| `manual` | every verified applicant → `pending_review`; a human decides | **the default**, and the founder's stated choice |
| `open` | every verified applicant is admitted, subject only to capacity + the balancer — "the ticket costs nothing, it is just the condition" | one field at event creation |
| `scored` | thresholds tier automatically | built, unused; needs its own founder decision before an event ever selects it |

Both of the founder's statements are expressible without a code change:
"start in manual mode" is the default, and "available to everyone who applies
with an approved profile" is `open`. **The choice is made per event in the
hub, not per deploy** — the ambiguity became a visible setting rather than a
guess, which is the point.

The Art. 22 exposure the earlier draft flagged is therefore not taken on: no
automatic decision is made about a person on the basis of a score in either
policy the product will actually run.

**7. Pricing: the ticket is FREE. ✅ RESOLVED.** Not a paid product — it is the
entry condition. This deleted the whole Stars/wallet integration, the refund
sweep and the claim TTL from Phase 2, which is now materially smaller than
this document originally described (§6.2–6.4 stand as the design to reach for
IF a paid tier is ever wanted; nothing in them is built). Premium does not
cover an event ticket because there is nothing to cover.

**2–6, 8: defaults accepted.** Lifetime pair ban respected in rounds; recap
shows met-confirmed pairings only; mutual thumbs skip to `negotiating`; QR
offline story is the manifest fallback; venue staffing falls back to the
founder scanning at the door. The two new dependencies (QR render, scan
fallback) are approved but not yet installed — they belong to Phase 2 and
should be added in that commit, not ahead of it.

### What actually shipped in Phase 1 (2026-08-29)

`events` + `waitlist_applications`, `services/event-admission.ts` (pure
tiering + the balancer + the verification-activation hook), the
`/admin/events/*` hub, `EVENTS_FEATURE_ENABLED` — dark. No user surface, no
tickets, no `/v1/*`, no Mini App. See ARCHITECTURE.md → `events` /
`waitlist_applications` and the deploy.md block.

Three things Phase 1 deliberately does NOT do, so their absence is not read as
an oversight later: nobody is **notified** of a tier (that needs a user
surface, Phase 2); a revoke frees capacity but **promotes nobody** off the
waitlist (promotion without a notification is invisible); and there is no
scheduled sweep at all — the only automatic trigger is the verification
pipeline, with `POST /admin/events/:id/retier` as the repair path for
applications stranded in `screening` while the flag was off.
2. **Lifetime pair ban vs event rounds** (§9.2.3): never re-pair banned
   pairs (default), or allow at a party since "we already matched once" is
   different in a room than in a feed.
3. **Recap scope**: met-confirmed only (default) vs all pairings.
4. **Mutual thumbs → which match state**: skip-to-`negotiating` (default,
   both consented) vs a normal `proposed` pitch for ceremony.
5. **QR offline story**: manifest fallback (v1) vs device-key offline verify.
6. **New dependencies**: QR render lib (Mini App) + scan fallback decoder
   (gatekeeper) — both need explicit approval per AGENTS.md.
7. **Pricing**: event ticket Stars pricing, wallet-ticket acceptance, and
   whether Premium covers an event ticket (recommendation: **no** — §3.5b's
   "unlimited dates" covers the subscriber's own *date* slot; an event is a
   different product, and the break-even math was done against dates).
8. **Staffing reality**: the gatekeeper portal presumes venue staff will use
   our tool; the fallback (founder scans at the door with the same portal)
   works day one — but B2B venue features (multi-event venue accounts) are
   deliberately out of scope until a second venue asks.
