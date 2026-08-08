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
| Contact rail | real email OTP / phone share | auto-satisfied |
| Departure point | must be inside Kyiv | **same gate**, plus a one-tap "drop the pin in Kyiv" |
| Date Ticket | Telegram Stars | the existing **mock** rail (real screens, real prices, no charge) |
| Venue change | 150⭐ | settled free |
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
| calendar, visitor picked | counter with **different** slots | `processCalendarSlotsUpdate` |
| calendar, no overlap after 90s | give in and take one of theirs | `processCalendarSlotsUpdate` |
| `negotiating_venue`, visitor confirmed | submit vibe + departure point | `interpretVenueIntent` → `confirmVenueIntent` |
| board `liking`, visitor hearted | heart a **different** venue | `submitVenueLikes` |
| board, still no overlap | heart one of theirs → agreement | `submitVenueLikes` |
| board `agreed`, puppet is payer | settle | `settleFreeVenueChange` |
| `scheduled` | hand over the date card, then wait | — |
| `scheduled`, visitor tapped / 7 min | explain the wait, then replay it | `runDateLifecycleTick` + `runCoordinationTick`, ×4 gates |
| terminal | say which ending it was, offer the way back | — |

The two "different first" steps matter: they are what make the negotiation read
like a person with their own calendar and their own taste, rather than a bot
that says yes. The 90-second give-in exists so a demo can never dead-end.

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

At three in a row the demo **stops and says so** (`stuck`, all three languages),
and the action is not retried until the state moves on. Three matters in both
directions: at `DEMO_STEP_WAIT_MS` apart it is a little over half a minute, long
enough to ride out a provider hiccup and short enough that nobody is left
watching a chat that has quietly died. The message is deliberately vague about
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

One demo-only branch is needed here. `openProxies` only opens the chat for a
match whose `coordMethod` is set, and in the product that is a **tap** on the
offer card. A demo cannot depend on a tap landing inside a four-second beat —
the visitor is reading, not racing a timer — so an unanswered offer resolves to
the anonymous chat, which is both the interesting variant and the same default a
pair the Telegram fork cannot reach already gets. Guarded on
`coordMethod: null`, so a visitor who did tap keeps their choice: the demo fills
a silence, it never overrides a decision.

**A same-sex pair cannot show every screen.** The pre-date safety brief is
addressed to the female participant, so a male visitor matched with the male
puppet will correctly never see it — as with the "pay for us both" cover
gesture, the wish card and express venue change, which are hetero-only by
design. Covering those needs a second run from the other side.

### What is held in memory (and why nothing is in the schema)

Four maps in `driver.ts`: which narration beats a visitor has read, when the
currently-owed action was first observed, which visitors are being acted on, and
which finished match a visitor has already been offered a way back from.

**No table was added to `packages/db/prisma/schema.prisma` for demo mode**, and
none should be — the schema is shared with production, and a demo-only table
would ship to the real database on the next `db:push`. The cost is that a
restart mid-demo can repeat one explanatory message. That is the right trade.

Everything that must survive a restart already does, because it is real product
state: the match row, the ticket status, the calendar picks, the lifecycle
idempotency columns.

## The narration

Seven moments where the demo speaks as itself (`demo/script.ts`), each triggered
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
   immediately followed by it happening.
7. **Terminal** — which ending this was, and the way back.

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
  per ending (`redoOffered`, keyed by match id).

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
