<!-- WHEN_TO_READ: You are changing the Living Canvas or viral mechanics: the derived state machine, Date Bump, the Date Terminal (Contact Sync, §6.4a), the transit dock (Uber / maps hand-offs, §6.4b), Date Radar, the canvas screen, Scratch Map, or Campus Radar (Phase 6). -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 7001-7327) — migrated 2026-09-01 -->

## Phase 6 — Living Canvas & Viral Mechanics

The clients stop being a chat with screens attached and become a **dark map of
Kyiv with one sheet on it**. The sheet's contents are decided by the pair's
current `DateLifecycleState`; the map underneath carries the fog of the Scratch
Map, the pulsing venue pins, and — in the last forty-five minutes before a date
— the radar.

Four invariants this phase does not touch: no user-to-user chat, the blind
decision, mandatory verification, and **a person's exact address is never
revealed to their match**. The last one is the reason the radar reports a
masked ETA rather than a position (§6.3).

### 6.1 The state machine is derived, never stored

`DateLifecycleState` is a **pure function** of `MatchStatus` + the clock + the
Date Bump session (`services/date-state.ts`). There is no lifecycle column.

That is the load-bearing decision of the whole phase, and it is the same one
this file already records for `ticketStatus`: a sub-state is legitimate when it
answers a question `Match.status` cannot, and illegitimate when it answers the
same one. A stored lifecycle column would need updating by every writer of
`status` and by two crons, and the first writer to forget produces a canvas
that contradicts the user's own chat — silently, because nothing fails.

Eight states, and the ladder is evaluated from the most specific backwards
(a verified bump sits inside the bump window, which sits inside the radar
window, which sits inside `scheduled` — broadest-first answers with the outer
state every time):

| State | When |
|---|---|
| `IDLE_EXPLORING` | No live match. The map, the campus, the countdown. |
| `DROP_PENDING_DECISION` | `proposed`, and **this side** has not answered. |
| `LOGISTICS_SCHEDULING` | `negotiating` / `negotiating_venue`, or `proposed` where this side HAS answered. |
| `DATE_SCHEDULED` | Time and venue locked, more than 45 min away. |
| `DATE_RADAR_ACTIVE` | Inside `DATE_RADAR_LEAD_MINUTES` (45). |
| `DATE_BUMP_PENDING` | Inside `DATE_BUMP_OPENS_MINUTES` (15) and until T+2h. |
| `DATE_IN_PROGRESS` | Bump verified — the icebreaker deck is open. |
| `POST_DATE_FEEDBACK` | The T+24h prompt has been sent and this side has not answered it. |

**`DATE_SCHEDULED` is an eighth state the original brief did not name, and it
is where a user spends most of the days between agreeing a date and going on
it.** Both ways of reusing an existing name are false: `LOGISTICS_SCHEDULING`
says something is still being agreed when nothing is, and `IDLE_EXPLORING` says
there is no date when there is one. §2.1's pinned banner already separates its
"planning" mode from its "date" mode for exactly this reason, so the eighth
state is the product agreeing with itself rather than an invention.

**The blind-decision invariant is enforced in the derivation, not in the
client.** `deriveDateState` reads only the caller's own `acceptedBy*`, and a
side that has committed resolves to `LOGISTICS_SCHEDULING` whatever the partner
did — the same collapse §2.1 mode 4 makes, and for the same reason: at that
moment the product does not know the outcome and the user is not entitled to
it. A test asserts the three peer states are indistinguishable.

**Two windows deliberately close into `IDLE_EXPLORING` rather than into a limbo
screen.** A date whose evening is over (past T+2h) but whose row still says
`scheduled` — it lingers until the T+24h tick — goes back to the map, which is
the call §2.1 mode 5 already makes for the pinned banner. And a `completed`
match only reads as `POST_DATE_FEEDBACK` once `feedbackPromptedAt` is actually
set: asking on the canvas before the DM asks would pre-empt the §Phase 4
attendance question, which has to come first.

`GET /v1/date/state` serves it. It is its own endpoint rather than a field on
`/v1/matches/current` because it must answer for a user with **no match at
all** — `IDLE_EXPLORING` is the state most users are in most of the time, and
that endpoint answers null there. A screen whose default state its own endpoint
cannot express needs a second call before it may draw anything, which is how
the post-date feedback form ended up undiscoverable on the app rail (§Phase 4).

The response also carries the CALLER's own `Profile.timeZone`: `agreedTime` is
an instant and the canvas draws it on a wall clock, and the device's is wrong
for a traveller. Same field, same reason, as `SerializedMatch.timeZone`.

### 6.2 Date Bump — the pair confirms the meeting with a physical act

Both people shake their phones at the table. The pair **verifies** when the two
shakes land within `BUMP_SHAKE_WINDOW_MS` (10 s) of each other AND both
coordinates are inside `BUMP_VENUE_RADIUS_M` (100 m) of the venue, inside the
window that opens at `DATE_BUMP_OPENS_MINUTES` (15) before `agreedTime` and
closes `DATE_BUMP_GRACE_HOURS` (2) after it. `POST /v1/dates/:matchId/bump`.

**Since 2026-09-29 the gesture can be a HOLD** (`hold: true` in the body) —
the meeting ceremony, where the mascot leaves one phone and lands on the other
at the same moment on both screens. Same checks, same refusals, same
compare-and-set; what changes is only how the answer is timed:

- **The server's clock, not the device's.** Both holds are live requests, so
  the body's `at` is ignored and the stamp is the server's `now`.
- **The first hold waits for the second.** A hold that does not complete the
  pair keeps its request open up to `BUMP_HOLD_WAIT_MS` (= `BUMP_SHAKE_WINDOW_MS`,
  10 s: past that the partner's hold could no longer align with it anyway).
  The wake-up is an in-process event fired by `verifyBump` the moment its
  compare-and-set commits (the bot is one process); a 250 ms poll of the
  `DateBumpSession` row is the fallback; the client closing the connection
  ends the wait. Nothing is held open meanwhile — no transaction, no
  connection. Timed out → the old `verified: false`.
- **One start, two roles.** A verified hold answers
  `ceremony: { startAt, role, serverNow }`. `startAt` = `verifiedAt` +
  `BUMP_CEREMONY_LEAD_MS` (900 ms) on the server's clock — the same instant for
  both phones. `role` is `B` for the side whose shake stamp equals
  `verifiedAt` (its call completed the pair) and `A` for the side that waited;
  the mascot jumps from A to B. Both are derived from existing columns
  (`services/bump-ceremony.ts`), so **the schema did not change**. A same-
  millisecond tie falls back to the match's own sides so the phones never
  agree on one role; a hold never writes to an already verified pair, so a
  retry cannot flip its own role.
- **No replays.** A repeated hold on a verified pair still gets `ceremony`
  until `startAt` + `BUMP_CEREMONY_REPLAY_MS` (4 s) — a long-poll dropped by
  the network and retried — and never after.
- **The deck is not awaited.** The verifying hold answers at once with
  `deck: null`; the deck and the announcement run after the response, and both
  sides read the deck from `/v1/date/state` (below).

**The shake still works, unchanged**, for old iOS builds and a cached Mini App:
without `hold`, the route answers exactly as before, deck awaited. A mixed pair
— one side holding, the other shaking — verifies as before; only the holding
side sees the ceremony, as `A` if the shake completed the pair. There is no
realtime channel: the long-poll covers the one moment in the date where speed
matters. Demo mode is unaffected — the demo can never reach
`DATE_BUMP_PENDING` (`demo-mode.md`), and a hold is refused `too-early` there
exactly like a shake.

**Verification is the only event that does anything**, and everything it does
rides one compare-and-set: `isVerified`, `Profile.reliabilityScore += 50` for
both, `Match.dateAttendedA/B = true`, one bonus Date Ticket each, and the
icebreaker deck. A second shake from either side after that is a no-op — the
CAS claims zero rows and credits nothing, which is what makes the reward
exactly-once when both shakes land in the same millisecond.

**Why this is allowed to write attendance.** §Phase 4 states the rule it looks
like it breaks: *the evidence classifier NEVER writes `dateAttended*`, only a
live human answer does.* A Bump satisfies that rule rather than weakening it.
The classifier reads a proxy chat and guesses; a Bump is two people,
deliberately, at the venue, at the time — a stronger human answer than the one
the T+24h form collects, and earlier. What the rule forbids is a machine
inventing the fact, and nothing here invents anything. The T+24h flow therefore
skips its attendance question for a bumped pair and asks about chemistry
directly.

**A single shake announces nothing.** The peer is not nudged, and the client is
not told the peer has shaken — `/v1/date/state` reports only the caller's own
`bump.mine`. Nudging the second person is the first person's phone telling on
them, at a table where they are sitting together; and a client that could see
the peer's shake could show it, which is the same leak one step later.

**The three refusals are the whole anti-abuse story, deliberately.** There is
no device attestation and no anti-spoofing: a determined user can lie about
their coordinates, and the product's answer is that they would be lying their
way into a free ticket, on a date they are already paying for, at a venue we
chose, inside a fifteen-minute window. The cost of being wrong is one ticket;
the cost of a heavier gate is a real couple at a real table who cannot make it
work.

**The AI Icebreaker Deck is a SECOND deck and does not replace the §Phase 4
one.** That one is sent five hours before the date to someone still deciding
what to wear, and its job is to open a conversation that has not started. This
one is unlocked by the pair actually meeting and is read by two people already
sitting down, so openers are forbidden — it is five things worth talking about,
per side, in each side's own language, generated from both profiles and stored
on `DateBumpSession.icebreakerDeck`. A model failure falls back to a static
five-line deck rather than costing the pair the moment.

**`DROP_PENDING_DECISION` counts the REPLY deadline, not the date.** A time is
agreed only after both sides say yes, so `agreedTime` is null on every
`proposed` match — the one state whose clock is genuinely running is the one
state that field cannot describe. `/v1/date/state` therefore carries
`deadlineAt` alongside it, derived by the same function that feeds
`SerializedMatch.proposalDeadlineAt`, so the canvas and the pitch's own
countdown button can never name different hours for one pitch.

**Both sides read the deck from `/v1/date/state`, not from the bump response.**
Only one of the two shakes completes the pair, so only one call can answer with
a deck — and a hold answers with none at all, because the deck is generated
after its response; the side that shook first would otherwise have the topics as
notification text and nothing else — while the notification is deliberately the
half that says the thing HAPPENED, and the app is the half that draws it. The
state endpoint resolves the caller's own side, so no client is ever handed its
partner's half.

**Reliability is its own column, not Elo.** `Profile.eloScore` is
attractiveness — seeded by the vision pass over photos, moved by accept/decline,
and read by `V_league`, which decides who is a viable candidate at all. Writing
a turned-up-to-the-date reward into it would assert that reliable people are
better-looking and corrupt the one signal the league reads.
`Profile.reliabilityScore` carries the literal meaning instead, and matching
deliberately does not read it yet: it accumulates first, like `socialRole`, so
its weight can be chosen against data rather than guessed.

### 6.3 Date Radar — a masked ETA, never a position

For the `DATE_RADAR_LEAD_MINUTES` (45) before `agreedTime`, each side's phone
pings its own position (`POST /v1/dates/:matchId/proximity`) and is told, about
the other, **one word and at most one wall-clock time**: *on the way, arriving
18:55*, or *here*. Both inside `PROXIMITY_ARRIVED_RADIUS_M` (50 m) produces the
one celebratory beat — "you're both here" — and a haptic pulse.

**The response shape is the privacy guarantee, and it is a closed set.** No
coordinate, no distance, no address, no "500 m away" — those are one
disclosure at four resolutions, and the invariant this phase runs under is that
a person's exact position is never revealed to their match. The masking lives
in one function (`viewOfPeer`), so there is a single place that decides what
crosses between two people, and it cannot leak a coordinate because it is never
handed one.

**Nothing is stored.** There is no schema for any of this. Every other
geographic column in the product is per-purpose and per-match, and the one
thing this feature must never become is a record of where two people were,
minute by minute, on the evening they met. The window is forty-five minutes, so
an in-memory map is the honest lifetime rather than a shortcut: a restart loses
it and the next ping restores it within seconds. The pinged coordinates are
used to compute an ETA and dropped — never written, never logged.

**A phone that goes quiet becomes `unknown`, not a stale ETA.** Past a few
minutes without a ping the last one stops speaking for its sender, because
"eight minutes away" reads as present tense while being a quarter of an hour
old — a worse failure than saying nothing.

**The ETA is arithmetic, not a provider** — a straight line times a city detour
factor over a city speed (walking 1.35 / 4.8 km/h, transit 1.6 / 18 km/h, the
transit detour deliberately the larger because it folds in the wait and the
walk at each end). That is ±5–7 minutes, which is the accuracy a single
rendered line can carry, and it costs no key, no quota and no outage. It rounds
**up**: told 18:55 and arriving 18:56 is a lie, told 18:56 and arriving 18:55 is
not. `RouteEstimator` is the one substitution point if a real routing provider
is ever wanted; nothing else knows how the number was produced.

**The window closes at `agreedTime` itself**, which is where it differs from the
Bump's two-hour grace. A Bump is still meaningful an hour into a date that
started late; "your match is on the way" stops being information the moment the
date has begun, because from then on the two of them can see each other.

### 6.4 The canvas itself — one screen, two clients

The Mini App entry is `canvas.html`: a full-bleed dark map (Leaflet over the
existing `GET /v1/maptiles` proxy, so the phone only ever talks to our origin)
with a single sheet on it, whose contents are `sheetFor(state)` and nothing
else. Every rule about what a state may say lives in that one pure function,
so the DOM decides nothing — which is what makes the invariant below testable
without a browser.

**`DROP_PENDING_DECISION` carries no field about the partner at all.** Not an
empty one — absent, so a later edit cannot fill it in by accident. The server
already enforces the blind decision (`deriveDateState` reads only the caller's
own column, and `/v1/date/state` never selects the peer's), and this is the
client half of the same rule: it is the one screen a user stares at *while*
deciding, so a hint invented here would reopen the invariant on the surface
where it costs most. The test pins the whole view object rather than scanning
for forbidden words — a vocabulary list both false-positives on copy that
legitimately says "tell me yes or no" (addressed to the user) and misses
whatever phrasing a future edit invents.

**Most states hand the user back to the chat, and that is the honest action.**
The flows behind them — accepting a pitch, picking a slot, answering the
feedback form — live in the bot, and the canvas is a map and a status surface
in v1, not a second place to accept a date. The two things it genuinely owns
are the Bump's shake and the Radar's ping — on iOS; since 2026-09-11 the Mini
App canvas hands the shake to the Date Terminal (§6.4a).

**The poll cadence is per state, not flat.** Five seconds inside the radar and
the bump window, where the answer changes without the user and a stale reading
is the failure the feature exists to prevent; a minute everywhere else, where
nothing moves without a cron or a tap. A screen people leave open pays for its
own cadence, and paying radio for `IDLE_EXPLORING` buys nothing.

**A shake is a motion that repeats, not a sample over a threshold** — a phone
put down hard clears any threshold worth having. Three qualifying readings
inside 900 ms, then a cooldown, because one continuous shake produces samples
for as long as the hand moves and each would otherwise post its own bump. The
magnitude is read from `accelerationIncludingGravity` rather than
`acceleration`: the latter is null on a large share of Android browsers, so a
detector built on it works on iOS and silently never fires elsewhere. iOS also
requires a user gesture before motion is delivered at all, so a permission
throw reads as *denied* (ask again from a real tap) rather than *unsupported*
(this phone cannot) — telling a user their phone cannot do something it can is
the worse of the two errors. In the Mini App this detector (`canvas/shake.ts`)
now runs only on the Date Terminal (§6.4a, 2026-09-11), which imports it; the
canvas page itself no longer reads motion.

**Both surfaces read one endpoint.** `/v1/date/state`, `/v1/dates/:id/bump` and
`/v1/dates/:id/proximity` accept a JWT *or* Telegram `initData`
(`public/canvas-auth.ts`). The product's usual shape is a shared service behind
two routes, and that is right where the surfaces genuinely differ — the Mini
App feedback route sends a thank-you DM and the app rail cannot. The canvas is
the opposite case: one screen, two clients, a byte-identical answer. Two routes
would then be two copies of one handler with a rule that they must never
diverge, so the split moves to where the difference actually is — how the
caller proves who they are — and nothing else is duplicated.

**The standby showcase — iOS only, `IDLE_EXPLORING` only (2026-09-11).** While
nothing is scheduled, the native canvas shows the city's curated places instead
of the idle sheet: photo pins on the map and a card carousel under it, swiping a
card flies the map to its pin and tapping a pin scrolls to its card. One call,
`GET /v1/venues/showcase` (either rail, like the rest of the canvas): one entry
per real place — the catalog holds a row per university domain — `museum`,
blocked names and rows outside the city's radius excluded, ordered as a walk so
neighbouring cards are neighbouring pins. **Which places (founder, 2026-09-22):**
the default map is a map of the city — no radius, no query — so it shows the
city's top rather than the 24 best by priority it showed first: a hand-picked
list where the city has one (Kyiv: 62 — the premium catalog, fashionable places,
Milk Bar and Idealist, five parks; `apps/bot/src/services/showcase-curation.ts`),
otherwise the rule — premium first, one card per brand, never the board-only
`alternative` tier or the Georgian / Crimean-Tatar / Uzbek kitchens, plov and
shawarma. At most 64. Those kitchens stay on the venue-change board.
Photos arrive as signed links to `GET /v1/venues/:id/photo`, because an image
loader sends no header. Opening hours travel as raw local periods and the client
derives "open until …" itself: the canvas stays open past the moment any
server-side verdict would flip. It is a showcase, not an offer — nothing on it
books, changes or suggests a venue for a match. An empty list (no city, no
catalog) simply leaves the ordinary idle sheet in place. The Mini App canvas is
unchanged.

**The city guide's venue profile — iOS only (2026-09-15).** Tapping a card (or
the pin already selected) opens the place's profile over the map: a gallery of
at most ten photos (five until 2026-09-22, when the founder raised it; the map
card keeps showing the first five), category, price level and Google rating, opening hours,
the address with a copy action, the vibe highlights, a route drawn on the app's
own map with the transit dock, and Google Maps as a secondary link. Everything
rides in the same showcase list — `photoUrls[]`, `priceLevel`, `rating`,
`userRatingCount`, `mapsUri` — so the profile costs no request of its own, and a
photo is fetched (and billed) only when someone swipes to it. Deliberately not
in it (founder, 2026-09-15): a written description (`editorialSummary` stays
unbought), district, socials/menu/website, popular hours, an average-check
amount, categories beyond the catalog's, and the full catalog instead of the
city's top (24 until 2026-09-22, now the hand-picked list above).

### 6.4a Date Terminal (Contact Sync) — the bot's way into the date day

**`canvas.html` has no way in from the bot, and it still has none of its own.**
Nothing in the chat links to it, so on Telegram the date-day half of this phase
— the radar, the Bump, the table deck — lived on a page nobody was sent to. The
Date Terminal (2026-09-11) is the first entry point: its own Mini App page,
`apps/webapp/date-terminal.html` (Vite entry `date-terminal`, `MiniAppPage`
`"date-terminal"` in `services/mini-app-url.ts`), a React screen built on the
existing `Ticket3D` card, which links on to `canvas.html` ("Map"). **Contact
Sync is only the UI name for the Date Bump gesture** — nothing new on the
server: the page reads `GET /v1/date/state` and posts
`POST /v1/dates/:matchId/bump` over `initData`, like the canvas. The server
accepts a HOLD there since 2026-09-29 (§6.2), and the terminal holds since the
same day (below): the shake is gone from the Mini App.

**Two ways in.**

- **The bot**, at T-45m (`DATE_RADAR_LEAD_MINUTES`) with a reminder at T-15m
  (`DATE_BUMP_OPENS_MINUTES`): one DM per Telegram side carrying a single
  `web_app` button, "🎟 Open the Date Terminal" — `sendDateTerminalBeats`,
  step 2d of `runDateLifecycleTick`. Timing, grace and exactly-once markers are
  in §Phase 4.
- **The canvas.** In `DATE_RADAR_ACTIVE` and `DATE_BUMP_PENDING` the Mini App
  canvas's sheet action is "Open the Date Terminal" — also after this side has
  already bumped, because the two bumps must land within 10 s of each other,
  so going again together is legitimate. The Mini App canvas no longer reads
  motion itself; the iOS native canvas keeps its own gesture (its move to the
  same hold is the iOS half of the meeting-ceremony plan).

**The lock mirrors the server; it does not replace it.** Contact Sync is usable
only while the state is `DATE_BUMP_PENDING` (T-15m … T+2h) AND the phone's own
GPS (`navigator.geolocation.watchPosition`) puts it within 100 m of the venue —
the client's copy of `BUMP_VENUE_RADIUS_M`. The screen shows "Arrival at
{venue}: X m" with an arrival ring, and **nothing about the partner**, the same
rule as a single bump in §6.2. The server still re-checks everything on every
post.

**The gesture is a hold (2026-09-29; a shake until then).** In `ready` the
action bar shows the stand's placement drawing (two phones top edge to top
edge, camera to camera), one line — "Put the phones top edge to top edge and
hold" — and the stand's burgundy capsule. Each person holds it for 0.6 s (it
fills left to right; `impactOccurred("light")` on touch); at the mark the hold
is posted to `POST /v1/dates/:id/bump` with `hold: true` (plus the device `at`,
which a server without holds pairs on, as for a shake). Lifting the finger
before the mark cancels; after it, nothing does — the phase is `waiting`, the
server keeps the request open up to 10 s for the partner's hold, and GPS
jitter at the 100 m edge no longer drops the screen out of it. The waiting
capsule reads "Waiting for your date…" with the stand's running sheen (the
screen's one infinite motion, a loading state); the partner's name is not on
this screen. No motion permission is asked any more; `canvas/shake.ts` is gone.

**The meeting ceremony replaces the tear.** A hold that verifies the pair — this
one, or the partner's while this one waited — answers `ceremony: { startAt,
role, serverNow }`, and both phones play the approved stand
(`design/meet-ceremony` in the iOS repo) at `startAt` on the server's clock:
on A (the side that waited) the mascot gathers out of the capsule, looks up
at the partner's phone, crouches and leaps off, growing and dissolving; on B
it appears out of the air, falls onto the glass, glances up at the other
phone, winks and becomes the mark of the plaque "Meeting confirmed · The next
ticket is on me" (both phones end on it). The terminal dims and defocuses
under the scene.

- **The motion is the stand's, not a re-creation:** `date-terminal/ceremony/`
  holds a verbatim copy of `ceremony.js` and the needed part of `render.js`,
  held to a subset of the iOS parity fixture by a test. A Telegram viewport is
  described to the stand as `{ w, h, mm ≈ 0.16 mm per CSS px, home = bottom
  safe inset }`; the scene's capsule stands where the finger held it (the
  stand's own capsule sits at 74 % of the height on the iOS sheet).
- **Clock:** the offset to the server comes from `serverNow` in
  `/v1/date/state`, NTP-style (shortest round trip of the last 8; two quick
  reads while the capsule fills). A phone that heard late enters mid-scene;
  after the end it shows the final plaque.
- **Haptics** follow the stand's beats for the phone's role: launch →
  `impact soft` then `light` 80 ms later; landing → `impact rigid`; plaque →
  `notification success`. `prefers-reduced-motion` gets the stand's reduced
  branch (the mascot fades in and smiles, no flight).
- **Degrade path.** A server without the long-poll sends no `ceremony`. When
  the terminal learns of the sync from a state read after having seen the date
  unverified, and no scene has played, it plays the scene locally as B from
  "now" — out of step with the other phone, but complete. A read never starts
  it while a hold is still with the server, and it never plays twice.
- **After the scene** the torn ticket (already torn, the tear does not play)
  and the at-the-table icebreaker deck (`match.deck` from `/v1/date/state`,
  §6.2). The shockwave, the `rigid` + `success` climax and the tear as the
  climax are gone. Opened after the sync, the page shows the torn ticket and
  the deck silently, as before.

**Always dark.** The page is dark in both themes, locks orientation and disables
vertical swipes while it is open.

**Not reached in the demo.** The invite and reminder are never sent under
`DEMO_MODE_ENABLED` — the demo replays the lifecycle on a shifted clock while
the terminal reads the real one, the same structural limit as the Bump
(DEMO_MODE.md).

### 6.4b Transit dock — from the map into a car or a route (2026-09-11)

The Mini App canvas carries a transit dock: two glass islands sitting on the
sheet — a control pill (on foot / by car, a wide **Uber**, and both maps apps
as their own tiles) over a status card ("10 min by car" / "You're 2.4 km
away"). The DOM is `canvas/transit-dock.ts`; every rule is pure, in
`canvas/transit.ts` and `src/deep-links.ts`; the partners' tiles are
`src/brand-marks.ts`.

**The row's weights** (2026-09-12). Uber takes the width the row has left and
keeps its wordmark: it is the button that ENDS the question — a car is coming,
nothing further to decide. The two maps apps are a hand-off to another screen
and their tiles are recognised faster than their names are read, so each is one
44 px square with its own mark; the name they lose from the face they keep in
`aria-label` and in the tooltip. The marks are the apps' own logos — Apple's
tile, Google's pin — not redrawings (2026-09-13: a pared-down drawn tile
shipped first and was replaced at the founder's request). The phone's own app is first (`mapsAppsFor`) —
the order still carries the platform guess, so being wrong costs a glance
rather than a detour. The on-foot / by-car chip travels between the two icons
rather than being handed from one to the other; the headline above it swaps on
the same curve, so one tap reads as one gesture.

**When it is there.** Only while the date has a venue *point*: a legacy row
whose column holds the route midpoint gets no dock, because a car sent to a
crossroads a kilometre from the table is worse than no button.

- `DATE_RADAR_ACTIVE`, `DATE_BUMP_PENDING` — up on its own, and a tap on the
  map does not put it away. It steps aside within 100 m of the venue (the
  Date Terminal's geofence), where the next thing to do is shake. The bump
  window is included on purpose: running late is when a car matters most.
- `DATE_SCHEDULED` — on demand. The venue pin brings it up (the pin is a
  button, with a 44 px target, in exactly the states where the dock exists);
  a tap on the map puts it away.
- Every other state — none. The Mini App canvas has one pin, the date's own
  venue (the standby showcase is iOS-only), so "tap any venue" has nothing to
  attach to.

**The numbers are arithmetic on the phone**, for the radar's reasons (§6.3).
Walking mirrors the radar (1.35 detour / 4.8 km/h), so the dock and the radar
line on the same screen never disagree about one walk; driving is 1.4 /
25 km/h plus two fixed minutes. Rounded up, never below a minute; beyond 60 km
the card gives the distance alone. The first mode is the radar's own cut (up
to 2 km walks), guessed once per venue; the user's own pick holds. The
position comes from `watchPosition` only while the dock can show and is
dropped with the watch — no request carries it.

**Both ends of the trip are on the map** (2026-09-12). While the dock holds a
fix, the canvas draws the user's own point — a small white dot, not a second
burgundy pin; the colour on this screen belongs to the venue — and a dotted
line from it to the table. The line is STRAIGHT: it is the same straight line
the minutes are computed from, and drawing a road-accurate route would need a
routing provider, a key, and the position leaving the phone on every recompute
— the trade refused on 2026-09-11 and refused again here. Dotted so it is never
read as a navigator's route. The camera frames both ends ONCE per trip (at the
venue's own zoom a two-kilometre trip puts the user's end off screen, so the
line and the dot would never be seen at all); it is not re-framed on later
readings, which would yank the map out from under someone walking. The line
runs from centre to centre, to the fraction of a pixel (2026-09-13): the pins
are MapLibre markers placed without whole-pixel snapping, their elements never
set a CSS `position` of their own (it drops a marker into normal flow — the
second one then sat 22 px off its point), and the line moves with every
reading, loaded tiles or not. The framing is ONE camera move carrying the
dock's cover as its padding (`canvas/trip-camera.ts`), re-aimed when the dock
changes height until the user pans; `fitBounds` plus a separate padding ease cut
each other short and could leave the user's end off screen. The fix
reaches the map and nothing else — `onFix` hands it to a marker and a canvas on
the same screen, and the guarantee above is unchanged.

**The links are https and carry the destination only.**
`Telegram.WebApp.openLink` throws on any other scheme, so `uber://`, `maps://`
and `bolt://` are unreachable from a Mini App. Uber: `m.uber.com/looking` with
`pickup=my_location` and the venue as `drop[0]`, plus `client_id` from the
build's `VITE_UBER_CLIENT_ID` when set — the attribution an affiliate deal
hangs on. Maps: both are offered — Apple Maps (`maps.apple.com/?daddr=`) and
Google Maps (`/maps/dir/?api=1`), each in the toggle's current mode, the
phone's own app first. No origin in any link: the user's position never leaves the
phone, the guarantee §6.3 already makes. **Bolt is absent**: bolt.eu declares
no iOS app links and publishes no destination link, so its button could only
open a web page (decision journal, 2026-09-11).

**Framing.** While the dock is up, the map camera is padded by what the dock
and the sheet cover, so the venue pin stays in view above them on a small
phone; the padding returns to none when the dock goes down.

**The canvas opens fullscreen** (2026-09-12, `requestFullscreen` on Bot API
8.0+). It was the last Mini App here still opening as a half sheet, and the one
that could least afford it: the map IS the content, and Telegram's chrome plus
the collapsed sheet left it a strip. `expand()` stays for older clients — it
fills the sheet, not the phone. The sheet pads by `--tg-content-bottom`
(`telegram-insets.ts`), because in fullscreen Telegram floats its close × and
menu ⋯ over the page and `env(safe-area-inset-*)` does not report them. The
sheet itself is the dock's own glass rather than the opaque page colour, so the
map keeps showing through the thing describing it.

The iOS native canvas is unchanged.

### 6.5 Scratch Map — the city you have actually been in

A dark veil over Kyiv with a hole punched through it wherever this person has
been. It is the answer to what the canvas is FOR on the six evenings a week
when nobody has a date: a map with nothing on it is a screen you open once.

**Tiles, never coordinates, and that is the design rather than the storage.**
A tile is geohash precision 6 — roughly 1.2 km × 0.61 km — so the column can
say "they have been around Podil" and cannot say which building. Every other
geographic value in the product is per-purpose and per-match and disappears
with the row that held it; this is the first thing that ACCUMULATES, which is
why the guarantee has to be the shape of what is written rather than a rule
somebody remembers at the call site. `packages/shared/src/geohash.ts`
deliberately offers no decode to a point.

**Off by default, behind its own consent.** `User.scratchMapOptIn` is not a
fold into `researchOptIn`: that one governs analytics use of data we already
hold, this one authorises COLLECTING a new class of it, and a consent that
authorises new collection is never inferred from a broader tick — the rule
`biometricConsentAt` already follows. **Switching it off stops collection and
keeps the map**: the tiles are the person's own, and a toggle that silently
deleted months of them would be a worse surprise than one that stops
collecting. Erasure is account deletion.

**Nothing is recorded while you are not looking.** The only two writers are a
ping sent while the canvas is open and a verified Date Bump. There is no
background-location entitlement in the iOS app and no such permission requested
in the Mini App, so that promise is structural rather than a policy.

**The Bump writes here for the same reason it may write attendance.** It is not
a guess about where someone was — two people deliberately shook their phones,
at the venue, at the time — so it records the venue and its tile for both
sides. It rides the bump's success path fire-and-forget: a souvenir must never
cost someone the date their reliability and bonus ticket depend on.

**The percentage is a share of the CITY.** The denominator is a constant of the
market (2915 tiles for Kyiv), not of anyone's data — derived from visited tiles
it would move everyone's number whenever a stranger walked somewhere new, and a
person who explored nothing would watch their own fall. A first tile is 0.034%
and is shown as 0.1% rather than 0.0%: telling someone who just walked their
first square that they have walked nothing reads as a broken feature.

**The fog is translucent.** The city under it stays legible — streets, the
river, where you are. An opaque veil would turn the map into a scratch card
that happens to be a city, and the canvas exists to show the city. And it is
drawn only once tiles have arrived: a fully-fogged map with no data hides
everything, says nothing, and looks exactly like a bug.

### 6.6 Campus Radar — a bonus drop for a campus that just filled up

A university that verifies a dozen students in two days has a pool the product
cannot use until Thursday. The radar watches for that and runs one extra drop,
scoped to that campus.

**It reuses the real allocator.** Same eligibility predicate, same lifetime
pair ban, same scorer, same greedy allocation — the only difference is the id
set it plans over. A second pairing implementation would be a second definition
of what a good match is, and the two would diverge silently.

**Three bounds, each answering a different way it could hurt.** A growth
threshold, so it fires on a campus push rather than on two friends signing up
together. A cooldown, so one campus cannot be dropped repeatedly — read off the
newest `campus` match for that domain rather than a counter, because the row IS
the record of the last drop. And a **pre-batch blackout**, because a
single-cohort run can take a candidate the globally-optimal Thursday batch
needed: exactly the protection Rematch carries, for exactly the same reason.

**Growth needs no baseline.** "Verified inside the window" is the growth, and
it is a timestamp range on rows we already keep. A stored baseline would be a
second fact about the same cohort, wrong from the first missed tick, with
nothing to notice.

**Starvation counters are left alone.** `standbyCount` measures how many
ordinary drops a person was passed over by. A bonus run that incremented it
would punish everyone it failed to pair for having a lively campus; one that
reset it would hand a whole university a priority advantage in the next batch.

Ships off (`CAMPUS_DROP_ENABLED`). It is a second entry point into the
allocator, and production today has no university-domain accounts at all — the
general/phone track carries every one of them — so it would trigger never and
pair nobody until a real campus launch.
