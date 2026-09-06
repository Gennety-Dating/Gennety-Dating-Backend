<!-- WHEN_TO_READ: You are changing scheduling or anything paid: calendar scheduling, peer-wait shimmer, concierge venue negotiation, the date card, venue change v2, Premium, referral, promo codes, or rematch (Phase 3.6-3.11). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 4571-6515) — migrated 2026-09-01 -->

### 3.6 Calendar Scheduling

After mutual accept (or, when the Date Ticket gate of §3.5b is enabled, after
both tickets are paid) the bot DMs both users a button that opens the
**Calendar Mini App** (`apps/webapp`, Vite + Telegram Web Apps SDK).

**The native client has the same grid on `/v1/matches/{id}/calendar` (JWT,
2026-08-06).** `startScheduling` has always written `proposedTimes` for every
`negotiating` match whichever client accepted, but the only way to read or
answer it was the `initData`-authed routes below — so an iOS-only pair reached
scheduling with no calendar at all. Everything in this section applies to both
surfaces unchanged: the mechanics are the same `processCalendarSlotsUpdate` /
`getCalendarState`, so the two clients cannot drift on when a date locks in.
The native response additionally carries the pair's city `timeZone`, because
the grid is a set of instants and a device drawing them on its own wall clock
would let a traveller agree to a time neither side meant — the same reasoning
behind the canonical-Kyiv locked-time card below. The
legacy three-iteration flow (two rounds of "pick one of three slots"
inline keyboards before falling back to the calendar) was removed
2026-05-07 — landing straight on a peer-aware calendar is strictly
better UX than three separate retries.

- **Server-side slot grid.** When the match enters `negotiating` the
  bot writes **6 consecutive dates** (next 6 days starting tomorrow)
  with **14 time slots per date** into `Match.proposedTimes`: every 30
  minutes from 13:00 through 19:30 local. Both users see the same exact
  DateTime allowlist; the public API rejects any submission whose ISO
  isn't on it. Pre-2026-05-10 the grid was 12 slots with Sun/Mon
  pre-skipped; pre-2026-05-11 it was 6 dates at only 18:00; the earliest
  slot was 17:30 until 2026-07-07, then a 6-slot 17:00–19:30 evening band
  until 2026-07-18, when the start was pulled forward to 13:00 (14 slots
  per date) so afternoon dates are offered, not just evening ones.
- **The last three times of each day are a paid band (2026-08-26, feature-flagged
  `PRIME_TIME_ENABLED`).** 18:30 / 19:00 / 19:30 Kyiv are the slots people
  actually want, so they open with Gennety Premium — or, for a pair with no
  subscription, with one `PRIME_TIME_STARS` (50⭐) purchase that opens them **for
  that date**. Full design: [PRIME_TIME_PRODUCT_SPEC.md](prime-time.md).

  **The band is the grid's own SUFFIX, never a second list.** `primeTimeSlots`
  slices `CALENDAR_TIME_SLOTS` from the end, so moving the grid moves the band
  with it and the two can never describe different hours. The count is
  `PRIME_TIME_SLOT_COUNT`, and no user-facing copy names it — a number baked
  into five translations goes stale silently the first time it moves.

  **The unlock is per MATCH, and that is forced rather than chosen.** A date
  locks when the two availability sets intersect at exactly one slot (below), so
  a pass that opened the band for ONE person would buy nothing: their partner
  still could not mark the same slot, and no intersection could ever form there.
  `Match.primeTimeUnlockedAt` is therefore the unit, and either side opening it
  opens it for both.

  **A subscription is read live, and stamped the first time it is used.** The
  band is open while `isPremiumHeadActive` holds on either side; the moment a
  premium user actually marks a prime slot, `primeTimeUnlockedAt` is written, so
  a subscription lapsing between the pick and the date cannot re-lock a slot the
  pair already agreed on. That is the ONE reason the column is written without
  money moving (`shouldPersistUnlock`) — a reason that can stop being true is
  the only kind worth persisting.

  **A pair already holding a prime slot is grandfathered**, checked against
  `availableTimesA/B` rather than by a migration: turning the flag on must never
  invalidate a mark somebody made while it was off.

  **A pair the rail cannot reach is fail-open.** With both participants on the
  native app there is no way to buy the pass at all today (Stars is a Telegram
  rail), so the band is simply open for them rather than being a wall — the
  same reasoning §3.5c applies to a stall it cannot ask about. A mixed pair is
  NOT in that state: the Telegram side can open the band, and the unlock is
  per-match, so it opens for both.

  **Enforcement is one choke point.** Both surfaces already share
  `processCalendarSlotsUpdate`, so the refusal lives there and the
  `overlapCandidates` confirm path inherits it — a client that draws no lock
  still cannot write one. The Mini App paints the band from `primeTime.locked`
  and re-derives nothing.

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
  actor gets **no message at all** — the §3.6b waiting shimmer replaces the old
  `matchScheduleSavedConfirmation` receipt and is held until the peer picks.
  Started fire-and-forget: this call's return value IS the Mini App's save
  response, so it must not wait on a cosmetic draft.
- **One live post-accept card per side.** Telegram post-accept prompts are
  tracked in `Match.calendarMessageIdA/B`. The same message can move from
  accepted/waiting → Calendar; new peer proposals and
  counter-proposals edit it in place, falling back to a replacement only if
  Telegram says the stored message is gone. Both cards are removed when a time
  is locked, so repeated scheduling updates do not accumulate identical "Open
  Calendar" messages in the chat.
  **Editing in place is only safe while that card is still the newest message,
  and two cases are not (2026-08-12).** A counter-proposal has always deleted
  and resent — an edit "the peer never sees" is the failure mode named at its
  own call site — and the Date Ticket gate is the other: its card is a separate
  message that lands *below* the tracked one (§3.5b), so the Calendar that
  follows the gate resends too. The Date Ticket card is therefore **not** a
  stage this card passes through; it never was, and this bullet used to say
  otherwise.
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
- **The time list opens at the LATEST slot, not the earliest (2026-08-08,
  Telegram-only).** Tapping a date slides up a sheet holding all 14 slots
  (13:00 → 19:30), which is taller than the sheet on every phone, and it used
  to open at 13:00 — the top of a scrollable list, where the first row sits
  flush against the top edge and reads as though the list simply *starts*
  there. Nothing else on that screen says it scrolls. It now opens scrolled to
  the bottom: the evening is where the answer usually is (a first date is
  planned for the evening far more often than for mid-afternoon), so the
  common case needs no scroll at all, and the row cut in half at the top edge
  is the affordance that says an earlier time is one swipe away. A
  poll-triggered rebuild — the peer marking a slot while the sheet is open —
  **preserves** the user's scroll position rather than re-anchoring, since the
  rule is about where a fresh open lands, not about overriding where the user
  scrolled to. The native iOS client draws its own grid and is unaffected.
- **Auth.** The Mini App is opened via `InlineKeyboardButton.web_app`
  in production, where `Telegram.WebApp.sendData` is silently a no-op.
  Both `GET /v1/calendar/state` and `POST /v1/calendar/pick` therefore
  authenticate via `Authorization: tma <initData>` (HMAC verified
  against `BOT_TOKEN`).
- **Locked-time card (always-on, Telegram-only).** The slot locks
  *automatically* on the first single overlap, so the side that didn't act
  last never explicitly learns **which** slot won — and the very next thing
  they receive is the §3.7 departure-point Mini App prompt, about something
  else entirely. Entering `negotiating_venue` therefore DMs each Telegram
  side a minimal PNG banner (`services/time-card.ts`, ~1000×420 so Telegram
  renders it as a compact strip) carrying only a small label, the localized
  date, and the time in the burgundy accent — rendered in the recipient's
  `User.theme` (light: cream + burgundy; dark: graphite + a lifted burgundy,
  since the date card's near-black would sink the accent at preview size)
  and in the canonical `Europe/Kyiv` both sides share. The caption is a single
  short line ("Время вашего свидания закреплено ✨") — **no repeated date
  phrase, no `date_time` entity, no "tap the date to add it to your calendar"
  explanation** (simplified 2026-07-25): the card already shows the time, and
  the §3.7 scheduled confirmation carries that exact add-to-calendar
  affordance, so repeating it here delivered the same tappable date twice with
  the same instruction. It is sent **before** the concierge prompt, per side,
  and is purely a framing/visual-break device — no state, no decision, no
  button. A render or send failure degrades to text, and that fallback DOES
  keep the localized date phrase + `date_time` entity (with no card there is
  nothing else stating when the date is); the departure-point prompt goes out
  either way. Mobile users are skipped (they render their own scheduling UI).
- **Backwards-compat.** `Match.schedulingIteration` and
  `pickedTimeA/B` are retained as deprecated columns until a follow-up
  cleanup migration drops them; mid-deploy taps on legacy
  `sched:pick:*` callbacks are caught by a graceful fallback that
  re-delivers the calendar button instead of failing silently.

### 3.6b Peer-wait shimmer (always-on, Telegram-only)

The two-sided negotiation steps share a shape: one participant commits their
side, and the flow then blocks on the other. Until 2026-07-28 those moments
answered with one flat line ("saved, we'll tell you when they reply") and then
nothing at all. Open the chat an hour later and there is no sign the process is
alive rather than stuck — and on the pitch decision it is worse than that: the
proposal-countdown worker deliberately stops re-rendering for a side that has
already accepted, so the single longest wait in the product (up to 24 h) was the
one with the least feedback.

**A `<tg-thinking>` shimmer now plays for the WHOLE wait**, its wording climbing a
time ladder, and it disappears when the partner answers and the flow moves on. On
the calendar and venue steps it *replaces* the waiting message entirely — nothing
is sent to the chat at all.

**A status is shown ONLY to someone with nothing left to do (founder decision
2026-08-05).** This is the invariant the whole feature lives under, and it is
what decides every predicate below. The shimmer exists so a *wait* doesn't read
as a dead product — "we haven't forgotten you, the work is happening". The
moment the next move is the user's own — pick a time, settle the ticket, mark
the departure point — a line saying work is under way is not reassurance, it is
misdirection: it tells them to sit still while the flow is blocked on them.
Those states get a **reminder** instead (§3.5, and the §3.5c check-in), which
says whose move it is and carries the way back into the screen. Nothing in
between: never a status on a step the user owes.

`services/peer-wait.ts` owns the two primitives: which line to show
(`peerWaitLabel`) and how to put it on screen once (`issuePeerWaitDraft`).
`workers/peer-wait-shimmer.ts` keeps it there.

**The wording is a function of how long THIS side has waited (2026-07-30), not of
a rotation counter.** The first revision rotated three phrasings on a global 60 s
clock, so minute two and hour twenty read identically — which made the shimmer
decorative, and made the copy wrap onto two lines in a block meant to hold one.
Five tiers replace it, one line each:

| Tier | Elapsed | Reads (RU) |
|---|---|---|
| 1 | < 5 min | `Передали {name}, ждём ответа` |
| 2 | 5 min – 1 h | `{name} ещё думает над ответом` |
| 3 | 1 – 6 h | `{name} пока молчит, ждём` |
| 4 | 6 – 24 h | `Напомнили {name} о вас, ждём ответа` |
| 5 | > 24 h | `{name} долго не отвечает` |

**Rewritten 2026-07-31 from a first pass that was too terse.** The first
five-tier ladder (`Ждём {name}` / `От {name} пока тихо` / …) was compact enough
to fit one line, but a user opening the chat several times in an hour couldn't
tell WHAT was being waited on or WHY from the noun phrase alone. Every line now
states the mechanic explicitly — "ждём ответа" / "ждём решения" — instead of
just naming the partner, chosen after a live founder review of three candidate
ladders sent to a dev chat and held on screen long enough to actually read.
Tier 5 also drops the "время поджимает" / "time's running short" tail that the
2026-07-30 pass added: a founder call that the bare fact ("{name} долго не
отвечает") carries the urgency on its own without an explicit pressure phrase.

**The separate "no-overlap" ladder is gone (2026-08-05) — that state was never a
wait.** Between 2026-07-30 and this change, a calendar where both sides had
picked and nothing intersected showed BOTH of them a second two-step ladder
(`Согласовываем время с {name}` → `Всё ещё согласовываем…`). The wording was
accurate about the machinery and wrong about the person: whoever countered had
just acted and was told their answer was being processed, while the side that
received the counter — the one message in the flow that exists to say *your
turn* — got a status telling them work was under way. Two people each waiting
for a matchmaker that was, in fact, waiting for them. It also skipped the
reminder that would have said so, because the whole state fell outside
`sideOwesAction` (below). Both sides now get **no status at all** there, and the
§3.5 scheduling reminder covers them instead.

**These lines carry no icon — no leading emoji and no animated `<tg-emoji>`
glyph** (founder decision 2026-07-30). An intermediate revision gave each tier
its own AIActions glyph, on the reasoning that the icon should escalate with the
wording; that was dropped because a status here is a *description of state*, and
an icon on it is decoration the state does not need. The `<tg-thinking>` shimmer
already carries "something is in progress" on its own, which is exactly the job
an icon would have been doing. This is deliberately narrower than the rest of
§1.3: the "agent is working" beats elsewhere keep their glyphs, because those
narrate work the bot is doing, while these describe another human not having
answered yet.

The two late tiers are **claims about machinery that really ran**, and that is why
their boundaries are where they are: the §3.5 scheduling/venue nudge fires at 6 h,
and the §3.5c "still on?" check-in at 24 h with cancellation at 48 h. Move a
boundary and you are asserting something about those workers — check them first.
Copy constraints: one line (~30 chars), and **no gendered verb about the
partner**, since a gendered ladder would double the key count in ru/uk/pl; the bot
referring to itself stays masculine per `VOICE_SELF_GENDER` (§2.1).

Tiers need an anchor, and nothing existing answers "how long has this side been
waiting" (`acceptedByA/B` are booleans, `availableTimesA/B` carry no submission
time, the row's `updatedAt` moves for unrelated reasons), so
`Match.peerWaitStartedAtA/B` carries it. The worker is its **only** writer —
stamped on the first tick a side is seen waiting, released when the wait ends so a
later wait on the same match restarts at tier 1 rather than opening on the
deadline copy. The action handlers deliberately write no anchor: they only ever
fire the instant the user commits, so tier 1 is true for them by construction.

**Why a worker.** A rich draft is ephemeral — it dies ~30 s after it is issued,
and the only way to hold one is to re-issue the same `draft_id`. So a shimmer
that lasts hours means a tick on a wall-clock interval shorter than that TTL:
`PEER_WAIT_TICK_MS` (default 20 s, `0` disables the feature). It is a
`setInterval` rather than a cron because node-cron's finest granularity is one
minute — already too slow. That per-waiter heartbeat (~3 API calls a minute) is
the real cost of this feature and was accepted deliberately; the tick is paced at
25 calls/s like the countdown worker. **A previous revision of this section
argued the opposite — that a shimmer must cover only the moment of the action and
never the wait. That was overruled (founder decision 2026-07-28) after a live
probe held one draft across 15 consecutive re-issues over 5 minutes with no
throttling.**

Each tick re-derives who is waiting rather than tracking it, so there is no state
to leak and nothing to "stop": when the partner answers, the side stops matching
the predicate, the draft stops being re-issued, and it expires on its own. Per
side (`isSideWaitingOnPeer`):

| Step | Waiting when |
|---|---|
| Pitch decision | `proposed`, this side accepted, peer hasn't answered |
| Calendar | `negotiating`, `proposedTimes` non-empty, this side marked slots, peer hasn't opened it |
| Venue | `negotiating_venue`, this side submitted, peer hasn't |
| Venue change — board | `scheduled` + `liking`, this side hearted places, peer has none |
| Venue change — payment | `scheduled` + `agreed`, this side is not the payer |
| Venue change — wish card | `scheduled` + `agreed`, she handed the payment over (`venueChangeOfferPaySentAt`) |

Notes on the edges, each of which is a real trap:
- **Only an accept waits.** A decline is irreversible (§3.2 lifetime pair ban)
  and the decliner's next screen is the "what was the main reason?" prompt.
- **Both picked and nothing overlaps is a wait for NEITHER side (2026-08-05).**
  A picks Monday, B counters with Tuesday. Each of them can now end it alone —
  widen the selection, or tap one of the other's slots, which auto-locks the
  date (§3.6). That is the definition of "your move", so it gets the §3.5
  reminder and never a status. The 2026-07-30 revision had it the other way
  round (a dedicated ladder shown to both), reading the state off the machinery
  — each side is technically blocked on the other — rather than off what the
  person can do; the result was a status contradicting the very message that had
  just told them their partner countered. The predicate is now simply *the peer
  hasn't opened the calendar yet*, which is the only calendar state where a user
  genuinely has nothing left to try.
- **The calendar gate is `proposedTimes`, not `ticketStatus`.** `negotiating`
  also covers the Date Ticket gate, whose waiting state its Mini App owns by
  design. `proposedTimes` is written by `startScheduling`, which runs only once
  the gate settles or when the feature is off — while `ticketStatus` defaults to
  `pending` even with tickets disabled entirely, so gating on it would have
  silenced the calendar shimmer for everyone.
- **Venue "submitted"** means a confirmed Venue Intent V2 snapshot, or — on the
  legacy concierge path — both the vibe text and the departure pin.
- **The venue-change board is covered (2026-07-30), reversing an earlier
  exclusion.** It was left out on the grounds that its Mini App already polls at
  ~4 s — true only while that Mini App is OPEN. Close it and the chat said
  nothing at all, which is the exact silence this feature exists to end. Three
  rules keep it honest: the **payer never waits** (they owe the Stars, that is an
  action); a hetero **female initiator does not start waiting merely because she
  isn't the payer** — while she can still offer she holds a live decision of her
  own, and her wait begins at the moment she actually hands it over; and a hidden
  **express mint shimmers for nobody**, since it is invisible to the partner until
  paid and a shimmer in their chat would announce that something is pending. The
  payer matrix is not reimplemented — `isHeteroPair` / `payerSide` are shared from
  `handlers/matching/venue-change.ts` through a narrow structural row type, so the
  20 s tick never has to load the board's full select.

**The action handlers start it immediately** (`startPeerWaitShimmer`) so the chat
isn't empty for up to a tick; the worker takes over from there. Quiet hours do
not apply: a draft is not a message and raises no notification, the same
reasoning that exempts the pinned status banner and the pitch countdown.

**Fallback for clients that can't render rich drafts.** They would otherwise see
nothing at all, so they get one ordinary message whose text is rewritten as the
wording climbs — at most once a minute, since an edit is a real API call on a
real message (and raises no notification); that budget is comfortably finer than
the narrowest tier (5 min), so a tier change is never visibly late there either.
It is deleted when the wait ends. Its id lives in `Match.peerWaitMessageIdA/B`
(+ `peerWaitEditedAtA/B`) rather than in memory: a PM2 restart would otherwise
strand a permanent "waiting for them…" line in someone's chat. Once a side is on
the fallback it stays there for that wait — retrying the draft every tick would be
a guaranteed failing call forever.

**What is NOT replaced.** On the pitch decision the "you accepted" card **stays**
and the shimmer sits under it. Unlike the calendar and venue lines that card is
not a throwaway receipt: it is tracked in `calendarMessageIdA/B`, carries
`MESSAGE_EFFECT_MATCH_ID`, and later becomes the Calendar (§3.6) — in place when
the Calendar follows it directly, by delete-and-resend when the Date Ticket card
has landed below it in between (§3.5b). It never becomes the ticket card, which
is a separate message throughout. Blind-decision safe either way — the shimmer is
shown only to someone who has already committed, and says only that we are
waiting, never what the partner chose.

Deliberately not applied to: the other two venue ack branches (`venueVibeNoted` /
`venueLocationNoted`, which hand the turn straight back to the same user) and the
Date Ticket gate (no chat-side waiting line exists — the Mini App owns that
state).

**One known interaction, on the venue-change branch only.** A rich draft is
collapsed by a real message landing in the chat, and the other three scenarios sit
on statuses where the waiting side's chat is quiet by construction — nudges and
check-ins go to the side that owes an action, and the Profiler is gated on
`PROFILER_BLOCKING_MATCH_STATUSES`. Venue change runs on `scheduled`, which is
deliberately **not** a blocking status, so a Profiler question or a date-lifecycle
DM can land mid-wait. The next tick re-issues the draft below it (≤20 s), so the
shimmer returns rather than dying — but it is the one place where it can visibly
blink.


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

**The venue stage claims a message only from a side that still owes one
(2026-07-29).** The stage used to consume EVERY plain message for as long as the
match sat in `negotiating_venue`, including from someone who had already
submitted both fields and was only waiting on their partner. For that user there
is nothing to collect, so the handler answered with the fixed
`venueConciergeIntro` card + "Pick on map" button — a prompt they had already
completed. Asking "so what happens now?" therefore got the opening instruction
back, which reads as the flow having reset, and the question never reached the
concierge agent at all. (Nothing was ever actually lost: that branch only
replied, it wrote no state, and the server separately refuses to let a stray
message overwrite a confirmed intent — see *Venue Intent V2* below.)
`resolveVenueRoutingState` now decides ownership from whether the caller's OWN
side has a complete submission, so a submitted side's text falls through to the
menu agent like it does at every other stage. "Complete" is read off the legacy
`vibeText`/`vibeLat`/`vibeLng` columns because both write paths land there — the
chat handler directly, and the V2 Mini App confirm mirrors the confirmed origin
and text onto them — so one check covers every rollout mode. A **location pin**
is still always consumed by the stage regardless: falling through would leave it
silently unanswered. The agent is told which sides have submitted
(`describeActiveMatch`), so "what now?" is answered with the real state —
waiting on the named partner, still owing a pin, or the concierge already
picking — instead of a restatement of the mechanic.

**Reopening the Location Mini App after confirming restores the submission.**
A confirmed intent used to reopen on a blank map centred on the city default,
with nothing on screen acknowledging what had already been saved — on the one
screen where being wrong about that is most alarming. The Mini App now restores
the vibe stage with the saved origin and chips for a `confirmed` intent exactly
as it already did for a `draft`. This also gives the stage its first way to
change your mind before the partner submits: re-confirming overwrites this
side's intent and is otherwise a no-op.

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
- both done → **no message**: this is the branch where the user has finished
  their side and has nothing left to do, so it gets the §3.6b waiting shimmer
  instead of the old `venueWaitingPeer` line, held until the partner submits.

The same `sendVenuePostSaveAck` helper drives all three paths
(`handleVenueLocation` / `handleVenueVibe` / `POST /v1/location/select`)
so the wording stays consistent regardless of which surface the user
saved through.

**The departure point must be inside a launched market (added 2026-08-05).**
Until this gate, the only validation on the pin was that the coordinates were
numbers — so a user could mark a point in another city or another country, and
the flow accepted it. The registration city has had a real gate since §1.3
(`validateHomeLocationPayload`); the departure point had none, on the same
data.

Nothing fake was ever assigned — `scoreVenueCandidate` discards anything beyond
the commute cap, so the run simply found nothing and the pair sat in
`negotiating_venue` until the §3.5c chain cancelled them 48 h later, with a
lifetime pair ban (§3.2 filter 6) as the parting gift. **The failure was
silent and terminal, which is why this is a gate and not a warning:** a pin
outside the market provably cannot yield a candidate, so accepting it only
defers the same dead end to a screen that can no longer fix it.

- **The screen refuses it, and says why.** The Location Mini App centres on the
  user's own city (not a hardcoded default), recomputes the distance on every
  pan, and while the pin sits outside the market it disables Confirm and shows
  a card naming the city. `GET /v1/location/venue-intent/state` serves the
  market (centroid + `radiusKm`) rather than the bundle carrying it, so a second
  launched city needs no Mini App redeploy. The pin is never *moved* — someone
  panning is exploring, and snapping them back would fight the gesture.
- **Search cannot offer one either.** `/v1/location/search` restricts Places to
  the market circle instead of merely biasing toward it, so an out-of-market
  address never appears. A bias only reorders, which meant the block card had to
  explain a result the search had just offered.
  **The restriction goes to Places as a RECTANGLE, and the circle is restored by
  a per-result filter (fixed 2026-08-09).** `searchText` accepts a circle for
  `locationBias` but **not** for `locationRestriction`, and it does not quietly
  widen the search when handed one — it answers `400 INVALID_ARGUMENT`, which
  the route's catch reports as an empty result list. So from the day this gate
  shipped (2026-08-05) until the fix, typing anything into the departure-point
  search returned **nothing at all** for every user in a launched market, and it
  read as "no such place" rather than as a fault: HTTP 200, `results: []`, no
  error on screen. It went unnoticed for four days because no production user
  had yet reached the venue step (0 dates ever), so the failure had never once
  been executed. The box is the smallest one containing the market circle — it
  necessarily over-includes at the corners, which is why the existing
  `checkDepartureOrigin` pass over the results is load-bearing rather than
  belt-and-braces: it is what keeps the offered results and the circular write
  gate in agreement, so search can never surface a place that Confirm would
  refuse. Over-including is the safe direction; a box narrower than the circle
  would hide real addresses inside the market. Nothing about the product rule
  changes — the gate is still exactly the market circle.
- **`services/venue-origin.ts` is the enforcement point**, and every write goes
  through it: `POST /v1/location/select`, `interpretVenueIntent` /
  `confirmVenueIntent` (Telegram Mini App *and* the iOS `/v1/matches/:id/*`
  pair), the legacy mobile `POST /v1/matches/:id/vibe-location`, and the raw
  Telegram attach-menu pin (`handleVenueLocation`, which had no validation at
  all). Refused with `400 origin-outside-market` carrying the market, so the
  native client can name the city too — never as `wrong-state`, which would
  misreport why the write failed.
- **Fail-open on missing data.** An account whose dating city is absent or not a
  launched market is not gated. Blocking someone over a gap in OUR data is never
  right, and such an account cannot hold a match anyway (matching joins on an
  exact `homeCityKey`), so the permissive branch is unreachable in practice.
- **Demo (DEMO_MODE.md):** the gate is NOT waived — the visitor sees the real
  card with the real reason — but it gains one extra button that drops the pin
  in the city, because a demo visitor is often genuinely abroad and would
  otherwise be asked to lie about where they are.
- **Both surfaces since 2026-08-06.** The `market` field was added for iOS on
  2026-08-05, but declared in the OpenAPI as `oneOf: [$ref Market, "null"]` —
  the shape swift-openapi-generator drops silently — so it never reached the
  generated client and the live gate existed on Telegram only. For that day the
  native client centred its map on a hard-coded constant and let any pin
  through to the server's refusal. The schema is now a bare `$ref` (an explicit
  JSON `null` still decodes to absent, so nothing on the wire changed), and iOS
  centres on the market, draws the radius, gates Confirm locally and names the
  city — including on the "use my location" branch, which is the likeliest way
  to set a bad point. The native client repeats the server's haversine
  deliberately, R = 6371 and all: `CLLocation.distance` measures on the
  ellipsoid and would disagree with this module by tens of metres at a 21 km
  radius, producing a band where the client allows what the server refuses.

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

**A date is never lost to geometry (the geo ladder, added 2026-08-05).** The
selector needs a venue within `maxCommuteKm` (8) of BOTH origins, with the two
commutes within 3 km of each other. Two people at opposite ends of one city
cannot satisfy that — Troieshchyna ↔ Vyshneve is roughly 30 km apart, more than
twice the limit — and the engine's answer used to be *no venue at all*.
That is legal input producing a cancelled date, so the selector now retries
with progressively wider tolerances instead of failing:

| Rung | Worse commute | Fairness gap | When |
|---|---|---|---|
| 1 | the pair's own `maxCommuteKm` (8 km) | 3 km | the ordinary case |
| 2 | 12 km | 5 km | rung 1 found nothing |
| 3 | the market radius | — | still nothing: the best available in the city |

**Only the two geographic caps move.** Quality floors, opening hours, the
price policy and every hard constraint (indoor/outdoor) are identical on each
rung, so a widened run is a longer trip, never a worse venue. Rung 3 is bounded
by the market radius, which the departure-point gate above guarantees both
origins sit inside — so a pair inside a launched city can always be served,
worst case a venue ~21 km from one of them (it was ~60 km until the radius was
narrowed to the city on 2026-08-18, which tightened this rung for free). That
is not a good date; a cancelled one is worse.

The scoring scales follow the active rung rather than staying fixed, so a
widened pass still discriminates: at a 21 km cap a venue 3 km from both must
still outrank one 18 km from one of them. The rung that actually produced the
pick is recorded in `venueSelectionReason` and in the `poolSizes` funnel
(`geoRung`), so "how often does the engine have to stretch?" is a query rather
than a guess — if it stops being rare, the city's catalog is too thin.

One consequence for the failure path: **commute can no longer be the reason a
run found nothing**, so `minimalRelaxation` lost its `commute_12_km` branch and
the no-candidates notice no longer suggests relaxing a distance the user cannot
see a control for.

**Only `base`-tier venues are ever auto-assigned.** `CuratedVenue.tier` decides
which pool a venue belongs to, and the automatic first assignment reads `base`
only (§Premium for `premium`; §3.7b for the board). The third value,
**`alternative`**, is the operator's *heavier-cuisine* pool — Georgian, Uzbek,
Azerbaijani, Middle-Eastern, Central-Asian and similar. These are good venues,
but not the call Gennety makes FOR a pair sight-unseen on a first date, so the
concierge never proposes one: they exist purely as options the couple can pick
themselves in the post-assignment Venue Change board (§3.7b), where they are
unlocked and priced exactly like base (it is a *cuisine* classification, not a
price tier, and carries no Premium gate). Because neither `premium` nor
`alternative` is ever auto-assigned, neither is held to the ≤ MODERATE
student-friendly price cap — that cap exists to protect the automatic
assignment. Operator classification lives in the replayable Kyiv manifest
(`scripts/curated-venues.kyiv.expansion.json`).

Operator-blocked brands are excluded at every venue boundary: curated ranking,
candidate seeding/import, and live Google Places fallback. The Kyiv catalog
currently blocks all Musafir locations. Kyiv's reviewed additions and explicit
rejections are tracked by stable Google `placeId` in
`scripts/curated-venues.kyiv.expansion.json`; `pnpm sync-venues:kyiv` refreshes
their Places metadata before reconciling the replayable approved JSON.

A curated venue that is **closed at the agreed date/time** (per its stored
Places `openingHours`, evaluated in the venue's local time via
`utcOffsetMinutes`) is skipped at selection.

**Unknown hours are a refusal on the automatic assignment, and an admission on
the paid board (corrected 2026-08-09).** This paragraph used to say missing
hours were "treated as open, never a reason to exclude", which described
`isVenueOpenAt` — the predicate the §3.7b board still uses — and had been
untrue of the live selector since Venue Intent V2 reached 100%.
`hoursEvidenceAdmits` (`services/venue-intent-v2.ts`) fails closed instead, and
that asymmetry is deliberate: the board offers a venue the couple is choosing
with their eyes open, while the concierge picks one FOR them, sight unseen, and
"we have no idea when it is open" is not a good enough basis for that.

The consequence is that **public space needs an explicit operator mark**, since
Google publishes hours for a café and none at all for a street, an embankment
or a park. `CuratedVenue.hoursConfidence` carries it: `always_open` admits the
venue at any slot, `operator_confirmed` clears the evidence bar while still
honouring a recorded schedule, and anything else (`provider`, `unknown`, null)
needs real hours. Six Kyiv parks — Воздвиженка, Андріївський узвіз, Оболонська
набережна, Маріїнський парк, Міст закоханих and the botanical garden — sat in
the catalog looking healthy and were **never once assigned** because nothing had
ever written that field; the rule that dropped them was an unnamed inline
expression, so neither the catalog playbook nor the operator could see it. Five
are now marked, and the botanical garden is deliberately **not**: it is gated,
ticketed grounds with real closing hours, and the reason rides on the row
(`reviewNote`) so the next reviewer does not read the omission as an oversight.
The mark lives in the replayable city manifest rather than only on the built
row, because `sync-venues:kyiv --apply` regenerates those rows from Places and
would otherwise revert it silently — `--check` now fails on that divergence and
warns about any venue left with neither hours nor a mark.

The curated base is kept fresh by the
daily **venue re-validation** cron (`services/venue-revalidation.ts`): it
re-checks the oldest-verified active venues against Google Places by stored
`placeId`, deactivates ones that closed or dropped below the rating/review
floor, and refreshes opening hours. An infra failure never deactivates a venue.

**Season and weather sink an unsuitable venue, they never remove it
(feature-flagged `VENUE_SEASON_WEATHER_ENABLED`, added 2026-07-31).** A park in
a January downpour is a worse date than the same park in June, and the engine
had no way to know it. The founder decision is explicit about the shape of the
fix: this is a **ranking** signal, not a filter. A rained-out park drops a few
places among venues the ranker already considers comparable and stays fully
selectable — because a forecast can be wrong, a provider can be down, and
neither is allowed to withhold a venue from a couple. It is the same principle
the catalog already applies to unknown opening hours (unknown → treated as open,
never as grounds to exclude), and the same one behind removing the hard
constraints in §Venue Intent V2: a need this specific belongs to the pair, who
can change the venue on the §3.7b board or simply agree to walk somewhere else.

Two independent inputs multiply, and the product is clamped to **[0.8, 1.1]**:

- **Season** — a pure function of the date's month, so it costs nothing, cannot
  fail, and keeps working when the forecast does not. Winter sinks outdoor
  venues (mixed indoor/outdoor ones less), summer lifts them, and a scenic
  outdoor spot gets a small extra summer amplifier. **Spring and autumn are
  deliberately neutral** — in Kyiv they are exactly the seasons where the
  calendar predicts nothing and only the real weather is informative.
- **Weather** — the hourly forecast for the agreed slot (Open-Meteo, no key).
  Heavy rain or severe conditions sink exposed venues, freezing or extreme heat
  sinks them further, clear and mild weather lifts them. **An unknown forecast
  scores exactly like perfect weather, never like bad weather**, so an outage
  can never delete the outdoor half of the catalog.

Indoor venues — most of the catalog — are untouched by both, exactly 1.0. A
venue whose exposure the catalog does not record is also untouched: exposure is
read from the venue's indoor/outdoor capability, falling back to the category
**only for parks**, where the category alone settles it. Guessing "indoor" for
an untagged restaurant would be inventing evidence.

The clamp is the product guarantee, and it is a code constant rather than a
tunable: context can never outrank fit or quality (the same rule that bounds the
§3.7 diversity mechanics). Unclamped, a cold severe winter day compounds to
~0.69 — enough to push a genuinely better venue below a worse one, which is the
one trade this whole area of the product refuses to make. When the flag is off,
the multiplier is a constant 1.0 and no forecast is ever requested.

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
- For `cafe`/`coffee_shop`/`restaurant`/`lounge`, price evidence is mandatory
  and `priceLevel ∈ {FREE, INEXPENSIVE, MODERATE}`. Unknown and premium
  commercial prices fail closed. V2 museums likewise need provider or
  operator-confirmed price evidence; public parks may have no commercial price.

Candidates that pass the gate are ranked by
`rating × log10(userRatingCount + 10) × distanceFactor` (linear
1.0 → 0.5 over the search radius), and the top-1 is picked. This
beats Google's default ordering, which would pick the
closest-but-mediocre place over a slightly-further-but-popular one.

The compatibility picker tries `searchNearby`, then midpoint-biased
`searchText`, under the same strict gates and fails closed when neither returns
an eligible real place. Production has no relaxed expensive tier and no local
venue stub.

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
confirmation is the plain-text DM above). **Telegram-only, and deliberately so
— see the end of this section for what iOS does instead.** When on, each
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
  The three beats always play through even when the render beats them to it
  (`NEVER_CUT_SHORT`, §1.3) — a fast render used to collapse the status to a
  sub-second flash of its first line, leaving the venue-search shimmer above it
  as the last thing visibly on screen.

- **The bottom block cannot be pushed around by the venue's paperwork
  (2026-08-20).** The venue name and address are each clipped to ONE line, and
  the "made with Gennety" credit leaves the address's line when the address is
  long. Both rules exist because the block sits at the end of a fixed 1350px
  card behind a `flexGrow` spacer, and that spacer is the only slack there is —
  46px, i.e. one wrapped line and nothing more. The credit used to be a flex
  sibling of the whole venue COLUMN, and yoga defaults `flex-shrink` to **0**,
  so a long address did not yield: it grew to the content width and laid the
  credit out after itself, **off the canvas**. Measured on the reported card — a
  57-character Kyiv address, around p75 of the real curated catalog — the
  credit's right edge landed at x=1127 on a 1080px card, hard-clipped; anything
  past ~45 characters did it, which is over half the catalog. **Nothing is lost
  when the ellipsis fires**: the scheduled DM prints the name and the full
  address verbatim in its caption one line below the photo, and the exact place
  rides the "Open in Maps" button. On the photo the credit sits on a scrim,
  because a duotone photo runs from near-black to cream and neither a light nor
  a dark credit is legible over both — measured on the real render, the scrim
  carries it at 5.79:1 over the cream end and 17.99:1 over the dark; beside the
  address it is plain muted text, since that ground is the card's own background
  and a chip floating on cream reads as pasted on.

- **Which of the two homes is a CONDITION again (2026-08-23), after three days
  of being unconditional.** That pass moved the credit onto the photo always,
  on the stated grounds that "satori exposes no text metrics before a render, so
  'does it fit' cannot be answered honestly" — so a venue whose address used
  half the width still lost the credit off its line, for a constraint that was
  not binding. The first half of that reasoning is true and the conclusion was
  not: `@napi-rs/canvas` is already a dependency of this renderer (it does the
  duotone, the grain and the face blur) and measures the SAME font file satori
  is handed. Measured against satori's own laid-out advance width over Latin and
  Cyrillic at both sizes, it agrees to within **2px and 0.45%**, and always
  under-reports, because satori rounds up to whole pixels. The minimum gap
  between address and credit is 40px — thirteen times that worst error — and a
  test pins the agreement, so a font swap or a satori upgrade that changed
  shaping lands there rather than on someone's card.
  **Only the ADDRESS shares its line**; the venue name keeps the full content
  width in both branches. Measured over the real curated catalog, the credit
  goes inline for **95.6% of Kyiv venues** (79.6% across all three
  launched-city files, whose addresses carry an oblast name and run longer), so
  the photo corner is the long tail rather than the common case. Putting the
  whole column beside the credit, as the pre-2026-08-20 layout did, would have
  cut that to 59.8% and started ellipsizing names that are fine today.
  **The old failure does not come back with it, and that is structural rather
  than a matter of the measurement being right.** Inline, the address is clipped
  to a FIXED width, so the credit's box is decided before the address is read
  and no address length can move it; on the photo it is absolutely positioned,
  so nothing in the flow can. A wrong measurement can therefore only ellipsize
  an address a few characters early — it can never lay the credit past the
  canvas edge. Measured on the real render, dropping that fixed width does not
  reproduce the 2026-08-20 bug either: yoga shrinks both children instead, the
  credit squeezes 188px → 157px and wraps onto two lines, and the row grows
  40px → 58px, pushing the block up into the polaroid. That is the silhouette
  drift the rule above forbids, so it is guarded the same way.

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
  chat. Screenshots and screen recordings are a weaker story and must not be
  read as a guarantee: many Telegram clients do blank protected media out of
  them, but that is the client's choice rather than something the Bot API
  promises, so the blurred share copy remains the actual off-platform privacy
  guarantee. **Demo mode is the single exception, and it exists because of that
  blanking**: a filmed walkthrough would record a black rectangle where the
  partner should be, so `PROTECT_PARTNER_MEDIA` (`demo/config.ts`) turns the
  flag off there — the demo partner is a puppet with no photo to protect
  (DEMO_MODE.md). Every sender reads that one constant rather than its own
  flag, so a new partner-facing surface cannot half-apply the rule.
- **Venue photo — Google Places, single source (2026-07-25).** Every venue's
  hero image is the place's Google Places **cover** photo, credited on the card;
  Google's bytes are fetched at render time and never persisted (only the photo
  *resource name* is stored). This holds regardless of how the venue was chosen:
  Places-sourced venues carry the resource name from the search response, and
  **curated** venues — which store no imagery of their own — have theirs
  resolved from their stable `placeId` at the moment the venue is assigned
  (auto-assign, and the §3.7b venue-change agreement / express mint alike). One
  lookup per scheduled date, so the pointer is always fresh rather than a stored
  ref that can rotate and 404. No photo → a branded gradient backdrop.
  The previous "curated-first, operator-owned `CuratedVenue.photoUrl`" rule was
  removed: not one curated row was ever photographed, so the primary assignment
  path always fell through to a photo-less card. Operator-supplied photos are
  not part of the product today; if reintroduced they must be an explicit
  override with a seeding path, never a silently-null field.
  **The photo is fetched ONCE per date, before either card renders
  (2026-08-31).** Both sides show the same venue, and both cards are rendered
  under one `Promise.all` — so resolving inside the render meant the second
  side's fetch was in flight while the first side rasterized. A rasterize is
  synchronous native work (satori → resvg, plus the canvas duotone and grain)
  that blocks the event loop for tens of seconds, while the fetch's
  `AbortSignal.timeout` counts in **wall-clock** time, so it aborted every
  time. Measured on a real match: the fetch takes ~2.5 s on a free loop and
  returns null when the loop is held for 9 s, against a single card that
  rasterizes in ~45 s — the 8 s budget never stood a chance. **Both** delivered
  cards therefore fell back to the branded gradient, which reads exactly like a
  venue with no picture, so the fault was invisible from the product side and
  had to be found by diffing a delivered card against a fresh render. Resolving
  ahead of the renders is what puts the fetch back on a free loop; raising the
  timeout is not a fix, because the loop is blocked far longer than any sane
  budget. It also halves the billed Places media requests and the duotone cost
  per date, but that is the side benefit, not the reason.
  **A failed fetch is now logged rather than swallowed**, by the same rule
  §3.7b already states for the board's photo proxy: best-effort means retried
  and logged, never silent. The log line redacts `key=` — the media URL carries
  `PLACES_API_KEY`.
  **The §3.7b board reads its photos off the venue row, and pays nothing for
  them (2026-08-20).** A curated venue's board card and detail gallery were
  blank for the same structural reason as the date card once was — curated rows
  carried no imagery — and it went unnoticed because until the catalog was
  scoped by `cityKey` the curated branch never ran in production at all, so
  every board fell through to the Places sweep, whose search response already
  carries photos. The first fix had the board resolve each card's photos from
  its `placeId` per board open, cached in process. That worked and was paid for
  repeatedly: process memory is thrown away on every deploy, so the next board
  re-bought the whole city, and the cache could not be shared with anything
  else.
  The refs now live on `CuratedVenue.photoRefs`, filled by the nightly
  re-validation cron out of the Place Details call it **already makes** per
  venue for hours and rating. Place Details is billed by the most expensive
  field requested rather than by their sum, so folding `photos` into that
  existing request costs at most what it already cost — which holds whichever
  SKU tier `photos` belongs to, so the saving needs no pricing assumption. The
  board's own lookup survives as the **fallback** for a venue the scan has not
  reached yet (a full Kyiv cycle is ~10 nights at 30 **places** a night);
  deleting it
  would put photo-less cards on the board the first time a venue is added.
  The row deliberately stores more refs than the board shows (10 against
  `VENUE_CHANGE_PHOTOS_PER_VENUE`), and the slice is on READ, so raising that
  product number later is a one-line change rather than a ten-night wait for the
  catalog to be re-scanned.
  **The cycle is nights-per-PLACE, and that had to be made true (2026-08-23).**
  The cron counted rows, so it re-fetched each venue once per `universityDomain`
  copy and swept unlaunched markets too — 1712 rows, a 57-night cycle, and
  `photoRefs` reaching **0 of 275 Kyiv places** while filling 90 rows in cities
  where a match is impossible. So the paragraph above described a saving that
  had never once been delivered to the only launched market: every board open
  and every venue assignment in Kyiv still bought the photos this column exists
  to hold. It scans distinct places in launched markets now, and one request
  settles all copies.
  Best-effort by rule: an unresolved photo leaves the category glyph the client
  already draws, and a board is never held up or failed for imagery. Only the
  board *read* pays for this; the like/confirm calls rebuild the same catalog
  purely to re-resolve a submitted key and skip the lookups entirely.
  **Delivering those bytes is retried, on both hops (2026-08-08).** "Best-effort"
  was being read as "one attempt", and one attempt is not enough on this path:
  the droplet hits occasional TCP connect timeouts reaching Google's photo CDN —
  measured at roughly one request in ten under a parallel burst, in **production
  as well as the demo**, and invisible until now only because production has
  never had a date reach this board. The board opens ~13 tiles at once, so a
  single blip landed on several of them, and the client's fallback was terminal:
  it swapped in the category glyph, marked the tile settled and never asked
  again, so one dropped connection cost a permanently blank tile until the Mini
  App was closed and reopened. The proxy now spends its existing 10-second
  budget on up to 3 attempts (≤4s each, 150ms apart) instead of one long wait,
  and the client retries once more after 600ms — so a tile has to fail twice, on
  two different hops, before anyone sees a glyph. **Only transient failures are
  retried**: a thrown fetch, a 5xx, a 429 or a 408. A 4xx, a non-image body and
  an over-ceiling file are verdicts that do not change on the second ask, and
  re-downloading an oversized image is not a fix. The client's retry asks for a
  marked URL and paints the one that actually decoded, never the one it started
  from — otherwise a rescued tile would immediately re-request the bytes that
  just failed.
  **And a failed photo is always logged now.** The two non-throwing failures —
  a non-OK upstream and a non-image body — used to answer 502 in complete
  silence, so a systematic upstream problem (a quota, a revoked key, a 429
  storm) was indistinguishable from "photos just don't work" and left almost
  nothing in the logs to go on. Every exhausted request logs its attempt count
  and last reason; a blip that a retry rescues logs one line too, because a
  rescue is rare by definition and is the only early warning that the path is
  degrading before it starts costing users actual photographs.
  **But the hop BEFORE that one could still blank a venue for a day, silently
  (2026-08-15).** Those retries harden the delivery of bytes; the failure found
  in the demo was one step earlier, in *resolving the refs*, and it never
  reached the proxy at all — a card with no refs draws the category glyph
  without making a request, so there was nothing for the proxy to retry and
  nothing in the log to read. Google answers "this place has no photos" by
  omitting the `photos` field, which is also what a partial 200 looks like, so
  an empty array is **not** authoritative; caching it for the same 24 hours a
  real answer earns meant one such response took a venue's pictures off the
  board until the next process restart. Only a **non-empty** answer is trusted
  for a day now — an empty one is held for the same few minutes an outright
  failure is, and says so in the log. Measured rather than reasoned: the
  long-running demo process served a Kyiv venue with zero refs while a fresh
  process resolved six for it in the same minute and Google answered 20/20 with
  photos; restarting the process put the board back to 12/12. The cost of the
  short window is one Place Details call per genuinely photo-less venue per five
  minutes, and only while a board is open — the catalog is fetched on open, not
  on the ~4s state poll. **This is why an empty photo set must never be treated
  as a fact about the venue**: it is a fact about one response.
- **Never wedges.** Any render/send failure degrades per-side to the existing
  plain-text scheduled card, so one side's hiccup never denies the other their
  card and scheduling always completes.

**The native client does not receive this PNG, and should not (2026-08-06).**
iOS renders the scheduled state as a live SwiftUI card off `SerializedMatch` —
no new route, no render job, no `DATE_CARD_FEATURE_ENABLED`. The PNG exists
because a Telegram chat cannot draw a countdown, honour Dynamic Type, or read
itself out under VoiceOver; shipping the same image to a client that can do all
three would be a regression, and the shareable-with-blurred-face copy is a
Telegram affordance with no App Store equivalent yet. What the server owes the
native card instead is one field: **`SerializedMatch.timeZone`**, the caller's
own city zone. `agreedTime` is an instant and the card has to draw it on a wall
clock — the device's is wrong for a traveller, who would read and turn up at a
time neither side meant. It is the same choice this PNG already makes by
rendering in the canonical city zone, and the same reason `CalendarState`
carries the field (§3.6).

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
  within **`VENUE_CHANGE_RADIUS_KM` (3 km)** of the original venue center —
  **except `premium`, which reaches `VENUE_CHANGE_PREMIUM_RADIUS_KM` (5 km)**
  (below) — **curated-first** with the Places fallback under the production
  quality gate.
  **The board holds `VENUE_CHANGE_CATALOG_LIMIT` (21) alternatives, whatever the
  radius turns up** — in a launched city that is a small fraction of what
  qualifies (the median Kyiv board centre has ~138 candidates in range), so the
  cap, not the catalog, is what decides board size. Raised 12 → 21 on
  2026-08-18 for a wider choice; the share of centres that can fill a board
  barely moves (89% → 86%, and the few that cannot could not fill 12 either).
  **What it costs is agreement, not scrolling.** This board is a coordination
  mechanism rather than a browsable catalog — a change settles only when both
  sides heart the SAME venue — so widening it lowers the collision probability.
  Modelling k independent picks out of N, three hearts each falls from ~62% at
  12 to ~39% at 21; real overlap is higher (both are drawn to the nearest and
  the nicest, not to a uniform random pick), but the direction is the trade
  being made: more variety is paid for in extra rounds of hearting, and the pair
  lands more often in the both-picked-nothing-matched state, which deliberately
  shows no status at all (§3.6b) and waits on the 6h/12h reminder. Two
  consequences follow that a future change to this number inherits. **The
  reserves below are shares in effect and must move with it** — they are written
  as absolute floors, so a bare widening spends every new slot on cafés (see the
  walking-spot note). And **the per-board Places cost scales with it**: curated
  rows carry no imagery, so photo resolution is one Place Details request per
  card, bounded by exactly this cap.
  This board is the ONLY place `alternative`-tier venues (§3.7 — the operator's
  heavier-cuisine pool) ever appear: they are always included, unlocked, and
  priced like base, independent of `PREMIUM_FEATURE_ENABLED` and of whether
  either side subscribes. Only `premium` venues are shown-locked (§3.8).
  **One card per real venue (2026-08-03).** The curated base stores one row per
  university domain, so a city holds several identical copies of each place —
  Kyiv: 538 active rows for 127 actual venues, 90 premium rows for 18. While the
  catalog was scoped by `universityDomain` that was invisible (the scope took
  exactly one copy); scoping it by `cityKey` took all five, and since copies
  share coordinates they sort adjacently — the board became the same three
  places repeated four times each, with the pinned premium slots all holding one
  venue. The catalog now collapses rows on the same key the board already
  resolves picks by (`placeId`, falling back to name+address), keeping the
  copy the re-validation cron confirmed most recently. The automatic assignment
  has deduped by place id since it shipped; this is the board catching up.
  **The assigned venue is not among the alternatives (2026-08-03).** It is
  already the pinned "keep this place" card, and it is normally a curated row in
  its own city, so it used to render twice — and the two cards did different
  things. Agreeing on the pinned one (`KEEP_KEY`) keeps the venue for free and
  closes the session; agreeing on the identical place under its own key took the
  **paid** path, charging `VENUE_CHANGE_STARS` to "change" to the venue the pair
  already had. The exclusion is server-side and applied before the board cap,
  so the freed slot goes to a real alternative and the like/confirm calls refuse
  that key as `invalid-venue` rather than trusting the client to hide it.
  **The pinned card has a photo too (2026-08-08).** It was the one card on this
  board without one — a consequence of the exclusion above, since the card is
  not a catalog row and had nothing to inherit pictures from, so the board asked
  the pair to compare places while showing them everything except the place they
  already had. `original.photoRefs` on the board state carries it: the cover
  stored at assignment (`Match.venuePhotoName`, the same image the date card
  showed them), falling back to one cached Place Details lookup from
  `venuePlaceId` when a row carries no cover. The state is polled every ~4 s, so
  the common path is deliberately network-free; a failed lookup leaves the
  category glyph exactly as before. **The "Picked for you" badge moved onto its
  own line to make room.** A 68px photo takes 82px out of a ~350px card, and the
  badge sits in what is left — at which point no locale's wording fits
  ("Obecne miejsce spotkania" is 203px against 176px), so it wrapped into a
  two-line pill and pushed the venue's own name into an ellipsis. Heading the
  card instead, it fits on one line at any width in every language, and the row
  under it is the same picture / words / heart an alternative uses. The name on
  this card wraps rather than truncating — it is the one card whose venue is
  already yours; the twelve alternatives keep their ellipsis, because an even
  row height is what makes that list scannable.
  **The premium tier searches a wider radius** than the rest of the board,
  because the pinned slots must hold *different* venues and the premium pool is
  small and hand-picked: from Podil only 10 of Kyiv's 18 premium venues sit
  inside 3 km, while all 18 sit inside 5 km. A slightly longer trip is a fair
  trade for a nicer venue someone is deliberately choosing; it is never imposed
  on the automatic assignment, which keeps its own commute rules (§3.7).
  **Board ordering is pin-then-scatter** (deliberate conversion mechanic): the
  `VENUE_CHANGE_PREMIUM_PINNED` (5) nearest `premium` venues lead the list
  unconditionally, so a non-subscriber meets the locked tier before anything
  else; any further premium (to `VENUE_CHANGE_PREMIUM_MAX` (8) total) is then
  **shuffled into the remainder** alongside base/alternative rather than stacked
  on top, so a locked card keeps resurfacing as the user scrolls instead of the
  board reading as a paywall wall. The tail shuffle is seeded by the match id,
  so the order is stable across re-fetches (Mini App reopen, post-unlock
  repaint) — an unseeded shuffle would re-deal the cards under the user.
  **The board is never a wall of tables (2026-08-09).**
  `VENUE_CHANGE_WALK_RESERVED` (5) of the remaining slots are held for the
  nearest **outdoor walking spots** — the `park` category, which is what the
  curated base uses for the whole open-air set: parks, embankments, Andriivskyi
  descent, Volodymyrska Hirka, the Lovers' Bridge. All of them are free, need no
  booking, and work as a place to meet at a time the couple picks. Before this
  the order was decided by proximity alone, and in a city centre that means
  cafés: measured across every possible board centre in the live Kyiv catalog,
  **38% carried no outdoor spot at all** and the rest averaged one card (the
  board held twelve then) — while the median centre had **ten** parks sitting
  inside the same
  3 km radius. They were never out of reach; they were losing a race they cannot
  win, because a promenade is one venue along a kilometre of riverfront while a
  café cluster is thirty doors on one street. With the reservation that goes to
  **93% of boards and 2.8 cards**, with board size unchanged.
  **The reservation is a SHARE of the board in effect, and had to be re-sized
  when the board grew (2026-08-18).** It is written as an absolute floor, so
  widening the board 12 → 21 without touching it left the average outdoor count
  flat at ~2.6 cards — every one of the nine new slots went to cafés and
  restaurants, i.e. the failure this rule exists to prevent, reappearing purely
  because the surroundings changed. At **5** it returns to ~4.2 and stays nearly
  always fillable (81% of Kyiv centres have at least five parks in range against
  84% for three; the median centre has ten). Anything that moves
  `VENUE_CHANGE_CATALOG_LIMIT` again owes this number the same re-measurement.
  Three properties are deliberate. It is a **floor, not a cap** — an outdoor
  spot that would have earned a slot on distance still takes one, so a green
  district shows more than five. It **changes which cards make the cut, never
  where they sit**: the held cards join the same shuffled tail as everything
  else, the exact opposite of the premium pin above, because the point is that
  one is on the board at all, not that it leads. And it **degrades rather than
  shrinking**: the centres with no park in range keep a full board, exactly as
  before. Ticketed, timed venues are a different product
  answer and stay out — `museum` remains excluded from this board outright, and
  the reservation is not a back door for it. The radius is untouched (widening
  it to 5 km rescues only 3 of those 8 centres, so it buys a second knob for
  almost nothing). The Places fallback already sweeps `park`, so it inherits the
  same guarantee for free. Telegram-only; no new env, no schema.
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

  **A venue's photos open full-screen (2026-08-05).** Tapping any photo in a
  venue's detail gallery opens the ordinary lightbox — edge-to-edge on an opaque
  dark backdrop in both themes, swipeable across the whole set, with a `n / N`
  counter, its own ×, and Telegram's BackButton bound to closing it rather than
  leaving the venue. It exists because this board asks the couple to *choose* a
  place, and until now the largest a venue was ever shown was a 340px rail tile
  — you could not actually see the room you were agreeing to meet in. It opens
  on the tapped photo (never rewound to the first) and paints instantly from the
  copy the rail already decoded — **the same copy, at the same width, so opening
  a photo costs nothing (2026-08-20)**. It used to paint the rail's 1000px copy
  and then sharpen the slide being looked at to the proxy's 1600px ceiling,
  which was right about latency and meant every enlarged photograph was bought
  **twice**: the width is part of the proxy URL, so it is both a separate client
  cache entry and a separately billed Place Photo request. The rail and the
  viewer now share one width (`VENUE_PHOTO_WIDTH`, 1200), which costs nothing to
  raise — Place Photo is billed per request, not per byte — and 1200 is chosen
  to satisfy the fullscreen case rather than the tile: a 390pt phone at DPR 3 is
  1170 physical pixels, so simply dropping to the old rail width would have made
  "fullscreen" softer than what it replaced. The 240px card thumbnail is
  deliberately left as its own width: it is a genuinely different image at a
  genuinely different size, and there are 21 of them on a board against the
  handful a user opens. Vertical swipes are disabled
  while it is open — a fixed overlay has no scroll of its own, which is exactly
  when Telegram reads a downward drag as "close the Mini App", so dragging a
  photo would otherwise drop the user out of the app. A venue with no photos
  shows the category glyph and is deliberately not tappable: there is nothing to
  enlarge. Telegram-only; the same gallery (and viewer) backs both the detail
  page and the read-only venue preview reached from the agreed/settled screens.
- **Payment (150⭐, `VENUE_CHANGE_STARS`).** A settled change costs one flat
  Telegram Stars price; browsing/liking/agreeing are free and no one pays
  before an agreement, so **no refund path is needed** (the only refund is the
  parallel-pay race below). Payer matrix — **hetero: the man pays, whoever
  initiated**; same-sex: the initiator pays. The finalizer (whoever completed
  the agreement, definitionally the first to see the final screen) resolves it:
  - *he initiated* → he pays "no questions": invoice right in his Mini App if
    he finalized, else a pay-prompt DM. **That DM opens the board, not a bare
    invoice (2026-07-28).** Whoever finalizes decides inside the Mini App, on a
    screen that shows the venue and carries "keep this place" beside the pay
    button; this side wasn't in the Mini App when the agreement landed, so a
    chat message is the only way to reach them — and while it carried a
    `url`-to-invoice button it was a one-way door: the tap jumped straight to
    Telegram's native payment sheet, with no venue to look at and no way to say
    "actually, let's stay where we were". The way back did exist, but only on the
    earlier "📍 Change venue" message, which by then had scrolled off — so the
    product silently required knowing that an older message was the real
    surface. Same decision, same screen, whichever side you are. The DM is
    deliberately two lines — the news, then the venue — and names **no price**
    (founder call): the button no longer charges anything, so pricing it would
    misdescribe the tap, and the real number is stated on the pay button one
    screen later, before any money moves. The wish card
    (below) is deliberately NOT changed — it renders the venue itself and
    carries an explicit decline, so it is neither blind nor a dead end. Opening
    the board cold this way also loads no catalog, so the agreed screen pulls
    it in the background to fill its venue photo instead of showing a bare pin.
  - *she initiated, he finalized* → his in-app fork `[⭐ Lock it in]` /
    `[Not this time]`;
  - *she initiated, she finalized* → her fork `[Lock it in myself — ⭐]` /
    `[Ask him to lock it in 💌]`. The offer sends him the **wish card** — the
    date-card layout re-rendered with HER polaroid over the new venue's duotone
    hero (`services/venue-wish-card.ts`, headline "Her pick. Your move.",
    protected; text fallback so the offer never wedges) with pay/decline
    buttons. Its caption is **her ask only** — the card already renders the venue
    name and address, so repeating them in text was pure duplication
    (`venueWishText`, two short lines split by a paragraph break). The
    no-PNG fallback keeps the venue line (`venueWishTextFallback`): with no card
    there is nothing else naming the place he is being asked to pay for.
    One offer per session. **Handing the payment over is confirmed to
    her, not silent (2026-07-27).** Rendering the wish card and delivering it
    takes seconds inside her request, so the tap holds a named spinner
    ("sending your ask to {name}…") and then lands on a success screen of its own
    — the same treatment every other committing act on the board gets — stating
    that he now has this place in chat with a button to lock it in, and that her
    own "lock it in myself" path is still open. Before this the one moment where
    she hands the decision to someone else produced no reaction at all: the
    button sat dead for the render, then the same agreed screen redrew with one
    small note at the bottom, so the honest read was "nothing happened". Because
    that screen now asserts the card *landed*, the assertion is made true: a
    failed send releases the one-shot stamp and answers `send-failed`, so she is
    told it did not go through and can retry, instead of being told it arrived
    while the single offer is spent (previously the send error was swallowed and
    the API still answered ok).
  - His "not this time" (wish card button or Mini App fork) is **single and
    final, and ENDS the change**: the session closes, the originally-assigned
    venue simply stands, and she gets a neutral notice (`venueDeclinedKeepDm` —
    no price, no pay button) that never mentions a refusal. She is **never
    pushed to foot the bill** for a change he wouldn't. **While the fork is still
    open** (before he decides) both invoices can be open in parallel — her
    pay-self path and his — and the settle CAS makes the first payment win, with
    `refundStarPayment` returning the Stars of a lost race. **Every Stars charge
    is recorded in `venue_change_purchases` (unique `telegram_payment_charge_id`)
    BEFORE the settle CAS runs**, so the invariant is the same one Rematch
    states: a payment either changes the venue or comes back, never neither.
    That record is also what tells a *redelivered* payment (duplicate charge id →
    idempotent no-op) apart from a genuinely *second* charge (new charge id →
    always refunded, including when the same person paid twice). A refund whose
    provider call fails is parked in `refund_failed` for the hourly
    `venue-change-refund` sweep and is **never announced to the user as
    completed** (corrected 2026-07-26: previously the charge id was not stored at
    all, a failed refund was a fire-and-forget `console.error`, and a second
    charge from the same payer was silently kept). `pre_checkout_query`
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
  **The pinned status banner is re-rendered in the same breath** rather than
  left to the once-a-minute tick, since it names the venue too (§2.1). The free
  Premium/demo settle does exactly the same.
- **A finished session can be started over, up to `VENUE_CHANGE_MAX_PER_DATE`
  (2) settled changes per date (2026-08-09).** The board used to close for good
  on the first settle, which made "we picked, then we reconsidered" — an
  ordinary thing for a couple to do — structurally impossible. Two is the whole
  allowance: enough to change your mind once, not enough to become a venue
  carousel the partner gets a new card for every hour. **A lapse restarts on the
  same terms and costs no allowance** (nothing was paid); the asymmetry that
  left it terminal was never a decision — the male's "not this time" has always
  reset the status to null outright, so a second attempt already existed on one
  path out of three. Each change is a separate purchase at the full flat price,
  and the T−5h cutoff bounds every round exactly as it bounds the first.
  - **The restart is a session RESET, not a reopened flag.** The `venueChange*`
    columns are one slot, not a history, so a fresh round wipes both sides'
    likes, the initiator, the wish-card and decline stamps, the paid stamps and
    the board-ping ids — in the SAME compare-and-set that writes the new round's
    first like, so there is no instant at which the row is half-cleared. Two
    consequences are load-bearing rather than tidy: clearing only the
    restarter's likes would let the very first heart of round two "overlap" the
    partner's round-one heart into an agreement nobody is currently making, and
    leaving `venueChangePaidAt` set would keep the §3.6b peer-wait shimmer dead
    for the whole round.
  - **Nothing else about the board learns the word "restart".** Only the four
    entry points that know how to perform that reset — the state view, the
    catalog, the like submission and the express mint — ask whether a new round
    may start (`evaluateVenueChangeRestart`). Keep-original, offer-pay,
    confirm-overlap and pay-decline keep reading the ordinary live-session gate
    and so still refuse a finished session outright, which is what stops any of
    them running against columns describing a round that is over.
  - **A finished session reports an EMPTY board.** A settle leaves both sides'
    hearts in place and a lapse does not clear them either, so the state view
    zeroes them: otherwise the restart would open showing marks the next tap
    deletes.
  - **The success screen stays the landing, and the offer on it is quiet.** The
    board never reopens by itself under a result the user is still reading;
    "change the venue again" is a tertiary text link under Open in Maps, absent
    once the allowance is spent. It is deliberately NOT added to the settle DM:
    that card's job is to confirm what was just paid for, not to sell the next
    change. The durable way back in is the **My Date hub**, whose venue row now
    appears for a restartable session as well as a live one — the scheduled
    card's own button also still works, for as long as that card is findable.
  - **The cap is a counter on the row (`Match.venueChangeCount`), not a derived
    count of purchases**, because a Premium pair settles free and writes no
    purchase row — and so does every demo visitor (DEMO_MODE.md settles the
    board free, Stars having no mock rail). Those are exactly the cohorts money
    does not bound, so they are the ones the counter has to.
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
  both get a neutral notice, and the session ends. No Elo, no priority comp —
  nothing was lost, which is also why a lapse spends no part of the per-date
  change allowance and the board can be started over (above). The v1 "decline =
  cancel the match" branch is gone entirely, and with it the v1 disclaimer.

### 3.8 Gennety Premium (feature-flagged recurring subscription)

An optional **$17.99/month** subscription (Gennety Premium), gated by
`PREMIUM_FEATURE_ENABLED` (default **off**). **The price is denominated in
Telegram Stars, not in dollars**: the charge is `PREMIUM_STARS` (750⭐), and
$17.99 is exactly what Telegram's own Star store bills for 750⭐, so the label
states what the user actually pays rather than a marketing number. The two move
together — changing one without the other makes the button lie. The iOS rail is
Apple's own price for `premium_monthly` (StoreKit `displayPrice`, set in App
Store Connect), which is the only place that number lives; nothing in this repo
can set it, so keeping the two surfaces at the same price is an operator step,
not a code one. It is a **standalone per-user
entitlement** owned by `services/premium.ts` and deliberately decoupled from any
one feature — its first (v1) benefit is venue-change, but the entitlement is the
seam future perks plug into. Active ⇔ `User.premiumUntil > now`; the
append-only `subscription_ledger` (unique `externalPaymentId`) is the
source of truth and makes every grant/renewal exactly-once. An entitlement a
user already paid for stays valid regardless of the flag.

- **Two payment rails, one entitlement.** Telegram: a native **Telegram Stars
  recurring subscription** (`createInvoiceLink` with
  `subscription_period = 2592000` — Telegram supports only the 30-day period;
  empty provider token + `XTR`, no merchant account). The `sub:premium` payload
  is settled by the `successful_payment` handler on the first charge AND every
  auto-renewal, exactly-once via the recurring `telegram_payment_charge_id`;
  `premiumUntil` advances to Telegram's `subscription_expiration_date`.
  Cancellation is native (Telegram → Settings → Subscriptions) OR **in-chat via
  the menu agent** (below) and the entitlement simply lapses. iOS: a **StoreKit 2
  auto-renewable subscription**
  (`POST /v1/premium/appstore/transaction` + App Store Server Notifications V2)
  reusing the ticket-rail trust model (JWS/notification is only a pointer; the
  authoritative transaction is re-fetched from Apple). The subscription's
  `originalTransactionId` is stored on `User.premiumExternalId` so a renewal
  webhook (which carries no user id) finds the owner.
- **Purchase surface.** Telegram: a ✨ **Gennety Premium** main-menu row opens
  the Premium Mini App directly (`apps/webapp/premium.html`, `WebApp.openInvoice`)
  — no intermediate hub message (2026-08-29). `premium.html` already renders its
  own "active until …" / benefits state from `GET /v1/premium/state`, so a text
  message repeating that one tap earlier bought nothing. The old hub screen
  (`handlePremiumHub`, `menu:premium`) still exists and is reached two other
  ways: as the fallback when `WEBAPP_URL` isn't a real HTTPS host (dev without a
  tunnel — Telegram rejects a non-HTTPS `web_app` button outright), and as what
  the concierge agent's `open_screen("premium")` tool hands over via text/voice
  — a bot reply can only ever contain a *button*, never open a WebView on its
  own, so that tool still needs a callback to attach. iOS: a native paywall
  (designed in parallel; `features.premium` in `GET /v1/app/config`).
  **The hub (where it is still reached) names no price and its button does not
  ask for the sale** (2026-08-01). It used to open with the monthly price and a
  `Subscribe — $X/mo` button — a request for money made in the first message
  after the menu tap, before the product had shown what Premium does. The
  button is now a plain "Learn more" and the price appears one tap later,
  inside the Mini App, next to the benefits it buys. The hub's closing line is
  the reassurance, not a procedure: cancelling is one message to the concierge,
  which is the real mechanic (below) — the Telegram → Settings → Subscriptions
  walkthrough is gone from here and survives only where it is load-bearing, as
  the honest fallback when the Stars API cancel fails. An **App Store**
  subscriber viewing the hub gets Apple's own steps instead, since the
  concierge cannot cancel their subscription and must not imply otherwise.
- **In-chat cancellation (Telegram, agent-driven), two-stage confirm
  (2026-08-01).** When a user tells the menu agent they want to cancel / stop /
  turn off Premium — or asks how — the agent calls the `offer_cancel_premium`
  tool (`services/menu-agent.ts`); it never cancels from raw text. For a
  **Telegram Stars** sub the bot posts a nonce-bound, one-use **offer** card
  (`❄️ Keep` over `Yes, cancel`). Tapping **Yes, cancel** does **not** cancel
  anything yet: it burns the offer token and posts a second, freshly
  nonce-bound **final** card that isolates the destructive option exactly like
  the Freeze/Delete fork (§2.1) — one red **Yes, I'm 100% sure, cancel**
  against two green back-out buttons that both just navigate back to the main
  menu, relying on the router's existing pending-token cross-invalidation to
  burn the stale card rather than a dedicated decline handler. Only the final
  card's red button calls Bot API `editUserStarSubscription(is_canceled: true)`
  to stop the renewal at Telegram, then `recordInChatCancellation` flips
  `premiumAutoRenew=false` and appends a `cancelled` `subscription_ledger` row.
  Both cards share the same token mechanics as Freeze/Delete — a fresh
  10-minute, single-use nonce bound to its own message
  (`handlers/menu/premium-cancel.ts`). Access is **never** revoked early —
  `premiumUntil` stands, so the user keeps Premium until the paid period ends,
  and there is no mid-period refund. If the Stars API cancel fails (or no
  recurring anchor is on file) the bot does NOT claim success — it points the
  user to Telegram → Settings → Subscriptions. An **App Store** sub can't be
  cancelled server-side (Apple owns it), so the agent shows the exact
  iOS-Settings steps instead of a button — this can surface at either hop,
  since Premium state is re-checked both when advancing to the final card and
  again right before the mutation (it can drift during the up-to-10-minute
  window between the two cards). After a confirmed cancel the bot politely
  asks **why** (one line, skippable); the free-text answer is stored on that
  `cancelled` ledger row's `note` for churn analysis. Telegram-only (the menu
  agent is Telegram-only); iOS cancels natively via Apple.

**Three ways to buy it, one entitlement (2026-08-24).** The monthly plan is
joined by two fixed-length packages — **3 months at 15% off** and **6 months at
30% off** — sold as ONE-TIME Telegram Stars invoices. Every price is derived
from `PREMIUM_STARS` (`packages/shared/src/premium-plans.ts`), so a repricing
stays a single env change and the three plans cannot drift apart; at 750⭐ that
is 750 / 1912 / 3150⭐. **The derivation rounds DOWN**, because a fractional
result (750 × 3 × 0.85 = 1912.5) has to land on a whole Star and the two
directions are not equally safe: rounding up charges more than the advertised
"−15%", i.e. makes the label on the button a lie, while rounding down means the
buyer always gets at least the discount promised. The displayed currency price
is scaled by the STAR ratio rather than by the discount, so the label tracks
exactly what is charged, rounding included.

**A package is deliberately not a subscription, and that is a platform fact
before it is a product choice.** Telegram supports a 30-day `subscription_period`
and nothing else, so "3 months, renewing" is not expressible as a native Stars
subscription at all. What replaces the renewal is the expiry reminder below —
which is why the two shipped together: **a fixed-length product whose end is
never announced is access that silently vanishes.**

Four rules hold the two shapes apart, and each is a place the obvious
implementation is wrong:

- **A package STACKS, never replaces.** The new period is counted from
  `max(now, premiumUntil)`, so buying 6 months while a month is still running
  adds up instead of throwing the remainder away.
- **A package never claims the recurring head.** `premiumAutoRenew`,
  `premiumProvider` and `premiumExternalId` describe *the subscription*, so a
  package leaves all three untouched — the same rule the referral comp already
  follows. Writing them would either invent a renewal Telegram will never make,
  or overwrite a live monthly subscriber's cancellation anchor with a charge id
  that cannot cancel anything. The consequence is wanted in both directions: a
  package buyer with no subscription ends up Premium-active with
  `premiumAutoRenew = false`, which is correct (nothing renews) and is exactly
  what makes the reminder fire for them.
- **A paid grant may only ever EXTEND `premiumUntil`.** Telegram and Apple hand
  us an absolute "paid through" instant, and for a pure subscription each one is
  later than the last — so this guard is a no-op there and exists for the mixed
  case packages introduce: a monthly subscriber who buys 6 months has
  `premiumUntil` half a year out, and their next ordinary 30-day renewal carries
  an expiry ~30 days out. Writing that through would **silently delete five
  months of paid access on a charge the user had just made.** `revokePremium`
  (a refund) remains the one path allowed to shorten it.
- **Every package charge is a first period.** There are no silent renewals to
  suppress, so unlike the monthly rail it always DMs: the whole point of buying
  a fixed block is knowing how long you bought.

**The `sub:premium` payload still means MONTHLY, permanently.** Telegram
redelivers the ORIGINAL payload on every auto-renewal, so that tag is a frozen
wire format; the packages are `sub:premium3` / `sub:premium6`. Repointing the
old tag at a package would grant months for a monthly charge on every existing
subscriber's renewal.

**Access is not silently lost (§3.8 → the expiry reminder).** Two DMs per paid
period — **3 days out, then 24 hours out**. What they SAY depends on which of
two situations the user is in; only the lapse cohort carries a button into the
Premium Mini App, where all three plans live so the user picks the next stretch
rather than being sold one specific thing. These properties are load-bearing:

- **Two cohorts, two different things to say — never the same message.**
  `premiumReminderKind` decides which, and the split is about what is
  *truthful*, not about tone:
  - **`lapse`** — nothing renews: a package buyer, or a subscriber who already
    cancelled. Their access has a real last day, so the copy names it and the
    button opens the plans.
  - **`topup`** — a LIVE recurring Stars subscription. Nothing is ending here;
    a **charge** is coming, and Telegram takes it from the Star balance with
    **no card to fall back on**, so an empty balance ends the subscription on
    the spot. This message names the exact Star amount, says the balance has to
    be topped up in advance, and states that Premium pauses if it is short.
  Telling either cohort the other's message is a plain falsehood — "your plan
  does not renew itself" to someone we charge every month, or "top up your
  Stars" to someone whose access is simply ending.
- **An App Store subscriber is silent, and that is the third answer.** Apple
  runs its own billing retry and grace periods, and there is no Star balance to
  top up, so both messages would be untrue for that rail. The gate is therefore
  `premiumProvider`, not `premiumAutoRenew` alone.
- **The `topup` amount comes from the user's OWN last charge, never from
  `PREMIUM_STARS`.** A recurring subscription's price is frozen at the invoice
  that created it — deploy.md records a live 500⭐ subscription still renewing
  at 500⭐ after the env moved to 750⭐ — so the env price would misstate what
  leaves that user's balance, on the one message whose whole job is to name
  that number. It is read via `User.premiumExternalId`, the recurring anchor,
  rather than "newest XTR ledger row": a 3/6-month package writes a priced
  `started` row on the same provider, so the naive read would quote 3150⭐ to a
  monthly subscriber who once bought a package. An amount we cannot determine
  is **omitted** — the warning and the top-up path stand without it, and an
  absent number is a weaker message where a wrong one is a lie about money.
- **The `topup` message carries no button.** That user already has Premium, so
  the plans screen is the wrong destination, and Telegram exposes no deep link
  a bot can open on the Stars top-up screen — so the path is named in the text
  (Settings → My Stars) rather than rendered as a button that goes elsewhere.
- **It cannot be conditioned on the actual balance.** A bot cannot read a
  user's Star balance, so every recurring subscriber gets both touches whether
  or not they need them. That is the accepted cost of the guarantee: two DMs a
  month to a subscriber, against a subscription that dies silently on a charge
  nobody warned them about.
- **Once per PERIOD, not once per user.** Every path that advances
  `premiumUntil` clears both markers, so buying again earns a fresh pair.
  Without that reset a renewing user would be warned once in their life and
  every later period would lapse in silence.
- **Inside 24 hours only the accurate message is sent.** The two buckets are
  mutually exclusive, so a package bought with under three days of runway yields
  one honest warning rather than two contradictory ones.
- **Quiet hours can delay a reminder, never cancel one.** The Kyiv quiet window
  is 10 hours and the narrower bucket is 24 hours wide, so every eligible user
  has waking hours inside their own window.
- **Telegram-only, deliberately.** No push leg: the only way to buy Premium
  today is Telegram Stars, since the App Store subscription group has never been
  submitted (deploy.md), so a lock-screen banner telling an app-only user their
  access is ending would point at a purchase path that does not exist — the same
  reasoning §3.5b uses to withhold the Premium counterfactual from `/v1/*`.

**Demo mode sells the monthly plan only.** The demo has no mock rail for Stars,
and this route has never consulted `TICKET_STARS_ENABLED`, so a tap there
already mints a real invoice for a real charge; the packages stay out so one
accidental tap cannot cost a visitor ~$75 instead of ~$18. Refused server-side
rather than merely hidden — the catalog is the client's list, not the boundary.

**Benefit #1 — unlimited dates (2026-08-22).** An active subscription covers the
subscriber's own Date Ticket at the §3.5b gate, every time, with no per-date
charge and no wallet spend — see that section for the mechanics and for why
covering a partner stays priced. It leads the benefit list on every surface
that describes the subscription (the Premium Mini App's three benefit cards,
the menu hub's `premiumHubBody`, and `premiumWelcomeDm`), because it is the one
perk that changes what the product COSTS rather than what it looks like. The
break-even is ~2.6 dates a month at `TICKET_PRICE_CENTS`; there is deliberately
**no cap and no fine print** — a ceiling that never binds is an obligation with
none of the benefit — and the trigger for revisiting it is a metric (a
subscriber exceeding ~4 dates in a month), never a mechanism.

**Benefit #2 — every evening time (2026-08-26).** A subscription on EITHER side
opens the paid evening band in the calendar (§3.6) for that pair, on every date
they plan, with no purchase and no per-date fee. It is read live rather than
stamped at the gate, and the first prime pick under an active subscription
writes `Match.primeTimeUnlockedAt` — so a lapse cannot re-lock a slot the pair
already agreed on, and nothing is ever revoked from a date in flight.

It leads the benefit list on the Premium Mini App **second**, right after
unlimited dates, and that is a routing decision rather than a ranking one: the
one path this feature creates onto that screen is the calendar's locked slot,
and a reader who arrived that way is looking for exactly this line. The card
carries the same padlock the calendar plates a locked row with — recognition
beats semantics on a screen someone reached thirty seconds after meeting that
glyph. No surface that describes the subscription names the slot count: the
number is `PRIME_TIME_SLOT_COUNT` and copy cannot follow it.

**Benefit #3 — venue-change (v1).** Inside the §3.7b board:

- **Premium venues.** Curated venues carry a `tier` (`base` | `premium`).
  Premium venues are hand-picked nicer spots that **may exceed the ≤ MODERATE
  student-friendly price cap** — a deliberate, documented exception to the
  §3.7/§3.7b price gate that applies **only** to the premium tier and **only**
  in the paid venue-change board. The **auto-assign concierge picker stays
  base-only** (§3.7), so the default date can never break the price cap; premium
  is always an opt-in change, never the automatic first assignment.
- **Selection gate (either-party unlock).** Premium venues are always **shown**
  in the board (with a "Premium" plate on the card face + a lock badge on the
  select button) but are **selectable only when either participant has an active
  subscription** (`pairPremiumActive`). The gate is enforced server-side (the
  tier is re-resolved from the catalog; the client is never trusted) across
  likes, the multi-overlap confirm, and the express mint — a locked pick returns
  `premium-locked` (HTTP 402), which the Mini App turns into a subscribe-in-place
  CTA. Tapping the locked button opens the subscription flow; the card is still
  tappable to view details / open in Maps.
  **The Premium screen has a way back when it was reached from the board
  (2026-08-03).** Every premium affordance on the board hands off to
  `premium.html` with an ordinary same-origin navigation, and Premium used to be
  a one-way door: someone who read the price and decided against it had to close
  the Mini App entirely and reopen "Change venue" from the chat. It now carries
  a return target (`services`-free, client-side: `apps/webapp/src/return-to.ts`)
  and shows Telegram's native BackButton, which reopens the exact board they
  left. The button appears **only** on that arrival — a Premium screen opened
  cold from the main menu is the first screen of its session and has nowhere to
  go back to, so it shows none, and any BackButton the previous page left
  visible is explicitly hidden rather than left dead. The return is a fresh
  navigation rather than a history entry, which is what makes a *successful*
  subscription land correctly too: the board re-reads `pairPremiumActive` on
  open, so the premium cards come back unlocked. The return target is validated
  against an allowlist of known pages, never taken as a URL from the query
  string.
  **Back walks the whole chain, not one hop (2026-08-05).** The first version
  stored a single target, so each hand-off overwrote the previous one: board →
  Premium → referral (the referral cross-promo link, §3.9) left only
  "referral came from Premium", and the board was erased. Back therefore worked
  exactly once at any depth — the user landed on a Premium screen that now
  believed it had been opened cold, showed no button, and the only way out was
  to close the Mini App and reopen "Change venue" from chat. The trail is now a
  stack: every screen returns to the one that actually sent the user there, all
  the way down to the page opened from a chat button, which correctly has no
  back. Three rules keep it honest — a page already in the trail is treated as
  a **return** to it rather than a new level (so a loop between two screens
  cannot grow the URL forever or make back replay a path never walked), the
  depth is bounded, and every entry is re-validated against the same allowlist
  on the way out, so a hand-edited trail degrades to a shorter one instead of
  becoming a redirect. The top of the trail stays in the original query keys,
  so a client still running the previous bundle keeps its one working level
  rather than losing back entirely.
- **Fee waiver + counterfactual.** A settled change normally costs
  `VENUE_CHANGE_STARS` (§3.7b). With Premium it is **free**: a premium venue is
  always free (the pair has premium), and a base venue is free when the settling
  actor is themselves premium — a free change settles instantly at agreement with
  no invoice and no wish-card fork. A **non-premium** payer settling a base venue
  still pays the flat price AND sees an in-flow **counterfactual** ("with Premium
  this is free ✨", `premiumWouldWaive`) right at the pay step, so the limit is
  felt in the real moment. The "man pays for the woman → surprise reveal"
  gesture (§3.7b) is preserved for non-subscribers.

The blind-decision, no-in-app-chat, 3 km commute, open-at-slot, and fairness
invariants are all unaffected; premium venues still pass every non-price gate.
Telegram-first; iOS in parallel.

### 3.9 Referral Program (feature-flagged)

An optional referral program ("Give a date, get a date"), gated by
`REFERRAL_FEATURE_ENABLED` (default **off**); it pays rewards in Date Tickets
AND complimentary Premium months, so it rides the already-on
`TICKET_FEATURE_ENABLED` + `PREMIUM_FEATURE_ENABLED`. Full spec:
[REFERRAL_PRODUCT_SPEC.md](referral.md).

- **Killer angle.** A ticket is a real date and matching is same-city, so every
  verified friend also grows the local pool that decides whether the referrer
  themselves gets matched — the reward is framed as *"give a date, get a date"*.
- **Trigger = verification.** The referrer is paid only when an invited friend
  reaches `verificationStatus='verified'` — the same anti-fraud gate (liveness +
  `phone @unique`) that admits a user to matching, so the reward condition IS
  the "real, matchable human" condition. The `verified` settlement
  (`grantReferralRewardsForVerifiedInvitee`) is exactly-once across every path
  (pipeline `verified` branch + pull/rerun short-circuit) and covers mobile
  invitees (not gated on `telegramId`).
- **Invitee reward.** A fixed **1 month of Gennety Premium**
  (`REFERRAL_INVITEE_PREMIUM_MONTHS`), granted + active at a wow screen shown as
  the second-to-last screen of the first onboarding Mini App (before the
  AI-memory choice). Safe pre-verification because Premium's only benefit
  (venue-change) requires a scheduled date.
- **Referrer reward.** A milestone ladder (`REFERRAL_LADDER`, default cumulative
  1/1, 2/2, 3/3, 5/5 tickets+months at 1/3/5/10 verified friends), each rung
  idempotent via a unique ledger id. The referral Mini App shows the ladder with
  the dollar value at each rung. A per-referrer 24h velocity guard
  (`REFERRAL_DAILY_REWARD_CAP`) **holds** (never denies) rewards during a
  suspicious burst; held rungs self-heal on the next event.
- **Attribution.** First-touch `User.referralSource = referral:<referrerId>`
  from a `?start=referral_<id>` deep link (Telegram) or `POST /v1/me/referral/claim`
  code (iOS); never overwritten. Self-referral (by id or shared verified phone)
  is blocked.
- **Rewards reuse the wallet/entitlement ledgers** (`ticket_ledger`
  `referral_milestone` + `subscription_ledger` `referral`) with the additive
  `grantComplimentaryPremiumMonths` (extends `premiumUntil` additively without
  clobbering a real recurring anchor). No new tables; the blind-decision,
  no-in-app-chat, and ledger exactly-once invariants are unaffected.
- **Cross-promo entry points (paying screens → referral.html).** The Ticket
  Store, the Date Ticket gate, Premium, and the Venue Change board (twice — the
  pay step and a locked premium venue) each show a quiet, secondary "invite a
  friend instead" affordance — never a button competing with the real
  pay/subscribe CTA — only when the user is genuinely short (empty ticket
  wallet, not subscribed, or paying Stars for a venue swap) and
  only while `REFERRAL_FEATURE_ENABLED` is on (mirrors `starsEnabled`, exposed
  per-screen as `referralEnabled` on the wallet/ticket-gate/premium/
  venue-change state endpoints). Tapping it opens `referral.html`, which
  carries a native Telegram BackButton back to the exact screen the user came
  from (`apps/webapp/src/return-to.ts`) — no dead end, no lost payment context.
  When that screen was itself reached from another (board → Premium → here),
  back keeps walking rather than stopping one hop up; see §3.8 for the trail
  and its bounds.
  **It is a compact chip, and two rules keep it that way (2026-08-08).** It
  shipped as five hand-copied full-width rows of sentence-length text — four
  identical CSS blocks under four class names — and each of the three ways that
  shape failed is now a rule in `apps/webapp/src/referral-hint.ts`, the single
  module all five call sites share. **(a) Never in an action bar.** On Premium
  it sat inside the pinned footer, which is `flex: none`, so it grew that footer
  by ~39px and pushed the subscribe CTA and its price line up the screen — the
  one surface where the hint MOVED the thing the user came to tap. It is now the
  tail of the scroll and the footer holds the CTA and the price alone.
  **(b) One line of copy.** The Premium string ran 59 characters, ~415px at
  13px/600 against ~350px of usable width on a 390px phone — two lines on every
  device, i.e. a paragraph rather than a link. Every string is now ≤31
  characters, one statement rather than a question ("Не хватает билетов?" made
  the reader answer a question before they could skip the line), one wording for
  all five surfaces, and a test holds the bound. **(c) Never full width.** A
  30px auto-width pill on a faint fill, against a 52px hero CTA; on the venue
  board's pay step it also loses half its top gap, because two equal full-width
  rows under each other — the Premium counterfactual and this — read as a list
  of two options rather than as an offer plus its footnote. Telegram-only; the
  native client owns its own paywall.

### 3.10 Promo Codes (feature-flagged, independent campaign links)

An optional **independent promo-code** program, gated by `PROMO_FEATURE_ENABLED`
(default **off**). Distinct from Referral (§3.9): the code belongs to a
*campaign*, not a referrer, so ad bulletins / promo materials can hand a new user
a richer welcome gift. Full spec:
[PROMO_CODES_PRODUCT_SPEC.md](promo-codes.md); it rides the already-on
`TICKET_FEATURE_ENABLED` + `PREMIUM_FEATURE_ENABLED`.

- **Gift.** A **1 free Date Ticket + 3 months of Gennety Premium** (both per-code
  configurable), granted + active at a **richer, visually distinct wow screen**
  (three confirmed-status rows — "Status confirmed · Promo active · Subscription
  activated" — plus the ticket + months) shown as the second-to-last onboarding
  screen (Telegram Mini App) or a native paywall-style screen (iOS). Deliberately
  *more* than the referral welcome screen (which grants only 1 month, no ticket),
  so it renders differently.
- **New users only, first-touch.** Recorded as `User.referralSource =
  promo:<CODE>` on the creating touch (Telegram `?start=promo_<CODE>` /
  `startapp`, or the iOS deferred-attribution claim). Never applies to an
  existing user. **Mutually exclusive with Referral** — a single `referralSource`
  holds one program's value; `parseReferrer` ignores `promo:*` and
  `parsePromoCode` ignores `referral:*`, and the promo wow screen takes
  precedence over the referral one.
- **Grant timing = the wow screen** (like the invitee-Premium), which sits after
  the onboarding contact gate (unique verified phone / verified email), so
  farming the gift needs fresh phone numbers. Codes additionally carry `active`,
  `expiresAt`, and `maxRedemptions`; the grant is exactly-once + cap-safe (an
  atomic guarded `redeemedCount++` alongside a unique `PromoRedemption` row, then
  unique-`externalPaymentId` ticket + Premium grants).
- **iOS attribution.** A custom Apple-native deferred deep link (no external
  SDK): the promo landing (`GET /v1/promo/:code`) stashes a coarse device
  fingerprint + copies `GENNETY:<CODE>` to the clipboard, then bounces to the App
  Store; first launch resolves the code via clipboard and/or a fingerprint match
  (`POST /v1/me/promo/claim-deferred`), and the native wow screen grants via
  `POST /v1/me/promo/claim`. Best-effort by product decision — **no manual-entry
  fallback** (a `PROMO_MANUAL_ENTRY_ENABLED` server seam exists if the miss rate
  proves painful). Telegram's start-param path is fully reliable.
- **Management.** Reusable codes are created/managed out-of-band via
  `scripts/promo-codes.mjs` (`pnpm promo:create|disable|stats|list`). Rewards
  reuse the wallet/entitlement ledgers (`ticket_ledger` `promo`,
  `subscription_ledger` `promo`); the blind-decision, no-in-app-chat, and ledger
  exactly-once invariants are unaffected.

### 3.11 Rematch (feature-flagged, paid on-demand re-run)

An optional **$2.99** (150 ⭐) purchase that re-runs the matching engine for
**one man**, gated by `REMATCH_FEATURE_ENABLED` (default **off**). Telegram-only
in v1. Full spec: [REMATCH_PRODUCT_SPEC.md](rematch.md).

- **The asymmetry is the product.** Only men buy. A woman never buys, never sees
  a price, and never opts in — she becomes the **candidate** of a man's run and
  receives an ordinary pitch prefixed with **gift framing** ("I kept looking, and
  found someone"). One code path monetizes one side and gifts the other.
- **Not a new algorithm.** `findCandidatesFor()` is already a single-seeker
  engine, so a rematch inherits every §3.2 invariant unchanged: the lifetime pair
  ban (so "rematch" always means *someone new*, including after a decline), the
  single-live-match rule, the verification/contact-rail gates, city scoping, and
  the 24 h candidate cooldown. **A paid run never lowers the admission bar and
  never buys a score boost.** The cooldown is deliberately kept: right after the
  Thursday batch the only available candidates are the *unpaired* women, which is
  exactly the cohort the famine gift is meant for.
- **Pain-triggered entry points only** (no menu row): the Thursday no-match DM,
  and any match that died without a date — an explicit decline (his, hers, or
  both; the primary case), the same decision taken from the iOS app, or a 24 h
  TTL expiry. The offer fires only once the match is terminal and the outcome
  reveals have landed, never to a first decider whose match is still live. It
  states before payment that it buys an introduction, not a date.
- **Money rule.** Payment buys a pitch. A decline, a ghost, or a failed
  negotiation is **not** refunded (stated in the offer copy). Two outcomes ARE
  refundable, both automatic, and the line between them and the rest is whether
  a pitch was ever *shown to anybody*:
  - **The engine found nobody** — his city pool is finite and the lifetime pair
    ban permanently consumes one candidate per rematch, so this is expected.
  - **The pitch reached NEITHER side** (added 2026-08-21). The engine found
    someone, the pair was created, and delivery failed for both — she blocked
    the bot, a 403 on the photo album, or her side is `mobile` and has no
    Telegram chat at all (§3.3). He paid for an introduction that was never put
    in front of anyone, so the thing he bought did not happen; that is a
    *stronger* refund claim than an empty pool, not a weaker one. **A pitch that
    reached ONE side is a delivered pitch and is never refunded**, even though
    the dispatch is reported as failed — the product was supplied.
    The refund is not the whole restoration and the copy does not pretend it is:
    `disposeUndeliveredMatch` frees both live-match slots and flipping the
    purchase off `settled` frees his weekly cap, but the §3.2 filter 6 pair ban
    was written at creation, so **the candidate is spent for him even unseen**.
    Un-banning her is deliberately not done — the product deletes no match row
    anywhere — and that permanent cost is the argument for returning the Stars
    rather than only the slot.
  The flow is check → pay → re-check → deliver-or-refund, with a durable hourly
  retry so a failed refund is never announced as successful and never silently
  kept. An outcome the server cannot determine — the dispatch queue itself threw,
  so delivery is *unknown* rather than known-empty — is never refunded: reversing
  a charge for a card the partner may be reading is the one error this rail must
  not make.
- **Limits.** 2 purchases per rolling 7 days with a 24 h cooldown between them
  (the cooldown is what stops decline-and-instantly-retry, preserving the weight
  of a decision); a candidate who already received a rematch pitch within 7 days
  is protected from another; and a blackout window before the weekly batch keeps
  a single-seeker run from taking a candidate the globally-optimal Thursday
  allocation needed. A rematch pairing clears both sides' famine counters exactly
  like the weekly batch.
- `Match.source` (`weekly`/`rematch`) is stamped inside the creating transaction;
  weekly-optimizer analytics filter to `weekly` so on-demand runs never pollute
  the scoring A/B. The blind-decision, no-in-app-chat, single-live-match, and
  ledger exactly-once invariants are unaffected.
- **Two pull entries (2026-08-09).** The offer used to exist ONLY as a DM sent
  at a moment of disappointment, which is why "no menu row" also meant "no way
  to ask": if the DM scrolled away, the feature was gone until the next
  failure. Both new entries land on the **offer card, never the invoice** — the
  price appears one tap later, before any payment, the same rule §3.8 applies
  to the Premium hub — and both are additions, not replacements: the two
  pain-triggered DMs are unchanged.
  - **The pinned status banner**, in silent-drops mode only (§2.1 mode 5). It
    is the one surface where a way in costs nothing: already on screen, already
    saying "still looking", and *edited* rather than sent, so it raises no
    notification. Its button carries **no price** — a pinned message sits above
    every conversation, and a permanent price there is a standing sales pitch.
    Eligibility is resolved once per worker tick (`filterRematchEligible`, a
    batched twin of `checkRematchEligibility` that the tests hold to the same
    verdict), never per user; under `weekly` the whole block is short-circuited
    and costs nothing at all.
  - **The concierge**, via `open_screen: rematch` — so "find me someone else
    now" works by text and by voice. Unlike every other screen in that registry
    it carries a **per-user gate enforced in code**, because the asymmetry it
    protects is the product: a woman must never learn the feature exists, and a
    playbook rule is not a boundary. The refusal string names no feature, since
    the tool result is fed back to the model verbatim.
- **The search is shown, for at least ten seconds (2026-08-20).** This is the
  one place in the product where a user has paid and is waiting *right now*, and
  it was the driest surface we ship: the money moved and a second later a bare
  line said "found someone". The engine run is now covered by a rich
  `<tg-thinking>` shimmer — four beats, one animated AIActions glyph each
  (`rematchSearchSteps`, `services/analysis-status.ts`) — that always plays in
  full and only ever runs longer.
  - **The floor is the requirement, not the implementation.** `runRematch`
    usually answers in a second or two, so the shimmer is passed
    `untilFromStepIndex: NEVER_CUT_SHORT`: `until` may hold the LAST beat
    longer, never truncate the script. Without that flag a fast run collapses
    the ten seconds into half of one beat, which reads as the status having
    broken rather than as work finishing early — the exact failure that flag
    was introduced for (§1.3). Nothing else in the code states the floor, so
    `analysis-status.test.ts` is what holds it.
  - **No beat is a labour illusion.** Real work runs under every line —
    `buildCandidateSql` (city, mutual gender, contact rail, the lifetime pair
    ban, the candidate cooldown) → embedding + vibe-axis scoring → greedy
    top-1. That is the opposite of the Type Radar close
    (`RADAR_THINKING_ENABLED`), which narrates nothing and says so; this
    script's confidence is earned and must not be copied to a surface that has
    not earned it.
  - **It covers `runRematch` and stops there.** The pitch carries its own rich
    compose stream (§3.3), so extending over `dispatchMatches` would put two
    drafts in one chat competing for the same space and let the pitch's own
    arrival collapse ours instead of a clean teardown. The chain reads: search
    shimmer → "found someone" → the pitch's own shimmer → the profile.
  - **A refusal now takes those ten seconds too**, and that is deliberate
    rather than unavoidable-and-tolerated: until the run finishes we do not know
    it IS a refusal, and the same ten seconds honestly show that we looked —
    the argument §3.1 already makes for delivering the famine notice as a rich
    stream instead of an instant line.
  - **The shimmer can never cost a paid match.** It is decoration on a path
    where money has already moved, so it swallows its own failures, and an
    engine throw still leaves the purchase row `processing` for the hourly
    sweep to refund exactly as before.
  - The payoff line carries an optional message effect
    (`MESSAGE_EFFECT_REMATCH_ID`, empty by default). Deliberately NOT on the
    offer card: §3.5b records that a decorative flourish beside a request for
    money reads as marketing rather than as a receipt.
- **The offer leads with a rendered card (2026-08-20).** The DM that proposes
  the purchase was plain text with a button while every other emotional beat —
  the expiry notice, the coordination fork, the date card — already carried a
  PNG. It now ships as one message: the card, the existing localized offer copy
  as its caption, and the same buy button (`services/rematch-card.ts`, satori →
  resvg, recipient's `User.theme`, the same 1080² silhouette and chrome as the
  §3.4 expiry card).
  - **ONE card, not three** (founder decision). The three offer copies stay the
    caption and say what just HAPPENED; the card says what is being OFFERED, so
    nothing is stated twice — the same split §3.4 applies to the expiry card.
  - **The motif is abstract by necessity**: at offer time nobody has been picked
    yet, so there is no partner to depict and no hint that could be dropped
    without inventing one. It is the pool — concentric rings, muted dots, one
    accented and ringed — and its geometry is **authored, never
    `Math.random()`**, by the rule `preference-layout.ts` states.
  - **It carries no price.** A PNG is immutable and Telegram caches it, while
    the price lives in env; a baked-in figure would go stale silently on the one
    screen that asks for money. Price stays in the caption and on the button.
  - **No `protect_content`**, unlike every other card send (§3.7a): there is no
    face on it, and protecting it would only black it out of a screen recording.
  - **Fail-open in four places**, because this DM is the only way the feature is
    reached at all (D4 leaves no menu row): an over-1024 caption skips the card
    without even rendering, a null render, and a rejected `sendPhoto` each fall
    through to exactly the plain text that shipped before — and "sent" keeps
    meaning an offer reached him, not that a picture did.
- **Cadence.** Every D3 limit now resolves as `env ?? CADENCE`
  (`rematchLimits()`): the profile is the source of truth and the env vars are
  ops overrides. Before 2026-08-09 four of the five `DropCadence` rematch fields
  were declared, pinned by a test, and **read by nothing**, while `config.ts`
  baked weekly-tuned literals in as defaults — so the abstraction looked
  complete for Rematch and was not. The `daily` profile allows **7 purchases per
  7 days** (the 24h cooldown is then the real governor, and it already means
  "at most once a day") with a **1h** pre-batch blackout instead of 6h, because
  6h is ~3.5% of a week and **25% of a day**. `weekly` is untouched and
  reproduces today's numbers exactly.
  **`rematchGiftCapMs` is deliberately identical in both profiles**: every other
  knob describes what the BUYER may do, that one protects the woman he is
  buying his way to, and in a thin pool a cap that loosens with his purchase
  rate turns one candidate into everyone's punching bag. This supersedes D8
  ("turn Rematch off for the daily pilot"), which was never adopted — the limits
  move with the cadence instead. `REMATCH_FEATURE_ENABLED` is the sole master
  switch and is **on** in production.

### 3.12 Meme Unlock (feature-flagged, paid pre-date reveal)

**One sentence.** Five hours before the date, the person who is about to meet a
stranger is shown a card offering to reveal the meme that stranger picked as
their answer to "what actually makes you laugh" — 25⭐ (~$0.50), delivered as
the real picture plus one line on how to bring it up.

**Where it sits, and why exactly there.** The card is sent from inside the T-5h
ice-breaker beat in `runDateLifecycleTick`, between the starters stream and the
emergency-window message. That tick is the only moment in the whole product
where somebody is actively thinking about what to say to *this specific person*,
which is the only moment the offer is worth anything — and it is a beat that is
already claimed exactly once (`icebreakersSentAt`), so the card inherits its
idempotency for free instead of needing a marker of its own.

It is deliberately its **own message**, not a button on the last starter. The
ice-breakers are a gift; hanging a price off them would retroactively make the
whole stream read as an upsell. A separate card can also simply not be sent,
which is what happens for the majority of matches — see the gate below.

**What is actually being sold.** The humour question already invites a picture
and already keeps a one-sentence description of it, which is what the
ice-breakers were quietly built from either way (`domains/onboarding.md`). What
is new is that we also keep the Telegram `file_id`, so the product can show the
thing rather than describe it. The purchase is therefore: *the picture*, plus a
generated line on how to play it tonight. The line is what makes it coaching
instead of a $0.50 image, and it is written under one hard instruction — never
tell the buyer to mention they saw it.

**The offer is a teaser, never a preview.** The card names the partner and says
a meme exists. It says nothing about what the meme is, because a description in
the offer IS the product given away — the picture is the smaller half of what
somebody is paying for, the bigger half is knowing the thing at all.

**The gate is "is there anything to sell", checked in one place.**
`partnerMemeForViewer` returns null — and the card is not sent — when the viewer
is not on the match, the partner answered the humour question in words or not at
all, the answer has no pointer because only its caption survived, or this viewer
already owns the reveal. No card is the common case, not an error. A partner who
typed their answer simply produces the ordinary ice-breaker beat with nothing
attached.

**The entitlement is a unique index, not a query.** `@@unique([userId, matchId])`
on `meme_unlock_purchases` is what makes "already unlocked" a database fact, so a
reused invoice link cannot charge twice for the same reveal. A second tap on an
old card **re-delivers** rather than charging again: the entitlement is
permanent, and someone tapping an old card is looking for the meme, not trying to
buy it twice.

**Money either changes something or comes back.** Same invariant, same shape as
Prime Time (§9) and Rematch (§3.11): resolve the participant, write the durable
row keyed by the unique charge id, THEN read the answer and deliver, then commit
`settled` or refund. Four refund reasons exist and all of them are real paths —
the answer disappeared between invoice and charge, Telegram would not deliver,
the settle died mid-flight (hourly sweep), and a second charge against an
entitlement already held. **A refund that fails is parked in `refund_failed` for
the sweep and is never announced to the user as completed** — the DM copy says
"on their way back" precisely when `refundStarPayment` did not succeed.

**The row is written before the answer is read, and the order is load-bearing.**
Reading the meme first looks tidier — it is a pure read, and learning there is
nothing to sell before writing a row saves an insert. It is also wrong: a charge
whose answer vanished between invoice and settle would then be refunded with no
durable record, so a single failed refund call loses the Stars with nothing for
the sweep to retry. Resolving only the PARTICIPANT first is what makes the row
possible (it needs a `subjectUserId`), and a non-participant — which pre-checkout
already refuses, so it means a tampered payload — is the one branch where no row
can exist and a direct refund is the only option.

**A refunded row is DELETED, not flagged.** This is the one place this rail
differs from every other purchase table, and it follows from the row being the
entitlement: leaving a `refunded_*` row behind would permanently block that buyer
from purchasing the reveal again. The consequence for the founder feed is that
reversals show up as a refund notification but not as a row in the purchase read
model — the only `refunded` status `normalizeMemeUnlockRow` will ever see is a
refund that FAILED, which is exactly the row ops needs to find.

**Safety comes free from the capture path.** An image the vision pass refused as
unsafe produces no description, so it falls back to the caption, so it gets no
`file_id` — meaning it can never be revealed to anybody. The only re-sendable
images are the ones a vision pass already looked at and cleared. The reveal is
sent `protect_content` in production through the shared `PROTECT_PARTNER_MEDIA`
constant (§3.7a): this is partner media, chosen by them, shown to one paying
person, and it must not be forwardable out of the chat.

**Demo mode: reveal, no invoice.** The demo bot shows the card and unlocks free
on tap, writing no purchase row. Beyond the obvious (a demo should show the
moment, not the transaction) there is a hard reason: `file_id`s are bot-scoped,
so a pointer minted by @gennetybot is not resolvable by the demo bot, and a pay
button there would take money for a delivery that could never happen.

**Config.** `MEME_UNLOCK_ENABLED` (master switch, **off** by default — the offer
rides a tick that fires for every scheduled date, so a half-configured deploy
would otherwise start charging immediately) and `MEME_UNLOCK_STARS` (default
`25`, which is $0.50 at the documented `STAR_USD_CENTS` ticket rate). As with
Prime Time there is deliberately **no USD display env**: Telegram names the real
sum in its own payment sheet, and a hardcoded "$0.50" label would be wrong at the
premium rate. `MEME_UNLOCK_REFUND_CRON_SCHEDULE` defaults to hourly and the cron
is registered only when the feature is live.
