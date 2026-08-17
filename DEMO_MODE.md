# Demo Mode

> Product invariants live in [PRODUCT_SPEC.md](PRODUCT_SPEC.md); architecture in
> [ARCHITECTURE.md](ARCHITECTURE.md); the production runbook in
> [deploy.md](deploy.md). This file owns one thing: the second bot we walk
> investors, friends and colleagues through, and the rules that keep it both
> faithful to the product and unable to touch it.

## What it is

A separate Telegram bot that shows the **entire** Gennety flow — onboarding,
verification, the pitch, the decision, the ticket gate, calendar negotiation,
venue selection, the venue-change board, the pre-date content and the post-date
feedback — from one account, in about fifteen minutes, with no real partner, no
real identity check, no real money and no waiting.

Everything on screen is production code. What the demo changes is only:

| | Production | Demo |
|---|---|---|
| The other person | a real matched user | a fixed synthetic profile |
| Liveness verdict | AWS decides | always passes |
| Photo validation | strict | off — any three images, faces optional |
| Contact rail | real email OTP / phone share | auto-satisfied; any OTP code is printed, never sent |
| Departure point | must be inside Kyiv | **same gate**, plus a one-tap "drop the pin in Kyiv" |
| Date Ticket | Telegram Stars | the existing **mock** rail (real screens, real prices, no charge) |
| Venue change | 150⭐ | settled free |
| Partner photos | forward/save-protected (clients blank them out of screenshots and screen recordings) | unprotected, so a walkthrough can be filmed |
| Waiting | hours to days | ~12 seconds per step |
| Pre-date content | fires at T-5h / T-1.5h / T+24h | replayed immediately |

## The isolation invariant

**Demo traffic must never be able to reach production data, production users or
real money.** Four independent layers, none of which is a code path:

| Layer | Production | Demo |
|---|---|---|
| Telegram bot | `@gennetybot` | its own token |
| Database | Supabase `ophztqjrabwemkqwidkq` | a **separate Supabase project** |
| Process | PM2 `gennety-bot`, `/opt/gennety`, :3101 | PM2 `gennety-demo`, `/opt/gennety-demo`, :3102 |
| Mini App / API | `dating-calendar` → `dating-api` | `demo-app` → `demo-api` |

The last row is forced rather than chosen: Mini App `initData` is HMAC-signed
with the bot token, so only a process holding the demo token can verify a demo
Mini App's calls — and `apps/webapp/src/api.ts` bakes `VITE_API_BASE_URL` at
build time, so the demo needs its own build of the same source.

Deliberately **shared**: the source tree, and the stateless third-party
credentials (OpenAI, Google Places, AWS). Demo spend is real but negligible.

**"Stateless" is the load-bearing word, and two credentials never qualified.**
Twilio and Resend do not compute an answer — they *send something to a
stranger*, on production's account, from the deployment we hand to outsiders.
Email was short-circuited from the start (`services/email.ts` checks
`OTP_LOG_TO_CONSOLE`); the phone rail was not, and `/v1/auth/phone` is mounted
unconditionally, so until 2026-08-08 a code requested against `demo-api` sent a
real SMS billed to production. Both rails now print instead of sending. Any
future outbound-messaging provider owes the same branch **before** it ships.

**`JWT_SECRET` is demo-owned, and the deploy refuses without it.** It was
production's until an audit on 2026-08-08: both deployments signed and accepted
the same `/v1/*` tokens, and `requireAuth` verifies a signature without looking
the user up. The cause is structural rather than careless — the demo `.env` is
production's plus the overrides in `.env.demo`, so **anything `.env.demo` does
not name is inherited**. See the gate below.

**Supabase Storage is NOT in that list** — it holds user media, so the demo
points at its own project with its own `service_role` key and its own private
`…-demo` buckets. Naming only the buckets is not enough, and that is the trap
worth stating: the droplet's env is generated as production's `.env` plus
`.env.demo`, so `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` must appear
there explicitly or they inherit production's — which is what happened on day
one (deploy.md, 2026-08-06). Demo-only bucket names meant nothing could land
beside real objects, but the demo process was carrying a production credential
with full access to real user media for no reason at all.

### `DEMO_MODE_ENABLED` is not self-certifying

The flag disables real safety properties — most importantly it makes
`identityTrustConfigurationErrors` (`apps/bot/src/config.ts`) treat the process
as a non-production runtime, which is what allows liveness to be waved through.

So `assertDemoIsolation()` (`apps/bot/src/demo/config.ts`) runs **first** at
boot and refuses to start a demo-flagged process that still carries
production's own settings: founder notifications on, Telegram Stars on, or an
admin API key present.

**The practical consequence: setting `DEMO_MODE_ENABLED=true` in the production
`.env` does not quietly turn off identity verification for real users — it
stops the process from booting, naming the setting that gave it away.**

Two things no automated check can verify are which bot and which database the
process is talking to. `logDemoBanner()` prints both as the first lines of the
log instead.

### The inheritance gate lives in the deploy script, not in the process

`assertDemoIsolation()` catches settings that are wrong on their face. It
structurally **cannot** catch an inherited production secret: from inside the
demo process, production's values are unknowable, so "is this the same
`JWT_SECRET` production uses?" has no answer there. That is not a gap to fix in
`demo/config.ts` — it is a reason the check has to live somewhere else.

`scripts/deploy-demo.sh` runs it, because the server is the only place both
`.env` files are readable at once. Before anything is synced, it compares
`/opt/gennety/.env` with `/opt/gennety-demo/.env` and refuses to deploy when:

- `BOT_TOKEN`, `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` or
  `JWT_SECRET` is **identical in both**, or missing from the demo file (missing
  means inherited — that is exactly how both known leaks happened);
- `ADMIN_API_KEY`, `FOUNDER_BOT_TOKEN` or `FOUNDER_TELEGRAM_ID` is present at
  all in the demo file.

Adding a new secret to the demo deployment means adding it to that list. The
gate caught the real `JWT_SECRET` violation the day it was written, which is the
only endorsement worth having.

## How it works

### The driver is a worker, not a set of hooks

`apps/bot/src/demo/driver.ts` runs on a short `setInterval`. Every tick it
re-derives the visitor's situation from the database, asks the **pure**
`decideDemoAction` (`demo/decide.ts`) what is owed, and performs it through the
same production service a real partner's client would call.

This is the single decision that keeps demo mode from rotting. There are **no
callbacks wired into the pitch, calendar, venue or ticket handlers** — the same
reasoning as `workers/peer-wait-shimmer.ts`, which re-derives who is waiting
rather than tracking it. A change to a production flow shows up here as a
different snapshot, not as a broken hook.

| State | What the puppet does | Production function reused |
|---|---|---|
| active + verified, no match | explain matchmaking, create the match, dispatch the pitch | `createProposedMatch`, `dispatchMatches` |
| `proposed`, visitor answered (either way) | accept | `applyMatchDecision` |
| ticket gate, visitor paid | top up its wallet, then settle its own half | `grantTickets` → `useTicketFromBalance` |
| calendar, visitor picked | counter with **different** slots, in the evening | `processCalendarSlotsUpdate` |
| calendar, no overlap after 90s | give in and take one of theirs | `processCalendarSlotsUpdate` |
| `negotiating_venue`, visitor confirmed | submit vibe + departure point | `interpretVenueIntent` → `confirmVenueIntent` |
| board `liking`, visitor hearted | heart a **different** venue | `submitVenueLikes` |
| board, still no overlap | heart one of theirs → agreement | `submitVenueLikes` |
| board `agreed`, puppet is payer | settle | `settleFreeVenueChange` |
| board restarted after a settle | heart a **different** venue again | `submitVenueLikes` |
| `scheduled` | hand over the date card, then wait | — |
| `scheduled`, visitor tapped / 7 min | explain the pre-date days, play the T-2h gate | `runDateLifecycleTick` + `runCoordinationTick` |
| `scheduled`, ice-breakers sent, no `coordMethod` | send the coordination fork — all three buttons | `sendCoordCard` (`variant: "offer"`) |
| fork, visitor tapped A or B | explain what the button would have done, hand the choice back | — (nothing is written) |
| fork, visitor tapped C / 5 min | lock in the anonymous chat, play T-45m + T-30m | `runDateLifecycleTick` + `runCoordinationTick` |
| relay open, puppet owes a line | write in the chat (LLM, in character) | `relayProxyMessage` |
| relay open, visitor tapped / 7 min | close the chat, play T+25h | `runDateLifecycleTick` + `runCoordinationTick` |
| terminal | say which ending it was, offer the way back | — |

The two "different first" steps matter: they are what make the negotiation read
like a person with their own calendar and their own taste, rather than a bot
that says yes. The 90-second give-in exists so a demo can never dead-end.

**And the counter lands in the EVENING, one slot per day, at a rotating hour.**
The grid runs 13:00–19:30 Kyiv and arrives date-major and time-ascending, so
taking the first free slot of each day — which is what `pickCounterSlots` did
until 2026-08-17 — proposed **13:00 every single time, on every demo**. A
puppet that only ever offers the middle of a working afternoon does not read as
someone with a job, which is the whole thing this step exists to demonstrate.
It now aims each successive slot at 18:00 / 19:00 / 17:00 — rotated so three
counters read as one person's week rather than one hour repeated, and indexed
rather than randomised, by the rule `preference-layout.ts` already states: a
pattern re-rolled per render can never be reviewed twice. A day whose evening
the visitor has already taken falls back to its own latest free slot, never to
its 13:00 opener.

**The puppet is topped up before it pays, not seeded with a lump.** The §3.5b
gate needs BOTH slots settled before the Calendar is sent, and the demo settles
the puppet's through `useTicketFromBalance` — a real production path, the one a
partner with a ticket in their wallet takes. That path refuses at a zero
balance, which is where every seeded puppet starts, so a visitor who chose
**"pay only mine"** watched the demo stop dead: `insufficient-balance` every
tick, no Calendar, and no second person to chase for the missing half. Paying
for both never hit it, which is why it survived the first walkthroughs.
`ensurePuppetTicket` grants one ticket when the balance is short, on demand
rather than at seed time so it is still right after a process that has been up
for weeks and many demos.

### A refused move is reported, not retried forever

Re-deriving state every tick is what keeps the driver from rotting, and it is
also the one thing that can hide a dead demo: a move that gets refused is
re-derived and re-attempted on the next tick, and the next, indefinitely. That
is not hypothetical — a puppet with an empty ticket wallet logged
`insufficient-balance` **1500 times over several hours** while a visitor sat in
front of a demo that had stopped, and the tick summary said
`acted=1 errors=0` the entire time because a refusal counted as an action.

Every branch of `performAction` now returns `{ok} | {ok:false, reason}` instead
of `void`; nothing swallows a refusal, and a **throw is counted the same way**
(otherwise a reliably-throwing step would never reach the ceiling below).
`failure-tracker.ts` counts consecutive refusals per (visitor, action) — pure,
so it is testable without a database, a bot or a clock, the same split
`decide.ts` already makes.

At three in a row the demo **stops and says so** (`stuck`, all three languages).
Three matters in both directions: at `DEMO_STEP_WAIT_MS` apart it is a little
over half a minute, long enough to ride out a provider hiccup and short enough
that nobody is left watching a chat that has quietly died.

**But giving up is a pause, not a retirement** (corrected 2026-08-08). The first
version held the action abandoned until a different action, a success, or
`/restart`, which turned any *self-healing* refusal into a dead demo — found
live, with a ready visitor, zero matches and `giving up on pitch` in the log.

The ceiling now releases **one probe** after `DEMO_RETRY_AFTER_MS` (2 min). A
failed probe pushes the deadline out and **cannot** re-announce: the driver
announces only on the tick where the streak first equals the ceiling, so the
count keeps climbing rather than resetting. The flood stays shut; the demo stops
being able to die permanently.

That matters more after the redo button's refusals began feeding this same
ladder (the entry below) — more paths can now reach a ceiling that used to be
permanent.

The refusal that exposed it was a *production* bug, and is fixed there rather
than here: a rejection reason wrote `negativeConstraints`, flipped
`embeddingDirty`, and withheld the user from the very next pitch until the
5-minute cron caught up. `appendNegativeConstraint` now refreshes immediately,
like every other embedding-feeding writer. `ensureFreshEmbeddings`
(`partners.ts`, beside `releaseMatchCooldown` and for the same reason) stays as
a guard for the paths that legitimately leave the flag set — a finalize whose
initial embedding failed is meant to stay dirty for the worker to retry, and a
demo cannot wait that out in front of an audience. The message is deliberately vague about
*what* broke — a visitor cannot act on `insufficient-balance` — and points at
`/restart`, which is always available. A demo that admits a fault is
recoverable; one that silently stops in front of an audience is not.

The log follows the same rule: the refusal is written **once per streak**, at
error level, with the action and the reason. A flood of identical warnings is
indistinguishable from noise, which is precisely why the first one went
unnoticed.

**The scheduled date is left alone for minutes, not seconds.** The date card is
the one screen in the demo whose interesting parts are *on it* — the
venue-change board, Open in Maps, the blurred share copy — and the pre-date
replay puts five more messages underneath it. Firing that replay twelve seconds
after the date locked in was not a demo of those affordances, it was a slideshow
past them. The driver now hands the card over with a short note naming what is
worth touching plus a **«Что происходит дальше»** button, and only continues on
the tap or after `DEMO_EXPLORE_WAIT_MS` (7 min), whichever comes first. The
timer is the floor under a visitor who never taps, so the demo cannot stall in
front of an audience; the button is the intended path.

**Every pitch releases the match cooldown on BOTH participants, not just the
puppet.** `createProposedMatch` enforces `lastMatchedAt < now − 24h` on each id
it is handed, including a pair named explicitly — so the first pitch makes the
*visitor* ineligible for a day, and the second pitch of the session (after a
decline, after «continue the demo», or simply to see it again) silently
produces nothing while the driver retries every tick. The cooldown protects a
real candidate from being served up day after day; neither a stage prop nor a
fifteen-minute demo account is that.

Because the allocator returns a bare `null` for a dozen distinct reasons, the
driver names the cause in the log rather than reporting "refused" — in a demo,
a refusal means the chat has stopped in front of whoever is watching.

### Blind decision, preserved

The puppet answers only after the visitor has committed, and always with a yes.
This is the same invariant the product enforces (PRODUCT_SPEC §3.4) — the demo
does not weaken it, it simply has a partner who is reliably keen.

### The pre-date replay needs no new lifecycle code — but it needs BOTH sweeps

`runDateLifecycleTick(api, now)` accepts an injected clock and every step claims
its own idempotency column, so the driver replays it at shifted gates and the
real ice-breakers, emergency window, safety brief, wingman hint and feedback
prompt fire in order.

**`runCoordinationTick` is a SEPARATE sweep and has to be replayed too.** It is
called from `index.ts` on the real clock, so a replay that shifted only the
lifecycle silently skipped the whole hour before the date: the T-60m "how do we
find each other" offer, the T-30m anonymous chat, and all five coordination
cards — with `COORDINATION_FEATURE_ENABLED` on the entire time. The first demo
ever to reach a scheduled date is what surfaced it; `coordOfferSentAt` and
`proxyOpenedAt` were both still null when the run finished. It takes an injected
clock as well, so the fix is to call both at every gate, plus one extra gate at
T-45m so the offer and the chat opening read as two beats instead of arriving
together.

Gates: `agreedTime − 2h`, `− 45m`, `− 30m`, `+ 25h`.

**They are replayed in three stretches, not one run, because two of them are
real decisions.** Running every gate back to back put `+ 25h` four seconds after
`− 30m`, so `closeProxies` shut the anonymous chat before anyone could open it:
the visitor was handed a live "Enter chat" button that was dead by the time they
reached it. The replay now stops at the coordination fork and again at the open
relay, and each stretch resumes on the visitor's own tap or on a floor timer
(`decide.ts` → `decidePredateAction`). The floors are what keep a demo from
stalling in front of an audience; the buttons are the intended path.

### The coordination fork is the demo's own screen

The card the visitor sees at the fork is production's — `sendCoordCard`,
`variant: "offer"`, the partner's photo in the polaroid, `coordOfferIntro` as the
caption, `coordBtnShareSelf` / `coordBtnRequestPartner` / `coordBtnProxy` as the
labels. What is demo-owned is the **sending** of it and its callback data
(`demo:coord:*`), and that is the whole point of the arrangement:

- production sends nothing at all here — `resolveCoordRecipients` needs both
  sides reachable on Telegram and the puppet never is, so `sendOffers` silently
  selects the anonymous chat and asks no question;
- production's keyboard could not show the two contact-exchange buttons anyway:
  it hides them without a public `@username`, and the puppet has none;
- and production's `handleCoordMethod` would refuse the tap, because the visitor
  is not an eligible offer recipient — except for variant A, which would
  **succeed** for a visitor who does have a username, writing
  `coordMethod: "share_self"` and permanently blocking the anonymous chat in
  exchange for a contact reveal that reaches nobody.

So the demo owns all three taps. **A and B are explained rather than performed**
(founder decision — DECISIONS.md): the visitor is told what the button would do
in production, what it costs (A is irreversible, B asks the other person), and
why it cannot run here, and the choice is handed straight back with the
remaining buttons. Nothing is written, so `coordMethod` stays null and the fork
simply stays open — which is what lets someone read both before choosing. **C is
performed**, and its four-field write mirrors `handleCoordMethod`'s own `proxy`
branch, guarded on `coordMethod: null` so the tap and the floor timer cannot both
fire.

Because the method is set before the coordination sweep ever runs, production's
auto-select for an unreachable pair is a no-op (it is guarded on the same
column). Giving the puppet a fake `@username` to make A and B "work" was
rejected: it would put a dead `t.me/` link in front of an investor. The full
three-variant flow with a live partner is tested on `@gennetytestbot` with
`scripts/dev-coord-offer-demo.mjs`.

### The puppet talks in the anonymous chat

The relay is the one place in the product where two people write to each other,
and in demo the other person cannot type: no chat, no push token, nothing that
could answer. A visitor who wrote "I'm here" into silence had been shown a broken
feature, which is worse than not showing it.

`demo/proxy-partner.ts` gives the puppet a voice — one small LLM call per turn
(`MODELS.fast`), prompted as a person on their way to the date, with the real
venue, the real time in the pair's own timezone, and the transcript so far. The
situation advances by turn count rather than by the clock, because the demo
compresses the whole 30-minute window into a couple of minutes: **it writes
first** ("ten minutes out, where are you?" — which is what makes the visitor open
the chat at all), then arrives, then settles into finding each other. It never
starts a conversation about the date itself; the product deliberately has no such
feature and a puppet that demoed one would be lying.

Three bounds make it safe: prompt building is pure and unit-tested; every
generation is validated (one line, ≤220 chars, no links, no broken character) and
falls back to a scripted ladder, so the chat works with no `OPENAI_API_KEY` at
all; and the puppet answers at most `DEMO_PROXY_MAX_PARTNER_MESSAGES` (8) times,
so a stuck relay cannot become an open-ended bill.

Delivery goes through the production `relayProxyMessage`, not a hand-written row
plus DM, so the message is logged to `proxy_messages` and reaches the visitor by
exactly the path, prefix and controls keyboard a real partner's would. It is
called with an **injected clock** (`agreedTime − 15m`): that module derives the
window from `agreedTime` on purpose, and the demo's date sits days in the real
future, so without the shift the production path would honestly answer `closed`.
Same idiom as the lifecycle replay.

**A second venue change needs no puppet branch, and the cap is what stops it
being a loop.** `decideVenueChangeAction` keys purely on `venueChangeStatus`,
and the driver checks the board BEFORE the pre-date replay, so a visitor who
restarts a settled board is answered generically — the puppet counters, agrees
and settles again. That is exactly why `VENUE_CHANGE_MAX_PER_DATE` is a counter
on the row rather than a count of purchases (PRODUCT_SPEC §3.7b): demo settles
every change **free**, so nothing else here bounds it, and without the cap a
visitor could keep the demo on the board and never reach the pre-date content
at all.

**A same-sex pair cannot show every screen.** The pre-date safety brief is
addressed to the female participant, so a male visitor matched with the male
puppet will correctly never see it — as with the "pay for us both" cover
gesture, the wish card and express venue change, which are hetero-only by
design. Covering those needs a second run from the other side.

### What is held in memory (and why nothing is in the schema)

Five maps in `driver.ts`: which narration beats a visitor has read, when the
currently-owed action was first observed, which visitors are being acted on,
which finished match a visitor has already been offered a way back from, and
which of the two impossible coordination variants have already been explained.

That last one is the only piece here that genuinely *cannot* be derived: tapping
"share my Telegram" or "ask for theirs" writes nothing to the match — that is
what keeps the fork open — so the product carries no trace of it. It only thins
the re-offer keyboard, so losing it on restart shows a button that has already
been read.

**No table was added to `packages/db/prisma/schema.prisma` for demo mode**, and
none should be — the schema is shared with production, and a demo-only table
would ship to the real database on the next `db:push`. The cost is that a
restart mid-demo can repeat one explanatory message. That is the right trade.

**But "one explanatory message" is a claim each beat has to earn, and one of
them did not.** The rest of the product state that matters — the match row, the
ticket status, the calendar picks, the lifecycle idempotency columns — survives a
restart because it is real product state. A forgotten in-memory guard is
therefore harmless only when the *state it guards against* also moves on. Every
narration beat is saved that way: its window closes by itself as the visitor
progresses (`decideNarration` spells this out for `intro`, the one beat whose
window needed an explicit upper bound).

`redoOffered` was the exception, and it repeated far more than once. A terminal
match is terminal **forever**, so nothing ever closed its window: the closing
message went out again ~12 s after every single restart of `gennety-demo`,
indefinitely, until the visitor tapped the button or ran `/restart`. Measured in
the demo's own `chat_events` — one genuine finale 17 s after the match completed,
then an identical one 27 s after a restart four hours later, same visitor, same
match. The ending now also has to be **fresh**
(`DEMO_ENDING_OFFER_MAX_AGE_MS`, 10 min) for the demo to speak to it, which is
the clock-based equivalent of the state-based bound every other beat gets for
free.

The rule this leaves behind: **before relying on a map here, ask what closes the
window when the map is gone.** If the answer is "nothing", the beat needs its own
bound — not a schema column.

## The narration

The moments where the demo speaks as itself (`demo/script.ts`), each triggered
by a state the product itself owns:

1. **`/start`** — what the demo is; and that the bot is a conversational agent
   you can talk to by text or voice at any point, which is the capability most
   easily missed because it has no button.
2. **The bot has asked for photos** — in the real product they are validated and
   later matched against your face; here they are not, so upload anything.
3. **Onboarding done, liveness pending** — the check is real on screen and
   always passes.
4. **Verified** — how matching actually works, then the first profile with an
   invitation to reply in plain text.
5. **`scheduled`** — the date card is yours; here is what on it is live, tap when
   you're done looking.
6. **The tap, or 7 minutes** — what normally happens over the following days,
   immediately followed by the first of it happening.
7. **The coordination fork** — the question the product asks an hour out, above
   the real card. Deliberately does NOT say which of the three are impossible
   here: pressing one and being told what it does IS the demo of this screen.
8. **A or B pressed** — what that button would have done in production, what it
   costs, and why it cannot run against a puppet with no Telegram account.
9. **The relay is open** — what the anonymous chat is, that it is the only
   channel between two users in the whole product, and an invitation to write
   into it (the puppet answers).
10. **The tap, or 7 minutes** — the day-after question, then it arriving.
11. **Terminal** — which ending this was, and the way back.

Languages: `ru`, `uk`, `en` are written out; `de` and `pl` fall back to `en`.
A deliberate scope call for long explanatory prose; adding the two blocks is the
only change needed if a demo in those languages is ever required.

**Message 2 waits for the question, not for the collector.** The Type Radar gate
intercepts the photos question *before* it is asked, so `currentQuestion` reaches
`photos` while the chat is still showing the radar invite. Firing there put the
note under that invite — minutes above the photo request, and directly in front
of a Mini App the visitor was about to spend several minutes inside; the first
person walked through the demo reported it as never sent. The trigger is the
session's `expectingPhoto`, which flips only once the resume has actually asked
for photos. Deliberately NOT `Profile.typeRadarCompletedAt`, the obvious
alternative: that lands *before* the ~13s radar thinking sequence, so the note
would drop into the middle of it and collapse the rich draft. `expectingPhoto`
is also set identically whether the radar was submitted, skipped, disabled, or
never shown for want of a deployed deck at that age band — so the demo needs no
idea whether a radar step exists at all.

**Message 4 says "regularly", not a number.** Production runs `DROP_CADENCE=weekly`
— one Thursday drop — with a `daily` profile in code but inert (PRODUCT_SPEC
§3.1). Copy here must not describe a cadence production does not run.

## Recovery

- **A pass is shown honestly.** The real decline card, the real reason prompt,
  the real "this pair will never be shown again" consequence — then the demo
  offers a button that deletes its own match history and re-pitches. The
  lifetime pair ban (§3.2 filter 6) is not bypassed in the allocator; the demo
  removes its own rows instead.

  **The button is the only thing that starts a second run.** It used to be
  decorative: the offer deleted the finished rows to make itself one-shot, which
  also erased the only evidence that this visitor had ever matched — so the next
  tick read the empty state as "the demo has not started" and pitched a fresh
  profile twelve seconds later whether or not anyone pressed anything. The rows
  now stay, `hasEverMatched` keeps the driver quiet, and the offer is made once
  per ending (`redoOffered`, keyed by match id) **and only while that ending is
  still fresh** — the map is wiped by every restart, so on its own it made the
  offer once per *process* rather than once per ending (see "What is held in
  memory" above).

  **The button keeps working across restarts, which is why suppressing the
  repeat costs nothing.** Its handler resolves the visitor from the database and
  nothing else, so a visitor who scrolls back to the original message can still
  start a second run days later — the freshness bound withholds a duplicate
  *message*, never the way back.

  **The tap answers, and it keeps its button until a profile actually
  arrives.** It used to retire the keyboard first — double-tap protection — and
  then discard whatever `startDemoMatch` returned, so a refused pitch left the
  visitor with no button, no message, and nothing but `/restart`. That is not a
  hypothetical: the allocator refused because the decline reason the visitor had
  *just given* marked their embedding dirty (PRODUCT_SPEC → Embedding freshness,
  fixed at the write), and the chat then sat unchanged for 44 seconds until the
  driver's own three attempts exhausted themselves. Now the keyboard is retired
  only on success, `restartDemoPitch` shares the driver's single-flight guard
  instead (so a double tap — or a tick landing on the same visitor — cannot run
  two pitches), a refusal says so immediately, and it **counts into the same
  failure ladder** as the driver's attempts rather than being invisible to it.
  A success clears the streak, so a give-up can never outlive its cause.

  **A second run does not re-explain the product.** The "you're in the system,
  here is how matchmaking actually works" message is delivered once, immediately
  above the first pitch. `spokenBeats` is in memory (no demo-only schema, below),
  so a deploy mid-demo forgets what a visitor has read — and the demo is
  redeployed with every release, which is how a visitor came back from a pass and
  was handed the whole explanation a second time. The deleted match rows are
  durable proof it was already said: `clearDemoMatches` returns its delete count
  and a non-zero one marks the beat spoken. The beats that describe a *match*
  rather than the product — the date-card handover, the pre-date replay — are
  deliberately forgotten instead, so the second run gets its own.

  **A finished demo is not a decline.** The post-date feedback flips `scheduled`
  to `completed`, which is terminal exactly like a pass — so for the first day of
  demo mode a visitor who had just been walked from pitch to post-date feedback
  was told "a pass is final, this pair will never be shown again". The two
  endings now carry their own copy, chosen from the terminal status.

  **The puppet has to answer a "no" for any of that to happen.** A first
  decider leaves the row `proposed` whichever way they went (§3.4) — it goes
  terminal only when the second side answers or the 24h TTL fires. So the
  puppet accepts after a decline too, which both frees the recovery path and
  makes the mixed-outcome reveal real: the visitor is told their match had said
  yes, which is what the product actually does.
- **`/restart`** wipes the account through the real `deleteUserAccount`, not a
  bespoke reset — that function is the only code that knows every table,
  storage object and founder-report snapshot a user touches.

  **It must also reset `ctx.session`, and for a while it did not.** The chat
  session is keyed by Telegram chat id and has no relation to `users`, so it
  survives the deletion; `deleteUserAccount` now erases the row, but grammY
  holds this chat's session in memory for the rest of the update and writes it
  back when the handler returns — so without the in-place reset the delete is
  immediately undone. The Telegram Settings → Delete path has always done this;
  `/restart` is the same deletion and owes the same reset.

  What it cost while missing is worth keeping, because it is the shape of every
  future version of this bug: a brand-new visitor inherited the previous one's
  `expectingPhoto: true`, which put them in the photo stage while the collector
  was still asking profile questions. Three uploads then produced a Continue
  button that finalized onboarding early, the guard refused, and the demo
  dead-ended at the one step a visitor cannot skip. **A demo that deletes an
  account must leave nothing of it in the chat** — the point of `/restart` is
  that the next `/start` is a genuinely new person.

Both are registered ahead of every other handler so they work from any state,
and both are mounted only when `DEMO_MODE_ENABLED`.

## The guarded branches in production code

Eight, each a single `if`, each commented at the site:

| File | What it does |
|---|---|
| `services/liveness-flow.ts` | skips the AWS verdict; runs the pipeline with stubbed evidence |
| `services/verification-pipeline.ts` | a generic `depsOverride` seam (the only caller is demo) |
| `handlers/matching/venue-change.ts` | `changeIsFree` → true |
| `public/routes/telegram-onboarding.ts` | `/track` satisfies the phone rail; `/email/verify` accepts any code |
| `handlers/router.ts` | mounts the demo composer |
| `handlers/onboarding/conversational.ts` | skips the legacy single-face gate on upload |
| `handlers/menu/edit-profile.ts` | the same, in the photo manager |
| `services/venue-intent-v2.ts` | adds `demoMode: true` to the venue-intent state |

**Why the last two exist — `PROFILE_MEDIA_VALIDATION_ENABLED=false` does not
mean "nothing is checked".** It selects the *pre-rollout* validator instead of
the current one: a `validateSingleFace` call that rejects scenery as `no_face`,
plus (in the photo manager) a `gateProfilePhoto` identity check. So a demo
visitor who was just told to upload any three images they have to hand had
their landscape photos refused with "your face must be visible" — and the
refusal left **no `media_validation_rejections` row**, because only the new
validator writes those, which is what made it look like nothing had been
rejected at all. The env var alone could never have delivered the promise in
the table at the top of this file; these two branches are what do.

Plus two `if (DEMO_MODE_ENABLED)` blocks in `index.ts`: the isolation assert +
banner + driver, and **not** scheduling the drop-matching or no-match crons.

**And one deliberate non-branch: `PROTECT_PARTNER_MEDIA`.** Partner photos are
sent `protect_content` wherever they appear with a clear face (PRODUCT_SPEC
§3.7a), and Telegram clients blank protected media out of a screenshot or a
screen recording — so a demo filmed for an investor records a black rectangle
exactly where the partner should be. The flag is therefore off in demo, which
costs nothing: the partner there is a seeded puppet, not a person with a photo
to protect.

It is a **single exported constant** (`demo/config.ts`) read by all six
senders — the pitch album (`handlers/matching/pitch.ts`), the match cards
(`services/match-card/send.ts`), the scheduled date card
(`services/scheduled-confirmation.ts`), the My Date hub
(`handlers/menu/my-date.ts`), the venue wish card
(`handlers/matching/venue-change.ts`) and the coordination cards
(`services/coordination-card/send.ts`) — rather than six `if` blocks. Six
copies of one rule is a rule a seventh sender never finds, and the failure is
silent: a hardcoded `protect_content: true` on a new surface simply goes black
on camera, with nothing failing and nobody told. The blurred date-card share
copy is deliberately NOT routed through it — that one is unprotected in both
modes, because the blur is what makes it safe to leave the platform.

**The drop cron is disabled in code, not by an env schedule.** Every demo
visitor is an active, verified Kyiv account, so the real engine would cheerfully
pair two investors with each other. "The demo must never pair two visitors" is
an invariant, not a setting.

### Known deviation: the venue-change price screen

The Date Ticket gate uses the shipped **mock** payment rail, so a demo visitor
sees the real screens, the real prices and a working pay button. The venue
change has no such rail — it is Stars-only — so demo settles it for free at
agreement, reusing the Premium waiver path (which the Mini App already
understands via its `settled: true` response). **A demo therefore shows the
whole likes board but never the venue-change payment screen.** Closing that gap
means building a mock rail for Stars; it is not worth it for one screen.

## Setup

One-time:

1. Create the demo bot in BotFather; `/setdomain demo-app.gennety.com` (required
   for camera permission inside the Telegram WebView).
2. Create the second Supabase project; three `…-demo` storage buckets.
3. DNS: `demo-app` and `demo-api` A records → the droplet. Two Caddy blocks.
4. `/opt/gennety-demo/.env` (below), then `pnpm --filter @gennety/db db:push`.
5. Seed the Kyiv venue catalog: `pnpm seed-venues:import --apply` against the
   demo `DATABASE_URL`.
6. `pnpm demo:seed -- --photos=<dir>` — see `scripts/seed-demo-partners.mjs`.
7. `pm2 start … --name gennety-demo` in `/opt/gennety-demo`.

Env that differs from production:

```
DEMO_MODE_ENABLED=true
BOT_TOKEN=<demo bot>              DATABASE_URL=<demo supabase>
PUBLIC_PORT=3102                  ADMIN_API_KEY=
WEBAPP_URL=https://demo-app.gennety.com
PUBLIC_BASE_URL=https://demo-api.gennety.com
OTP_LOG_TO_CONSOLE=true                  # no mail is sent to typed addresses
PROFILE_MEDIA_VALIDATION_ENABLED=false   # any three photos
FOUNDER_NOTIFY_ENABLED=false             # enforced by assertDemoIsolation
TICKET_FEATURE_ENABLED=true  TICKET_STARS_ENABLED=false  TICKET_PAYMENT_MODE=mock
VENUE_CHANGE_FEATURE_ENABLED=true   PREMIUM_FEATURE_ENABLED=true
PHONE_AUTH_ENABLED=true
SUPABASE_SELFIE_BUCKET=selfies-demo
SUPABASE_PHOTO_BUCKET=profile-photos-demo
SUPABASE_CHAT_BUCKET=chat-attachments-demo
DEMO_PEER_DELAY_MS=12000   DEMO_TICK_MS=3000
```

`DEMO_TICK_MS=0` disables the puppet entirely — useful for walking onboarding
alone without a match arriving.

## Not to be confused with: synthetic test profiles

PRODUCT_SPEC §3.1c adds a second kind of seeded person — a **synthetic test
profile**, offered to a real friends-and-family tester in PRODUCTION when the
real pool leaves them unpaired. The two look alike from a distance (both are
`platform: "mobile"` rows with a negative `telegramId` and a bio written by
hand) and are opposites in every way that matters:

| | Demo puppet | Synthetic test profile |
|---|---|---|
| Where | demo database only | production |
| Who sees it | the demo visitor, always | a real tester, only when nobody real is left |
| What it does | accepts, then walks the whole flow | declines, every time |
| Driven by | `demo/driver.ts`, re-deriving state each tick | `workers/synthetic-partner.ts`, one decision |
| Reserved ids | `-777_000_00x` | `-778_000_00x` |

**Demo mode is unaffected by the synthetic fill and needs no branch for it.**
The drop cron is not scheduled at all under `DEMO_MODE_ENABLED` (that is the
invariant keeping two visitors from being paired with each other), so
`runDropBatch`'s second pass never runs here; and the demo database has no rows
carrying `syntheticAt`. `demo/decide.ts` is untouched.

The id bands are deliberately distinct so a row is identifiable at a glance,
and because the demo seeder's `resolveUploadChat` looks for a **positive**
`telegramId` to find a real visitor — a rule that would quietly break if the
two kinds of stand-in ever shared a range and one leaked across.

## Deploying

`./scripts/deploy-demo.sh` (or `pnpm demo:deploy`), **after** the production
deploy is verified. It syncs the same working tree to `/opt/gennety-demo`,
installs, builds, pushes the schema to the demo database with a drift check,
restarts `gennety-demo`, and builds + ships a second Mini App bundle pointed at
`demo-api`.

That last step is what makes "the demo updates with production" true: one extra
command per release, same source, no parallel implementation. See deploy.md.

## The rule for future work

**Any change to a product flow, a Mini App screen, a gate, or a paid step must
state how it behaves in demo mode.** Most changes need nothing — the driver
re-derives state and the demo picks them up for free. The ones that do need
attention are:

- a new **gate** (something the user must pass) → does demo wave it through?
- a new **paid step** → demo cannot charge; what happens instead?
- a new **negotiation step** with two sides → the puppet needs a branch in
  `decide.ts`, or the demo dead-ends there;
- a change to how a **match is created or advanced** → check the driver's state
  table above still matches reality.

If the answer is not obvious from the change itself, **ask** rather than assume.
The same rule AGENTS.md already applies to the iOS client under "Two Clients,
One Backend".
