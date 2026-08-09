# DECISIONS.md — decision and deviation journal

> Living document (AGENTS.md protocol). This file holds what exists **nowhere
> else**: a decision voiced in conversation, a change of mind mid-task, a
> deviation from the plan, or a piece of scope deliberately not done.
>
> **Why it exists.** A new session reads files, not the conversation. Anything
> agreed in chat and never written down disappears with the context window — and
> the next session will faithfully rebuild the thing we decided against.
>
> Client-side decisions live in the iOS repo's `DECISIONS.md`
> (`~/Desktop/Gennety-iOS`). Both files load automatically via their `CLAUDE.md`.

## Write here when (mandatory)

1. **The founder makes a product decision in conversation** — including "no, we
   are not doing that", and including cases where no code changed.
2. **I change my own mind mid-task** — the implementation departs from what I
   wrote in the plan or in a previous block.
3. **A deviation from the plan** — different scope, different approach, or a
   different order than planned.
4. **Deliberately not done** — scope deferred or dropped, with the reason.
5. **A document turned out to be wrong** — PRODUCT_SPEC / ARCHITECTURE / deploy.md
   describes something the code does not do (or vice versa). Record it here and
   fix the document.

## Do NOT write here

- Ordinary implementation that followed the plan — the commit and the spec
  section already carry it.
- Details obvious from the code. The decision, yes; the mechanics, no.
- Bugs found and fixed: those belong in PRODUCT_SPEC/ARCHITECTURE next to the
  behaviour they changed, or in the deploy.md block for that release.

## Entry format

Newest entries go **on top**:

```
## YYYY-MM-DD — short title
**Kind:** founder decision | change of mind | deviation from plan | not done
**What:** one or two sentences.
**Why:** the reason, not a restatement of the decision.
**What it changes going forward:** what is now off-limits or required.
**Recorded in:** file/section, if the decision already landed in code or docs.
```

---

## 2026-08-09 — a provider 400 was being served as an empty success, and no test built the payload

**Kind:** deviation from plan
**What:** the departure-point search in the Location Mini App returned nothing
for every user in a launched market, for four days. `/v1/location/search` sent
Places `locationRestriction: { circle }`, which `searchText` does not accept —
it takes a circle only for `locationBias`. Fixed by sending the market as a
rectangle and letting the existing per-result `checkDepartureOrigin` pass cut
the corners back to the circle.
**Why it is worth an entry rather than a commit message:** the mechanical bug is
one word; the two things that let it live are general.
- **A caught provider error was returned as a successful empty result.** The
  catch answers `200 {ok:true, results:[]}`, which is right for "Places found
  nothing" and wrong for "Places refused our request" — on screen they are the
  same blank dropdown. The one `console.warn` it does emit had **zero**
  occurrences in either log, which I first read as evidence the path was fine;
  it was evidence the path had never been executed, because production has had
  0 dates ever and nobody had reached the venue step. A failure that has never
  run looks exactly like a failure that does not exist.
- **The payload itself was untested.** All four existing `/search` tests exit
  before the request is built (401, short query, long query, no-API-key stub),
  so nothing in the suite had ever looked at what we send Google. The guard
  test added here was confirmed to FAIL against the old code before being
  confirmed green against the new.
**What it changes going forward:** when a call site translates a provider error
into a valid-looking empty result, the log line is the only signal, so treat an
*absent* log line as unknown rather than as healthy — check whether the path
has ever run. And a request body assembled for a third-party API needs a test
that asserts the body; mocking the transport and asserting only the response
leaves the exact shape that broke here uncovered. Two related notes:
`searchNearby` in `services/venue.ts` genuinely requires a circle and is
untouched — the two endpoints disagree, so neither is the model for the other.
And `checkDepartureOrigin` over the results is now load-bearing rather than
defensive: the rectangle over-includes at the corners by construction, and that
filter is what keeps search and the circular write gate from disagreeing.
**Recorded in:** PRODUCT_SPEC.md §3.7 → "Search cannot offer one either";
`apps/bot/src/public/routes/location.ts` (`marketBoundingBox`).

---

## 2026-08-08 — the calendar's time list opens at the evening, not the afternoon

**Kind:** founder decision
**What:** tapping a date in the Calendar Mini App now opens the slot sheet
scrolled to the LAST slot (19:30) instead of the first (13:00).
**Why:** the founder's reasoning, and it is worth recording because it is two
arguments rather than one. The obvious half is frequency — a first date is
planned for the evening far more often than for mid-afternoon, so the common
answer should need no scroll. The half that is easy to lose is the
*affordance*: opening at 13:00 puts a full row flush against the top edge,
which reads as the list simply starting there, and nothing else on that screen
says it scrolls; opening at the bottom leaves a row cut in half at the top
edge, which is the only thing telling the user an earlier time exists at all.
**What it changes going forward:** `openSheet()` is the single owner of the
opening scroll position — every path that makes the sheet visible funnels
through it. A poll-driven rebuild deliberately **preserves** the user's scroll
instead of re-anchoring, so do not "fix" that into consistency: the rule is
about where a fresh open lands, not about overriding where someone scrolled
to. If the slot grid ever gains a morning band, re-open this decision — the
argument is about the evening being the likely answer, not about the bottom of
a list being a good default in general.
**Recorded in:** PRODUCT_SPEC.md §3.6 → "The time list opens at the LATEST
slot"; `apps/webapp/src/main.ts` (`anchorSheetToLatest`).

---

## 2026-08-08 — a translucent button is not a scrim, and the fade was on the wrong side of it

**Kind:** deviation from plan
**What:** reported as "the Close button overlaps some other button" on the ticket
gate's waiting screen. There is no second button — the countdown line was being
read *through* Close. The floating action bar (shipped hours earlier) ran one
gradient across its whole box, solid at the bottom and fading over the top 72px,
while the buttons start 16px below that top; so the first button sat almost
entirely in the transparent end of its own scrim. `.btn-secondary` is `--fill`,
**6% white**. The bar's background is now plain `--bg` and the ramp is a
`::before` above it.
**Why it is worth an entry rather than a CSS tweak:** the bug is invisible on
every screen whose bottom content is a picture, and it is a *property of the
pattern*, not of this screen — anything that ever scrolls under the first button
is legible through it. The doc-comment claiming "the gradient only keeps the text
they sit over from showing through them" described an intent the geometry never
delivered.
**What it changes going forward:** the ramp must stay OUT of the bar's box.
`--bar-space` is `offsetHeight`, so folding the fade into padding would reserve
72px of dead strip at the end of every short list — which is the exact failure
`action-bar.ts` exists to prevent. Do not "simplify" the `::before` back into the
bar's own background. `.vc-bar` (venue board) is untouched and still uses a
percentage; the two are deliberately different and neither is the model for the
other.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The action bar floats";
`apps/webapp/src/ticket/ticket.css`.

## 2026-08-08 — the gate's countdown named nobody, in half-English units

**Kind:** deviation from plan
**What:** «Осталось 23h 59m». Two independent defects in one line, both found
from the founder asking what the timer was *for* and *for whom*. The English
string has always been "They have {time} left"; the four translations had been
cut to a bare "Осталось {time}" in the course of a 2026-07 change making them
gender-neutral — the subject was removed rather than de-gendered. And
`formatCountdown` baked `h`/`m` into the formatter, so every non-English locale
rendered English unit letters in the middle of its own sentence. Units are now
`{n}`-templates per locale; the line names the partner with the same role noun
`waitingSub` already uses.
**Why it survived:** the line reads fine in English, which is the locale anyone
reviewing the code reads. Nothing in the product renders a number inside a
translated sentence anywhere else, so there was no precedent to copy and no test
that could have caught it.
**What it changes going forward:** a `{time}` / `{n}` placeholder inside a
translated string needs its UNITS translated too, not just the frame. Two tests
hold it: `waitingTimer` must be longer than the placeholder plus a word (a bare
«Осталось {time}» fails), and every unit string must carry `{n}`.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/i18n.ts` (the
TRANSLATOR NOTE on `waitingTimer`), `ticket-state.ts` `CountdownUnits`.

## 2026-08-08 — "Close" is not an action, and it had the loud rung

**Kind:** founder decision
**What:** on the gate's waiting screen, **Закрыть** held the full-width glass
button and "Всё-таки оплатить за пару" — the only thing on the screen that does
anything — was a 14px grey text link beneath it. Swapped: the cover offer takes
the button, Close drops to text.
**Why:** the same inversion §3.5b already corrected once, on the cover screen
directly upstream of this one ("the only alternative was a 14px ghost text link
under a shimmering burgundy button"). It recurred here because the reconsider
link was written as *deliberately quiet* — "he already said no once, so this
reopens the door without pushing him through it" — which is right about tone and
wrong about rank. Close additionally duplicates Telegram's own ✕, sitting in the
chrome a few pixels above it.
**What it changes going forward:** "exactly one loud button per screen" is about
which ACTION is loudest, not about giving the loud shape to whatever is left. A
screen whose only offer is a way back still gives that way back the rung; Close
keeps it only when it is genuinely alone (a woman, or a man whose partner already
settled).
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/App.tsx`.

## 2026-08-08 — the claim rule was fixed on one side of the router and not the other

**Kind:** deviation from plan
**What:** found by a full-codebase audit, not by a report. `services/match-flow-claim.ts`
(2026-08-03) bounded the three MATCH flows that read the next plain message as
their answer. The identical shape existed one router over and was left
unbounded: five `menuState` values consume plain text and nothing ever released
them except the user happening to tap a button. Fixed with the menu twin,
`services/menu-text-claim.ts`.
**Why it matters more than the other four:** `edit_bio` writes its message
verbatim into `Profile.psychologicalSummary` — the dominant embedding input
(`V_explicit`, 0.65). The state lives in `bot_sessions`, so a user who tapped
**About me** and walked away had their next message, on any topic and any number
of days later, replace their whole profile analysis with no snapshot to restore
from — and lose the answer to the question they actually asked. Reproduced as a
failing test before the fix: the router called `prisma.profile.update` on a
three-week-stale claim.
**What it changes going forward:** **a session field that captures free text is
not finished until it carries a deadline.** The rule now exists twice, once per
router, and a sixth text-capturing `menuState` must be added to `CLAIMABLE` or
it inherits the bug. Expiring is deliberately a soft failure — the message falls
to the concierge, which can hand the editor back — so when in doubt the window
goes shorter, not longer. Media states (`edit_photos`, `edit_video`) are
deliberately out of scope: a stray photo lands in a gallery the user can see and
delete.
**One thing I decided NOT to do, and it is the more interesting half:** the
obvious second fix was to copy the agent's collapse guard
(`SUBSTANTIAL_BIO_LENGTH` / `BIO_SHRINK_LIMIT`) into the menu editor, since the
same wipe is reachable there unguarded. That is wrong. The agent's guard exists
precisely to route the decision INTO the editor — its refusal text says the act
"belongs in the editor where the user can read what they are replacing first" —
so guarding the editor too would leave no way to shorten a bio anywhere in the
product, a dead end in place of a data-loss bug. What was actually broken is
that the editor never showed that text, so the guard's promise was false and its
escape hatch led somewhere blind. The editor shows it now; the asymmetry stays,
on purpose.
**Recorded in:** PRODUCT_SPEC.md §2.1, `services/menu-text-claim.ts`,
`SessionData.menuClaimUntil`.

## 2026-08-08 — "best-effort" is not "one attempt", and a silent 502 is a bug of its own

**Kind:** deviation from plan + a document turned out to be wrong
**What:** reported as a demo bug — no photos anywhere on the venue-change board.
It is not demo-specific: same code (md5-identical), same Places key
(md5-identical), same droplet. Fixed in shared code — the proxy now retries a
transient upstream failure inside its existing 10s budget, the client retries
once, and every failure is logged.
**Why it matters more than the symptom:** two separate defects, and the second
is the reason the first was so hard to see.
- **The retry.** Measured on the droplet: intermittent `ETIMEDOUT` on the TCP
  connect to Google's photo CDN, ~1 request in 10 under a parallel burst,
  reproduced in **production** with the prod bot token. The board opens ~13
  tiles at once and the client's `onerror` was terminal (`settled = true`, swap
  in the category glyph, never ask again), so one blip meant permanently blank
  tiles until the Mini App was closed and reopened. `PLACES_API_KEY`, the Place
  Details lookups, the catalog and the bundle were all verified healthy — 85/85
  and then 72/72 parallel requests returned real JPEGs while I was testing.
- **The silence.** `!upstream.ok` and a non-image content-type answered 502 with
  **no log line at all**; only the `catch` logged. So a systematic upstream
  problem — a quota, a revoked key, a 429 storm — was indistinguishable from
  "photos just don't work". PRODUCT_SPEC's "best-effort" was being read as
  license for that; it is not, and it now says so.
**What it changes going forward:** on this path, **best-effort means retried and
logged, never silent**. Retry classification is explicit and must stay that way:
transient = thrown fetch / 5xx / 429 / 408; permanent = 4xx, non-image body,
over-ceiling file. The body read is deliberately classified separately from the
network error rather than sharing one `catch` — before this, an oversized image
threw into the same place a connect timeout did, so a retry loop would have
re-downloaded it. On the client, the retry paints the URL that actually decoded,
not the one it started from; painting the original would re-request the bytes
that just failed and hand the tile one more chance to break.
**Deliberately not done:** `fetchPlacePhotoNames` (Place Details) got no retry.
Zero failures in either log since the feature shipped, the host measured healthy
(0.13s), and its failures are **already logged** — so unlike the proxy it has no
blind spot. Its blast radius is worse (a failed lookup is cached empty for 5
minutes, costing one venue all six photos for everyone), so if evidence ever
appears, that is the next place to look.
**Also worth recording:** I could not reproduce the total blackout the founder
saw — at test time every request succeeded. The fix addresses a measured,
reproducible defect on the same path; it is not confirmed to be the whole of
what they experienced.
**Recorded in:** PRODUCT_SPEC.md §3.7b, ARCHITECTURE.md → `/v1/venue-change/photo`,
`apps/bot/src/public/routes/venue-change.ts`, `apps/webapp/src/photo-retry.ts`.

## 2026-08-08 — the ticket's barcode is replaced by the field it never had

**Kind:** founder decision
**What:** the stub's barcode is deleted and the stub prints `БАЛАНС ▸ 🎟 × N`
instead — a field name on the left, the wallet count on the right.
**Why:** the founder's reasoning, and it is the right one to record rather than
the visual: the barcode "носит только визуальную функцию", while the number
beside it was never explained, so the swap makes the same space functional. It
is not a loss of ticket-ness either — a printed field is at least as much a
ticket idiom as a barcode, and the perforation and real notch cutouts carry
that job anyway.
**What it changes going forward:** the card's `seed` prop and its stripe
generator are gone; nothing on the card is derived from the match id any more,
so do not reintroduce "a pair's own stripes". The stub's `min-height` is
load-bearing rather than spacing — a blank stub (the gate past the offer
screen) must keep the tear line where a printed one puts it, or the fixed
268 × 392 silhouette starts drifting per screen again. And `balanceLabel` is
**one word**, capped and space-free by a test: it shares a 220px line with the
count at 0.16em tracking, and a wrapped field name reads as a rendering fault.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The barcode is gone";
`apps/webapp/src/ticket/{Ticket3D.tsx,ticket.css,i18n.ts}`.

## 2026-08-08 — a pinned action bar is an island, and its fade is a length

**Kind:** founder decision
**What:** both ticket screens' bottom buttons stop being a welded footer. The
bar floats over the scroll and content dissolves under it through a scrim,
copying the venue board's CTA — which the founder named as the reference and
explicitly ruled out of scope for changes.
**Why:** in the flex flow the scroll ended at the bar's top edge, so content was
cut against a hard horizontal line belonging to no object on screen — a panel
edge in a system whose stated rule is depth from fills, inset light and shadow,
never outlines. Worth an entry for the two choices that diverge from `.vc-bar`
rather than for the copy itself: the fade is a fixed **72px** instead of that
bar's percentage, because this bar's height varies with the number of buttons
and with label wrapping, and a percentage hands the *shortest* bar the harshest
edge; and the scroll reserves the bar's **measured** height rather than a
constant, because a constant is either too small (content hidden behind the
buttons) or too large (a dead strip at the end of a short list), and which one
depends on the locale.
**What it changes going forward:** adding a button to either bar needs no
padding change — that is the point of measuring. Do not "simplify"
`action-bar.ts` back into a constant, and do not convert the 72px into a
percentage for consistency with `.vc-bar`; the two bars differ in exactly the
property that makes a percentage safe there. The venue board itself stays as it
is (founder scope call).
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The action bar floats";
`apps/webapp/src/ticket/{action-bar.ts,ticket.css}`.

## 2026-08-08 — on the dark theme the store's ordinary rows carry no light at all

**Kind:** founder decision
**What:** the two glass bundle rows lose the inner-edge sheen on dark and are
lifted by tint instead (a step lighter than the near-black page, plus the
shadow underneath). The sheen survives on the recommended row, on the one-time
famine row, and on both of them plus the ordinary rows on the light theme.
**Why:** the founder's words were "сделать их чёрными… а чуть более светлыми…
за счёт этого оттенок выделит их" — and the reason it is worth an entry rather
than a commit message is what it does to the rule above it. Light was being
worn by every row, which makes it a finish; spent on two rows, it is a signal,
and it now says the same kind of thing colour already says under "colour =
meaning". On cream the sheen has to stay: there it is a shading inward, and a
white row on a white page has no edge without it.
**What it changes going forward:** the house sheen is no longer "every
interactive surface gets it". On a dark surface, ask what it is distinguishing;
if the answer is nothing, tint and elevation are the correct tools. The famine
row is deliberately exempt — its rose temperature IS its meaning — so a future
pass must not fold it in with the ordinary rows for tidiness.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "One light, everywhere";
`apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the recommended row's edge light diverges from `.btn-hero`, on purpose

**Kind:** change of mind
**What:** the burgundy row drops the white 90° wash layer from its fill, cuts
the horizontal half of its inset sheen to a whisper on dark, and carries **no**
inner light at all on light. Hours earlier the same day I had written that it
was "exactly `.btn-hero`'s shadow list and nothing else", and treated that
identity as the thing to protect.
**Why:** the identity was protecting the wrong property. The hero button is
centred text on empty fill, so light hugging its sides lands on nothing. This
row has a 52px count emblem hard against the left inset — inside the first ~19%
of the width — so the same light lands on the one number the row is selling,
and the founder read it exactly that way ("засвечивает циферку шесть"). On
cream the rim had a second failure mode: white held just inside a burgundy
button does not read as light from the edge, it reads as a frame drawn around
the fill.
**What it changes going forward:** two components that look alike are not
automatically one component. Before copying a shadow list between surfaces,
check what sits under the light — an edge treatment is safe over fill and is
not safe over content. `.btn-hero` itself is unchanged and keeps the full
recipe; the two are never on screen together (store vs gate).
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the recommended bundle gets its burgundy fill back, in both themes

**Kind:** founder decision
**What:** `.store-bundle-best` becomes a filled burgundy button carrying white
inner-edge light — literally `.btn-hero`'s recipe — reversing the decision made
a few hours earlier the same day, which stripped the fill and left burgundy
light on glass.
**Why:** that earlier reasoning ("a colour plus a light temperature says 'this
one' twice") was derived on the dark theme, where it holds, and it failed on
cream: burgundy light shading inward on a white card is a smudge rather than an
emphasis, so the best offer on the screen rendered as the weakest row. The
founder described the fix precisely — burgundy button, white light, white
elements inside — which is the recipe that already exists as `--sheen-on-accent`.
**What it changes going forward:** the "exactly one loud button per screen" rule
is intact but now needs stating for this screen: the store HAS no hero button
(its action bar appears only after a purchase), so the recommended bundle is it.
Applied in **both** themes on purpose — a rung that is a filled button on one
theme and a glass row on the other is two components, and every later edit would
have to be checked twice. The row's shadow list must stay byte-identical to
`.btn-hero`'s: an outer burgundy glow was tried here for separation from the two
rows above and dropped, because it haloed the row and re-created the washed look
this change exists to remove.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "One light, everywhere";
`apps/webapp/src/tickets/store.css`.

## 2026-08-08 — the ticket's specular highlight is deleted, not tuned a third time

**Kind:** change of mind
**What:** `.ticket-glare` and the `--gp` rotation binding are removed outright.
Earlier the same day the highlight went from a soft radial blob to a narrow
raking band; the founder's verdict on the band was that it still reads wrong, so
the element is gone rather than retuned.
**Why:** worth an entry because the failure is structural, not parametric, and
the next person will otherwise try a fourth version. A highlight is a reflection
OF something. This card sits on a flat page with no light source, so whatever we
draw is a guess about a lamp that does not exist, and the eye reads a wrong
guess as paint on the surface. Two rounds of tuning (size, angle, alpha, rest
position) each produced a different wrong guess.
**What it changes going forward:** **do not reintroduce a drawn highlight on the
ticket.** The holographic film stays, at 0.22, because foil is a real property
of the stock and can shift with the angle honestly — that is the distinction to
apply to any future surface effect here. The drag / gyro / inertia interaction
is untouched; the card still turns.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The ticket card, and what it may
print"; `apps/webapp/src/ticket/ticket.css`, `Ticket3D.tsx`.

## 2026-08-08 — a decline reason blocked the next match, and ARCHITECTURE had been describing the fix for months

**Kind:** deviation from plan + a document turned out to be wrong
**What:** a demo bug report ("I pressed «show me the profile again» and nothing
came") was fixed in **production** code: `appendNegativeConstraint` now attempts
the immediate user-scoped embedding refresh that every other embedding-feeding
writer already did. Only two of the three fixes are demo-scoped.
**Why:** the demo was the messenger, not the defect. `embeddingDirty` is not a
scheduling hint — `findCandidatesFor` fail-closes on the **seeker's own** flag —
so recording a decline reason withheld that user from matching for up to five
minutes. And ARCHITECTURE.md had said *"embedding-feeding edits mark the profile
dirty and attempt a 30-second user-scoped refresh"* since M-2 shipped, which was
true of bio and partner-preferences and false of this one writer. The production
consequence is not theoretical: the paid Rematch offer (§3.11) is sent on the
decline path, so a man who explained his pass and bought a re-run inside the
window was told the engine found nobody — and refunded — when it had refused to
look. `REMATCH_FEATURE_ENABLED` has been on since 2026-07-27.
**What it changes going forward:** **marking `embeddingDirty` without attempting
a refresh is now a bug, not a style choice** — the flag removes a user from
matching, so whoever sets it owes the attempt. The one exception is explicit and
typed (`{ refreshEmbedding: false }`), for a caller appending several
constraints in a row; it must refresh once at the end. Also, per the 2026-08-07
entry: a demo-mode report is not automatically a demo-mode fix — check whether
the path is shared before scoping.
**Recorded in:** PRODUCT_SPEC.md → Embedding freshness (M-2); DEMO_MODE.md →
Recovery; `handlers/matching/negative-constraints.ts`.

## 2026-08-08 — a demo button keeps its button until it has something to show

**Kind:** change of mind
**What:** the redo tap no longer retires its own keyboard up front. It retires
it only once a profile has actually been dispatched; a refusal answers
immediately and leaves the button live.
**Why:** retiring first was deliberate — double-tap protection — and it is what
turned a recoverable refusal into a dead end: no button, no message, `/restart`
or nothing. The protection was worth keeping and belonged somewhere else, so it
moved to the driver's existing single-flight guard, which additionally fixes a
race the old code had (a tick can decide `pitch` the instant the tap clears the
finished row, and both would have run).
**What it changes going forward:** the general rule for a demo affordance is
that **the state a button describes is what may retire it, never the tap
itself** — the same reason production's ticket card is never edited. And a
handler that calls into the driver must consume the outcome: `performAction`
returns one precisely so a refusal cannot be dropped, and the button path was
the one caller still throwing it away.
**Recorded in:** DEMO_MODE.md → Recovery; `demo/commands.ts`, `demo/driver.ts`.

## 2026-08-08 — demo shared production's JWT secret, and nothing could have caught it

**Kind:** deviation from plan
**What:** `/opt/gennety-demo/.env` carried production's `JWT_SECRET` verbatim.
Both deployments therefore signed and accepted the same `/v1/*` access tokens —
same secret, same hardcoded `issuer`/`audience`, and `requireAuth`
(`auth-middleware.ts`) verifies a signature and never looks the user up. Rotated
to a demo-owned value; a divergence gate now runs in `deploy-demo.sh`.
**Why it happened, which is the reusable part:** the demo env is assembled by
hand as production's `.env` plus the overrides in `.env.demo`, so **every key
`.env.demo` forgets is silently inherited**. That same mechanism leaked
`SUPABASE_URL` on day one; it was caught and fixed, and the *class* was not.
`assertDemoIsolation()` cannot close it — from inside the demo process
production's values are unknowable, which is exactly why that function is
limited to settings wrong on their face (founder notifications, Stars, an admin
key).
**What it changes going forward:** the check belongs in `deploy-demo.sh`,
the only vantage point where both `.env` files are readable at once, and it runs
**before** the rsync so a violation costs nothing. Adding a secret to the demo
deployment now means adding it to `MUST_DIFFER`/`MUST_BE_ABSENT` there. Do not
try to move this into the process — it cannot work there.
**Recorded in:** `scripts/deploy-demo.sh` (isolation gate), DEMO_MODE.md → The
isolation invariant, deploy.md → the PENDING block at the top.

## 2026-08-08 — the demo could send real SMS on production's Twilio account

**Kind:** deviation from plan
**What:** `services/phone-verification.ts` had no dev/demo short-circuit at all,
while `/v1/auth/phone` is mounted unconditionally and `PHONE_AUTH_ENABLED` is on
in demo. A code requested against `demo-api.gennety.com` went to Twilio on
production's credentials. Fixed with a console rail gated on
`OTP_LOG_TO_CONSOLE`, mirroring `email.ts`.
**Why that gate and not `DEMO_MODE_ENABLED`:** the flag cannot be set in a
production-like runtime — `identityTrustConfigurationErrors` refuses to boot with
it on — so it already means "this is not production", and it covers **local dev
too**, which inherits the same `TWILIO_*` keys from `.env`. Gating on the demo
flag would have fixed one of the two deployments that had the problem.
**What it changes going forward:** the shared-third-party-credential decision in
DEMO_MODE.md ("stateless, spend is negligible") is sound for OpenAI/AWS/Places
but was never true of the two rails that **send things to strangers** — Twilio
and Resend. Resend was already handled. Any future outbound-messaging provider
needs the same short-circuit before it ships, not after an audit.
**Recorded in:** `phone-verification.ts` (console rail + its test),
ARCHITECTURE.md → `phone_otps`, DEMO_MODE.md → guarded branches.

## 2026-08-08 — giving up in the demo is a pause, not a retirement

**Kind:** change of mind
**What:** `failure-tracker.ts` abandoned an action permanently; it now releases
one probe after a cooldown. Plus a belt-and-braces guard: `ensureFreshEmbeddings`
rebuilds a stale vector before the demo pitches.
**Why:** the tracker shipped 2026-08-07 to stop a 1500-line refusal flood, and it
was right about that. What it could not distinguish is a *self-healing* refusal —
and it turned one into a dead demo, observed live: a ready visitor, zero matches,
`giving up on pitch`.
**Relationship to the decline-reason entry above, because they were found the
same day from the same symptom:** that one is the real fix and it is in
**production** code — `appendNegativeConstraint` now refreshes, so the specific
race is gone at the source. This entry is about what the *demo* did when a
refusal happened at all. The two are complementary rather than duplicated, and
that commit makes this one MORE necessary, not less: it routes the redo button's
refusals into the same ladder, so more things can now reach a ceiling that used
to be permanent.
**What it changes going forward:** the ceiling must never mean "never again". A
failed probe pushes the deadline out and cannot re-announce (the driver announces
only where the streak first equals the ceiling), so the flood stays shut without
the demo being able to die. `ensureFreshEmbeddings` is deliberately kept even
though the known writer now refreshes: it costs nothing when the vector is clean,
and not every path that dirties the flag refreshes it (a finalize whose initial
embedding failed leaves it dirty by design). It sits beside `releaseMatchCooldown`
because it is the same shape — a production precondition a fifteen-minute demo
must not be held by. It is a guard, **not** the fix for the decline race; do not
read it as one.
**Recorded in:** `demo/failure-tracker.ts`, `demo/partners.ts`
(`ensureFreshEmbeddings`), DEMO_MODE.md → A refused move is reported.

## 2026-08-08 — the referral cross-promo is a chip, and it never sits in an action bar

**Kind:** founder decision
**What:** the "invite a friend instead" link on all five paying surfaces becomes
one shared 30px chip (`apps/webapp/src/referral-hint.ts`) with one ≤31-character
statement per language — «Пригласи друга вместо оплаты» in RU — replacing five
hand-copied full-width rows of sentence-length text. On Premium it also moves
out of the pinned footer into the tail of the scroll.
**Why:** the founder reported it as "смещает кнопку сильно выше… визуально
нагромождённый". The audit found three separable causes rather than one taste
problem, and the measurements are what picked the fix: Premium was the only
surface where the hint sat in the action zone, which is `flex: none`, so it grew
that footer ~39px and moved the CTA; the copy ran 59 characters ≈ 415px against
~350px of usable width, i.e. two lines on every phone; and on the venue board
two equal full-width rows stacked and read as a list of options. Two alternatives
were offered and rejected — an inline link inside the price line (zero added
height, but the ticket gate and store have no such line at an empty wallet, so
it would have meant two patterns), and cutting the number of surfaces (a change
to REFERRAL_PRODUCT_SPEC, not to layout).
**What it changes going forward:** two rules, both encoded in that module's
doc-comment and one of them in a test. **This element never goes in an action
bar and is never full width** — it is a tail-of-content object. And **the copy
stays one line**: `referral-hint.test.ts` fails a translation over 31 characters,
because a chip that wraps is the block this replaced under a rounder corner. Add
a sixth surface by calling the shared module, not by copying a row.
**Recorded in:** PRODUCT_SPEC.md §3.9, `apps/webapp/src/referral-hint.ts`,
deploy.md → the PENDING block at the top.

---

## 2026-08-08 — the chat session is account state, and deleting an account must erase it

**Kind:** deviation from plan
**What:** `deleteUserAccount` now deletes the `bot_sessions` row, and the demo
`/restart` resets `ctx.session` in place. Found from a founder-reported dead end
in the demo — "Cannot finalize — missing required data: partner_preferences"
after uploading photos, with no way forward.
**Why:** the row is keyed by Telegram CHAT id and has no relation to `users`, so
it is the one store the Prisma cascade cannot reach. It had been treated as
transport state; it is account state. The reconstruction from `chat_events` is
what makes the class clear rather than the instance: a `/restart` left
`expectingPhoto: true` behind, the NEXT account inherited it, three uploads at
the `hobbies` question produced a Continue button, and Continue called finalize
directly — refused, changed nothing, stage still open, no path back to the
missing question.
**What it changes going forward:** three rules. **A store with no FK to `users`
is not automatically out of scope for deletion** — `bot_sessions` was the only
one, and it also held `pendingPhotos`, a buffered AI-memory paste and
`activeMatchId`, so this was a GDPR gap as much as a state one. **A Telegram
caller must reset `ctx.session` as well as the row**, because grammY writes the
live session back after the handler and would resurrect it. And **an
LLM-facing tool diagnostic must never be a user-facing reply**: it is English,
names internal field keys, and instructs a model — the two sites that printed
it now log it and answer with localized copy.
**Recorded in:** ARCHITECTURE.md → `bot_sessions`; PRODUCT_SPEC.md §1.3 and
§GDPR; DEMO_MODE.md → Recovery.

## 2026-08-08 — a demo-only deploy can ship a production fix to the demo and nowhere else

**Kind:** deviation from plan
**What:** `087e7e4` (free text that isn't an answer) ran in the demo from
2026-08-07 and in production only on 2026-08-08. Nothing was mis-scoped — it was
committed before two demo-only releases, and `deploy-demo.sh` syncs the whole
working tree, so it rode along to `/opt/gennety-demo` while `/opt/gennety` was
deliberately never restarted.
**Why it matters:** the signal we use to prove a demo deploy was safe — the
production restart count not moving — is the same thing that hides an unshipped
production fix. It also inverts the usual assumption: the demo was AHEAD of
production, so testing the demo bot would have shown a fix that real users did
not have. Found only because the founder asked directly whether production was
current.
**What it changes going forward:** a demo release is not a release. After
`pnpm demo:deploy`, recompute the production gap (`git log <prod-sha>..HEAD`) —
and when that range contains a commit under `apps/bot/src/demo/`, the commits
*around* it are the ones to check, because the demo one is the reason the range
exists at all. Verify by module presence on `/opt/gennety`, never by which
release a commit happened to precede.
**Recorded in:** deploy.md → the 2026-08-08 release block and the "Prod anchor"
section.

## 2026-08-08 — the current-venue card's badge moved so a photo could fit

**Kind:** deviation from plan
**What:** the ask was "show a photo on the current-venue card too". Adding the
68px thumbnail broke the card's text: the "Picked for you" badge wrapped into a
two-line pill and the venue's own name truncated. So the badge moved out of the
text column onto its own line at the top of the card, and the name now wraps
instead of ellipsizing. That is a visible layout change nobody asked for.
**Why:** the photo and the badge want the same width and the card cannot give
both. Measured rather than eyeballed: the photo costs 82px of a ~350px card,
leaving the badge 176px against 188px (ru) and 203px (pl). Shrinking the
thumbnail does not fix it — 12px back does not cover a 27px shortfall in Polish
— and a wide photo banner across the card top would have roughly doubled the
height of the one venue the user came to this screen to move away from.
**What it changes going forward:** the pinned card is now a two-row card
(badge, then picture/words/heart) while the twelve alternatives stay one row.
Do not "restore" the badge into the meta column without also removing the
photo. The name wraps only on this card; the alternatives keep their ellipsis
because an even row height is what makes that list scannable.
**Recorded in:** PRODUCT_SPEC.md §3.7b; `renderCurrentCard` +
`.vc-card.is-current` in `apps/webapp/src/venue-change.{ts,css}`.

## 2026-08-08 — the pinned venue shows its stored cover, not a fresh gallery

**Kind:** change of mind
**What:** I first planned to resolve the current venue's full photo set from
`venuePlaceId` on every board state, giving the pinned card the same 6-photo
gallery every alternative has. It ships the other way round: the cover stored at
assignment (`Match.venuePhotoName`) is used, and a Places lookup happens ONLY
when a row carries no cover.
**Why:** `/v1/venue-change/state` is polled every ~4 s, and the gallery is worth
a network call on that path only if it buys something. It does not: the stored
cover is already correct, free, and is the exact image the pair saw on their
date card, so the board and the card agree on what the place looks like. The
lookup survives as the fallback because a row with no cover would otherwise show
a grey tile forever.
**What it changes going forward:** the pinned card's preview shows one photo
where an alternative shows up to six — deliberate, not an oversight. If that
asymmetry ever needs closing, warm the cache in the background and let the NEXT
poll carry the gallery; do not make the first paint wait on Places.
**Recorded in:** `originalPhotoRefs` in `handlers/matching/venue-change.ts`,
`resolveVenuePhotoRefs` in `services/venue-change.ts`; ARCHITECTURE.md → the
`/v1/venue-change/state` row.

## 2026-08-08 — the ticket card keeps names on the gate only, and loses everything else

**Kind:** founder decision
**What:** the hero Date Ticket card drops "На двоих" (both places), the
"curated date ticket" label and the marketing tagline; gains the brand
butterfly as its centre and the wallet count on its stub. The **names stay on
the gate and go from the store** — the founder picked that over my
recommendation of dropping them everywhere.
**Why:** I argued for one composition with no names at all (the partner's name
is already on the gate three times: headline, sub, and the pay-for-both
avatar), because keeping them on one screen and not the other is how you end up
maintaining two designs. The founder wants the gate's ticket to be *theirs*.
Resolved without a second design: the names are one optional line under the
butterfly, so the store simply renders the same card minus that line.
**What it changes going forward:** the card is one component
(`Ticket3D`) on both screens, and it must stay that way — anything added for
one screen has to be expressible as an optional line, or the (б) choice quietly
becomes two layouts after all. The serial no longer seeds from the holders'
names (it could not, once one screen had none); it seeds from the match id on
the gate and a constant in the store.
**Recorded in:** PRODUCT_SPEC.md §3.5b → "The ticket card, and what it may
print"; `apps/webapp/src/ticket/Ticket3D.tsx`.

## 2026-08-08 — "На двоих" was a lie, not a style problem

**Kind:** founder decision
**What:** the card printed "На двоих" / "Admit two" in its header and "НА
ДВОИХ" on its stub. One ticket admits **one** person — a man paying $13.98 "for
us both" buys two of them (§3.5b) — so a user who chose "pay only mine" was
being told his partner was already covered. Deleted from `TicketStrings` and
all five locales.
**Why:** worth its own entry because it is the one deletion on that card that
was **mandatory** rather than aesthetic. The label, the tagline and the names
went because the card is better without them; these two had to go even if we
had decided to keep the card wordy.
**What it changes going forward:** the falsehood was confined to the Mini App —
`packages/shared/src/i18n.ts` has no ticket copy claiming two admissions — so
there is nothing else to chase. Do not reintroduce a "for two" line anywhere on
a single ticket.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `apps/webapp/src/ticket/i18n.ts`.

## 2026-08-08 — the wallet count hides at zero, which is NOT the rule I was given

**Kind:** deviation from plan
**What:** I asked whether to keep the balance-visibility rule one-to-one when
moving the count from a pill under the card onto the card's stub; the founder
said keep it. I then made it hide at a **zero** balance, which the store's pill
did not do — it rendered "Твой кошелёк: 0 🎟️" unconditionally.
**Why:** the two are not the same element. "Твой кошелёк: 0" is a sentence and
reads fine; "🎟 × 0" printed on a ticket reads as a rendering fault. The
information is not lost — an empty wallet is precisely the state the bundles
below are for, and the referral cross-promo already fires at zero.
**What it changes going forward:** the gate's own rule (only on `offer` /
`cover-partner`) is untouched. If the store ever needs to state an empty wallet
explicitly, that is a line of copy on the page, not a zero on the ticket.
**Recorded in:** PRODUCT_SPEC.md §3.5b; `Ticket3D.tsx` (`balance` prop).

## 2026-08-08 — the hero button stops shimmering

**Kind:** change of mind
**What:** `.btn-hero`'s travelling white bar (`sheen`, 3.4s loop) is replaced by
the house inner-edge sheen. PRODUCT_SPEC had described that button as "the one
burgundy, **shimmering** rung", so this is a documented behaviour changing, not
a tidy-up.
**Why:** the founder asked for the perimeter glow on the store's bundle buttons
and, separately, complained that the ticket card's moving highlight looked
unnatural. Those are the same defect: a hard-edged rectangle sweeping across a
static surface on a loop, with no surface for it to be a reflection of. Fixing
one and leaving the other on the adjacent screen would have been incoherent.
**What it changes going forward:** **`venue-change.css` still has its own copy
of the `sheen` keyframes and uses it twice** — those two buttons now shimmer
while the ticket screens in the same flow do not. Deliberately left alone
(out of the scope the founder set), but it is the next thing to converge.
**Recorded in:** PRODUCT_SPEC.md §3.5b (both the pricing bullet and the new
"One light, everywhere" note); `apps/webapp/src/ticket/ticket.css`.

## 2026-08-08 — the ticket glyph ships as a vector, and is expected to be replaced

**Kind:** founder decision
**What:** the wallet count on the stub is drawn with a new `TicketMark()` in
`marks.tsx`. The founder will supply a PNG of the mark from an external tool
later.
**Why:** platform emoji are banned on these surfaces (`marks.tsx`) — the old
string used `🎟️`, which would have rendered as Apple's art on iOS and Google's
on Android and blurred at any scale.
**What it changes going forward:** whoever swaps in that PNG must know the mark
sits on the **always-dark** ticket stock in both themes and currently inherits
`currentColor` at 0.85 opacity. A PNG cannot inherit colour, so it has to ship
light-on-dark and be checked against the stub's burgundy-black ground, not
against the page.
**Recorded in:** `apps/webapp/src/ticket/marks.tsx`.

## 2026-08-07 — the rule behind three separate "what if the text isn't an answer" fixes

**Kind:** change of mind
**What:** the codebase held **four** unsynchronised strategies for a user
replying to a prompt with something that is not an answer. Decline → the agent
judges and the tool is guarded. Profiler → the router wrote it verbatim and the
agent was never told the feature exists. Onboarding photos below the minimum →
the agent answers while the gate holds. Onboarding photos above it → the agent
was not called at all. The rule that separates the two good ones from the two
bad ones is now explicit: **a gate is derived from state, never from the
conversation; and the conversation always reaches the agent.**
**Why:** the founder asked the same question three times about three different
screens, which is what surfaced it as one problem rather than three. The photo
stage below the minimum already satisfies both halves and is the model — it is
the only one of the four that was fully correct. Profiler satisfied neither
(verbatim capture means the conversation writes state directly, bypassing the
agent); photos above the minimum satisfied the first but not the second.
**What it changes going forward:** any new step that reads free text owes both
halves. If a new surface captures text in a router before the agent, it must
classify intent before writing — and whatever it refuses to write must still
reach the agent rather than vanish.
**Recorded in:** PRODUCT_SPEC.md §1.3 (media stage), §Phase 1b (refusal),
§3.4 (decline feedback).

## 2026-08-07 — preset decline reasons stay out of matching, and that is deliberate

**Kind:** change of mind
**What:** I first offered "route the four preset reasons into
`negativeConstraints`" as an equal alternative to fixing the copy. It is wrong,
and the copy fix is the whole change: the buttons remain analytics and the
message no longer promises otherwise.
**Why:** `V_penalty` is a literal word-match of each stored trait against the
candidate's `psychologicalSummary`. A preset is a category, not content — "не
мой тип" does not say which type — so feeding it in either writes a trait that
can never match any summary, or lets the LLM distiller invent a specific trait
out of a content-free label, and that invention then penalises real candidates.
The second is worse than doing nothing. Separately, production has had 2 matches
ever, both terminal, so a learning loop here would be calibrated on zero
examples.
**What it changes going forward:** **do not route presets into
`negativeConstraints`** — the mechanism is built for free text with content, and
the free-text path already does this correctly. If preset reasons should ever
influence matching, each button names a *different* axis with its own structured
home (appearance → `typePrefTags`/`appearanceTags`, vibe → the energy/orientation
quadrant, interests → `hobbies`/`anchorTags`), one decline is too weak a signal
to mutate any of them, and it starts with a query over accumulated declines
rather than a write. Note also that Type Radar is opt-in calibration while a
decline is not, so learning appearance preference from rejections is a consent
decision, not a technical one.
**Recorded in:** PRODUCT_SPEC.md §3.4.

## 2026-08-07 — a Profiler refusal pauses the batch; a permanent opt-out is not built

**Kind:** founder decision + not done
**What:** answering a Profiler question with "не хочу" records a skip and defers
the rest of the batch to the user's next local window. A permanent "stop asking
me these" was discussed and deliberately left out.
**Why:** the founder described wanting the bot to say "окей" and stop the batch,
which the pause delivers. Permanent is a different thing: it needs a Settings
surface, a way back, and a demo-mode branch, and a one-word "потом" must not be
able to retire a feature for an account. The pause self-heals, so the cost of
being wrong about the classification is one window rather than forever.
**What it changes going forward:** if a permanent opt-out is wanted later it is
a product decision with its own UI, not an extension of this classifier.
**Recorded in:** PRODUCT_SPEC.md §Phase 1b; `services/profiler-intent.ts`.

---

## 2026-08-08 — the demo shows all three coordination variants, and explains the two it cannot run

**Kind:** founder decision
**What:** in demo mode the pre-date fork (§Phase 4) is shown with **all three**
buttons. Tapping either contact-exchange variant — impossible against a puppet
with no Telegram account — answers with what that button would have done in
production, what it costs, and why it cannot run here, then hands the choice
straight back with the remaining buttons. Only the anonymous chat is performed.
**Why:** the founder wanted the *mechanic* demonstrated, not hidden. The two
rejected alternatives were worse in opposite directions: sending nothing (what
production does for an unreachable pair) means an investor never learns the
question exists, and giving the puppet a fake `@username` to make A and B "work"
would put a dead `t.me/` link on screen — a demo that lies is worse than one
that explains. Explaining costs one paragraph and demonstrates more of the
product than pressing a working button would.
**What it changes going forward:** the fork card is **demo-owned** — sent from
`apps/bot/src/demo/`, with `demo:coord:*` callback data, reusing production's
renderer, copy and labels. Do NOT "simplify" this by adding a ninth
`if (DEMO_MODE_ENABLED)` to `resolveCoordRecipients`: production's own handler
would still refuse the tap, its keyboard still could not show A/B without a
username, and variant A would *succeed* for a visitor who has one — writing
`coordMethod: "share_self"` and permanently blocking the anonymous chat. A and B
must keep writing **nothing**; that is what holds the fork open so both can be
read.
**Recorded in:** DEMO_MODE.md → "The coordination fork is the demo's own
screen"; `apps/bot/src/demo/script.ts` → `DEMO_COORD_PREFIX`.

## 2026-08-08 — the demo puppet answers in the anonymous chat, via an LLM

**Kind:** founder decision
**What:** the puppet writes in the pre-date relay — one small LLM call per turn,
prompted as a real person on the way to the date, carrying the venue, the time
in the pair's timezone and the transcript. It writes FIRST ("ten minutes out,
where are you?"), then arrives, then keeps to finding each other.
**Why:** the relay is the one place in the product where two users write to each
other, and in demo the other side cannot type at all (no chat, no push token).
A visitor writing into silence had been shown a broken feature. The founder's
framing was explicit: give it the date context and a situation, and let it
simulate the real thing.
**What it changes going forward:** the puppet must never start a conversation
about the date itself — the product deliberately has no pre-date chat beyond
logistics, and demoing one would be inventing a feature. The reply is capped
(8 messages), validated, and falls back to a scripted ladder, so the chat works
with no `OPENAI_API_KEY`. It goes through the production `relayProxyMessage`
with an injected clock, never a hand-written row plus DM — anything else would
drift from the real log and the real delivery path.
**Recorded in:** DEMO_MODE.md → "The puppet talks in the anonymous chat";
`apps/bot/src/demo/proxy-partner.ts`.

## 2026-08-08 — a demo step that is a real decision gets a real pause

**Kind:** change of mind
**What:** the pre-date replay was one run of four gates 4 seconds apart. It is
now three stretches, stopping at the coordination fork and again at the open
relay, resuming on the visitor's own tap or a floor timer.
**Why:** the single run closed the anonymous chat four seconds after opening it,
so the visitor got a live "Enter chat" button that was dead by the time they
reached it. The rule this establishes is more general than the bug: **the replay
compresses WAITING, not deciding.** A gate the visitor is meant to answer cannot
be replayed past.
**What it changes going forward:** a new gate added to the replay must be sorted
into one of the two kinds. If it produces something the visitor is meant to press,
it needs its own stretch, a floor timer and a button — the pattern the date-card
handover already established.
**Recorded in:** DEMO_MODE.md → the gate list; `apps/bot/src/demo/driver.ts`
(`PRE_DATE_GATES` / `COORD_GATES` / `AFTER_DATE_GATES`).

## 2026-08-08 — the first complete demo run, and what it found

**Kind:** deviation from plan + a document turned out to be wrong
**What:** the founder walked the demo end to end for the first time. It reached
`status: completed` with a real venue, a rendered date card and the feedback
prompt — and `venue_selection_logs` went from 0 to 1, i.e. the venue engine ran
in the demo for the first time ever. Three things did not fire; only one was a
bug.
**Why each:**
- **Pre-date coordination never ran (real bug).** `runCoordinationTick` is a
  SEPARATE sweep from `runDateLifecycleTick`, called on the real clock, so the
  demo's replay skipped the whole hour before the date — offer, anonymous chat
  and all five coordination cards — with the flag on the entire time. Fixed.
- **The safety brief did not fire (not a bug).** It addresses the female
  participant and the pair was male+male. It is a *coverage* limit: a male
  visitor can never see it, nor the hetero-only cover gesture, wish card or
  express venue change. A second run from the other side is the only way.
- **`DATE_COMPLETED` never appeared — because nothing writes it.** I had told
  the founder that event would be the proof the demo finished. It and
  `PROPOSAL_SHOWN` are declared in `MatchEventActionType` and have no write site
  anywhere. Completion is `Match.status`, dispatch is `Match.dispatchedAt`.
**What it changes going forward:** a new sweep on the date-lifecycle interval
must be added to the demo replay as well — the replay is not "the lifecycle", it
is "everything the interval does". And `match_events` is not a funnel: two of
its eight values are reserved, not data.
**Recorded in:** DEMO_MODE.md → "the pre-date replay … needs BOTH sweeps";
ARCHITECTURE.md → `match_events`; PRODUCT_SPEC.md §Phase 5.

## 2026-08-08 — deploy.md said coordination was off in production; it has been on

**Kind:** a document turned out to be wrong
**What:** two deploy.md blocks stated `COORDINATION_FEATURE_ENABLED` is **off**
in production and that the pre-date coordination routes were therefore inert. It
is `true` in `/opt/gennety/.env` (line 70) and the running process confirms it —
`GET /v1/app/config` answers `features.coordination: true`. A third block, from
2026-08-02, said the opposite and was right; the file had been contradicting
itself for six days. I repeated the wrong version to the founder before checking.
**Why it went unnoticed:** production has had **0 dates ever**, so nothing has
reached T-60m and the feature has never actually fired there. A flag being on
looks exactly like a flag being off when no data can exercise it.
**What it changes going forward:** read a flag off `/v1/app/config` (or the
running process), never off a sentence in deploy.md — that file carries per-release
snapshots that age, and a later block can silently contradict an earlier one. When
a block asserts "inert in production", the assertion needs a runtime check beside
it, not a claim.
**Recorded in:** deploy.md → both corrected blocks carry a ⚠️ note in place.

## 2026-08-07 — a broken demo says so out loud rather than going quiet

**Kind:** founder decision
**What:** when a puppet move is refused three times running, the demo tells the
visitor it is stuck and points at `/restart`, and stops retrying that move.
Before this every branch of the driver either ignored the result or logged a
warning and returned, so a refusal was re-derived and re-attempted every tick
forever.
**Why:** the founder asked for a full sweep of the demo specifically because the
ticket-gate stall was found by accident. Two measurements settled the shape of
the fix: `insufficient-balance` was logged **1500 times** across hours, and the
tick summary reported `acted=1 errors=0` throughout — so the only signal anyone
watches was actively asserting health while the demo was dead. The failure that
matters here is not an exception, it is **silence in front of an audience**. A
demo that admits a fault can be restarted in two minutes; one that quietly stops
cannot be rescued at all.
**What it changes going forward:** a new puppet move must return an outcome, not
`void` — `performAction`'s parameter is typed `Exclude<DemoAction, {kind:"none"}>`
so a new action kind fails the exhaustiveness check instead of silently counting
as a success. The visitor-facing message stays **vague about the cause** on
purpose (nobody can act on `insufficient-balance`); the reason belongs in the
log, written once per streak rather than once per tick.
**Recorded in:** DEMO_MODE.md → "A refused move is reported, not retried
forever"; `apps/bot/src/demo/failure-tracker.ts` (+ its test).

## 2026-08-07 — a demo bug report fixed in production code, and a symptom I could not reproduce

**Kind:** deviation from plan
**What:** the founder reported three demo-mode defects. Two were demo-only and
fixed there. The third — the two avatars on the Date Ticket "pay for us both"
button rendering as placeholders — was fixed in the **shared** ticket route
(`services/avatar-thumbnail.ts`, `public/routes/ticket.ts`) plus the shared
`Avatar` component, so it ships to production as well as to the demo.
**Why:** the cause is not demo-specific. The route streams participants' FULL
profile photos to fill two 44px circles — measured live at **517 KB + 355 KB**
for one button, ~850 KB inside a Telegram WebView against the client's 6-second
preload budget. A real user on mobile data hits the same thing; scoping the fix
to `apps/bot/src/demo/` would have meant knowingly leaving it in the paid flow.
**The part worth flagging for whoever reads this next:** I could not reproduce
the exact rendering. Both endpoints answer **200 image/jpeg** in 0.6–1.0s from a
laptop, so the "two question marks" were never observed by me directly. What
shipped is the measurable defect (bytes) plus a graceful failure path (`onError`
→ monogram, because `alt=""` makes a broken `<img>` render as nothing or as the
client's broken-image glyph). If the placeholders come back on a fast
connection, this was the wrong cause and the next step is a device-side network
trace, not another guess.
**What it changes going forward:** a demo-mode report is not automatically a
demo-mode fix — check whether the code path is shared before scoping. The
avatar ceiling (256px) is 2× the largest avatar the Mini App draws at 2× DPR;
raising the drawn size means raising it.
**Recorded in:** deploy.md → the PENDING block at the top; DEMO_MODE.md →
driver state table + Recovery.

## 2026-08-07 — the App Store price gap closed, and iOS Premium turned out not to be purchasable at all

**Kind:** founder decision + a document turned out to be wrong
**What:** `premium_monthly` was raised $9.99 → **$17.99/mo** in App Store Connect
(US base; Apple auto-generated 175 storefronts), closing the gap opened hours
earlier when the Telegram rail went to 750⭐/$17.99. Verified by reloading the
product page, not from the confirmation dialog: US at 17,99 $ with **0 upcoming
changes**, so it is the live price rather than a scheduled one. Ticket products
untouched. Supersedes the "left behind on purpose" entry below.
**Why the second half matters more than the price:** the same pass surfaced a
fact recorded **nowhere in this repo** — the subscription group sits in
*Preparing for Submission*, under Apple's rule that **the first subscription
group must ship with a new app version**. So `premium_monthly` cannot be bought
on any storefront until a build carrying it clears review. Everything written in
deploy.md about the $9.99/$17.99 mismatch described a real config divergence
that **no user could ever have encountered**, because the product was not
purchasable on either price.
**What it changes going forward:**
1. **`features.premium: true` in `/v1/app/config` does not mean iOS can sell
   Premium.** That flag mirrors `PREMIUM_FEATURE_ENABLED` on the server and
   knows nothing about App Store review state. A native paywall gated only on it
   renders a StoreKit product that cannot be purchased. The App Store rail goes
   live at first approved submission, not at a flag flip — and the same is true
   of the ticket products.
2. **Every future `PREMIUM_PRICE_USD_DISPLAY` change needs a manual App Store
   Connect edit in the same breath.** There is no server-side price for iOS to
   read, so no deploy can ever move it and nothing in this repo will show the
   drift. Treat the two as one edit with two halves.
3. Fixing the price *before* first submission was the cheapest possible moment:
   no price history, no subscriber cohort, so no "preserve price for existing
   subscribers" decision existed to get wrong. That is why the wizard offered
   neither that prompt nor a start-date picker — do not read their absence as a
   sign something was skipped.
**Recorded in:** deploy.md → the 2026-08-07 release block, the Premium price
block, and the StoreKit block (price table + the new submission-state warning).

## 2026-08-07 — the preference screen's photo scatter wins; the other design is deleted, not flagged off

**Kind:** founder decision
**What:** "Who do you want to meet?" ships the tilted-photograph scatter. The
group-cutout design built beside it, the dev `?v=` switch, the side-by-side
review page, the variant-2 CSS and the two cutout images are removed from the
tree — `preference-variant.ts` is gone, `PreferenceColumn` takes no `variant`.
**Why:** the founder compared the two on the live screens over two days and
settled ("я уже полностью определился"). Keeping the loser behind a constant
would leave a switch nobody is going to flip, plus ~335 KB of artwork in the
bundle and a second set of CSS overrides that every future edit to this screen
has to be checked against. A decision that is made stops being configuration.
**What it changes going forward:** this screen has ONE design. Do not
reintroduce a variant switch to try an alternative — branch instead. The
deleted design is recoverable from git (`git show
8190fea:apps/webapp/src/preference-variant.ts` and the paths beside it), which
is where a reverted design belongs. One trap: `onboarding.html` requests Inter
800 and must keep doing so — it arrived for the deleted design's heavy word,
but «Парней» / «Девушек» now depend on it, so the obvious post-removal tidy-up
would silently downgrade them to a synthesised bold.
**Recorded in:** PRODUCT_SPEC.md §1.3 (the preference screen), deploy.md → the
PENDING Mini App block at the top and the "So does the preference photo fork"
bullets.

## 2026-08-07 — what the two-design comparison taught, kept after the loser was deleted

**Kind:** founder decision
**What:** the reasoning that killed the group-cutout design is retained in
PRODUCT_SPEC as a constraint on anything that replaces this screen, rather than
deleted with the code: **a taller button does not draw people any bigger.**
**Why:** the finding is about the column, not about that design — group artwork
runs out of column WIDTH long before it runs out of height, so at half a phone
wide five people across are ~32px each and extra button height only becomes
headroom. Someone proposing "show a group photo here" in six months would
otherwise rediscover it by building the thing again. The scatter sidesteps it by
showing one person per frame.
**What it changes going forward:** a future group/multi-person treatment for
this screen has to answer that measurement before it is worth building.
**Recorded in:** PRODUCT_SPEC.md §1.3.

## 2026-08-07 — the proxy-chat window is derived from `agreedTime`, not read from the cron's stamps

**Kind:** deviation from plan
**What:** `proxyChatWindow()` computes T-30m…T+2h from `Match.agreedTime`.
`proxyOpenedAt` / `proxyClosesAt` are no longer the gate; they keep their real
job (the pair was TOLD) and `proxyClosedAt` remains a force-close that wins.
**Why:** those columns are written by the 2-minute coordination tick, so gating
on them opens a THIRTY-minute window up to two minutes late — on the one
surface whose entire value is the last half hour before a meeting. Deriving it
also makes both surfaces agree instantly instead of agreeing eventually.
**What it changes going forward:** the window is a pure function of the
schedule. A change to when the tick runs cannot move the edges, and any new
surface must call `proxyChatWindow` rather than read the columns.
**Recorded in:** `services/proxy-chat.ts`; pinned by `proxy-chat.test.ts`
("is open on time even though no cron has stamped anything").

## 2026-08-07 — the proxy-chat push carries the message text (4.4's rule does not apply here)

**Kind:** change of mind
**What:** a relayed message is pushed to a mobile partner with the body in it.
In §4.4 the emergency-cancellation push deliberately withholds the canceller's
reason.
**Why:** the two are not the same case. A cancellation reason arrives unbidden
and is emotionally loaded, so it belongs where the recipient chose to look. A
coordination message is a chat the user opted into, in the last half hour
before meeting, where "you have a new message" is precisely the notification
that makes someone open the app and read "I'm by the door" thirty seconds too
late.
**What it changes going forward:** "never put another user's free text in a
push" is NOT a general rule of this product — it is a rule about unbidden text.
Anyone applying it to a future surface should check which of the two this is.
**Recorded in:** `deliverToPartner` in `services/proxy-chat.ts`.

## 2026-08-07 — a pair the Telegram fork cannot reach gets the proxy chat automatically

**Kind:** deviation from plan
**What:** when `resolveCoordRecipients` comes back empty — either side is not
reachable in a bot chat — the T-60m sweep now writes `coordMethod: "proxy"`
itself instead of only stamping the marker and moving on.
**Why:** the coordination method was selected by tapping an inline keyboard, so
a pair with an app participant never had one, and `openProxies` (which requires
`coordMethod: "proxy"`) never opened a window for them. The whole feature was
structurally unreachable from the app — not missing an endpoint, missing an
initiation. Auto-selecting is right rather than building a second menu: the
fork's other two variants exchange Telegram handles, meaningless to someone who
has none, and ROADMAP/PRODUCT_SPEC already put contact exchange in stage 2 and
keep only variant C in the MVP. So on the app there is nothing to choose
between. Flagged to the founder before implementing; no objection.
**What it changes going forward:** reversible by deleting one branch in
`sendOffers` if the app is ever given its own choice screen. Until then, "the
pair has no coordination method" no longer implies "the pair chose not to
coordinate".
**Recorded in:** `sendOffers` in `services/coordination.ts`.

## 2026-08-07 — `telegramId > 0` was still being used as a reachability test

**Kind:** deviation from plan
**What:** `resolveCoordRecipients` filtered on `telegramId > 0n` alone; it now
also requires `platform in (telegram, both)`.
**Why:** ARCHITECTURE has stated since Telegram login shipped that a positive
`telegramId` no longer implies the bot can message someone — that rail stores a
REAL id on an app-only account, and a bot cannot open a chat with a user who
never pressed Start. Two workers were already fixed for this; the coordination
sweep was not, so it would have offered an inline keyboard to someone who could
never see it, and then read the silence as a choice.
**What it changes going forward:** the same audit is worth running on any other
`telegramId > 0` filter. A row predating the `platform` column falls back to
the id, so no existing Telegram user loses the offer.
**Recorded in:** `telegramReachable` in `services/coordination.ts`.

## 2026-08-07 — Premium moves to 750⭐/$17.99 with the App Store left behind on purpose

> **Superseded the same day** — the App Store price was raised to $17.99 hours
> later and the two rails now agree. See "the App Store price gap closed, and
> iOS Premium turned out not to be purchasable at all" above. The reasoning
> below still stands as the record of why the bot rail moved first.

**Kind:** founder decision
**What:** `PREMIUM_STARS` 500 → 750 and `PREMIUM_PRICE_USD_DISPLAY` $11.99 →
$17.99 applied to `/opt/gennety/.env` during the 2026-08-07 release, while App
Store Connect still prices `premium_monthly` at **$9.99**. The founder chose to
raise the Telegram rail now rather than wait for the two surfaces to line up.
**Why:** the deploy.md block had been blocked on an operator step nobody was
going to do first, and the code defaults were already 750/$17.99 — only the
`.env` override was holding the old price, so the block would have stayed
PENDING indefinitely. 0 purchases ever, so no existing subscriber is
grandfathered onto the old amount and the cohort the block warns about is empty.
**What it changes going forward:** the same subscription costs **$17.99 in the
bot and $9.99 in the app** until the price tier is raised in App Store Connect.
Nothing in this repo can close that gap — iOS renders StoreKit's own
`displayPrice` and `/v1/app/config` exposes only a boolean — so it is an
operator task, not a code one. Do not "fix" it by editing constants.
**Recorded in:** deploy.md → the 2026-08-07 release block and the Premium price
block; `/opt/gennety/.env` (rollback snapshot `.env.bak.*` taken same deploy).

## 2026-08-07 — a deploy.md block below the catch-up marker was still pending

**Kind:** a document turned out to be wrong
**What:** the 2026-08-02 marker claims "every block below that was marked PENDING
shipped in one deploy". The account-health block sits below it but its commit
`44f9e41` is dated 2026-08-03 — it was inserted in the wrong place and had never
been deployed. Caught only because `admin/utils/user-health.ts` was absent from
the droplet.
**Why:** it matters more than a filing error. That marker is the single thing a
new session uses to tell a real backlog from a stale label, and the failure is
silent in the worst direction — a block that reads as shipped and is not. The
paired symptom: the admin dashboard repo had already been pushed and
auto-deployed, so its new tabs had been calling `/admin/users/:id/health` and
`/admin/purchases` against a server that did not serve them, with nothing
surfacing the breakage.
**What it changes going forward:** verify a block by whether its module is on the
droplet, never by which side of the marker it is on. New blocks go at the TOP of
deploy.md. When a block names a dashboard redeploy, check whether it already
happened — a pushed dashboard against an undeployed server is a broken tab, not
an error anyone sees. Marker annotated; all 34 stale PENDING labels retired, so
deploy.md now has **zero** PENDING blocks.
**Recorded in:** deploy.md → the ⚠️ warning on the 2026-08-02 marker and the
account-health block.

## 2026-08-07 — "production has 0 matches ever" was copied forward until it was false

**Kind:** a document turned out to be wrong
**What:** a dozen deploy.md blocks assert production has had 0 matches ever and
base their post-deploy advice on it. Production has had **2**, both from the real
Thursday drop: `2026-07-30 15:00Z` (expired) and `2026-08-06 15:00Z` (cancelled),
both `source = weekly`.
**Why:** the claim was true when first written and was then pasted into each new
block as boilerplate rather than re-measured. It is load-bearing — it is the
justification for "nothing exercises this, verify on @gennetytestbot", and it
had quietly stopped being a statement about production and become a statement
about the last time someone checked.
**What it changes going forward:** the drop IS pairing real users weekly, and
both pairs died before a date (one ghosted to expiry, one cancelled) — that is a
product signal, not just a doc error. Re-measure the claim rather than copying
it. The narrower facts remain true and are what the blocks actually needed:
**0 dates ever**, `venue_selection_logs` 0 rows, `live_activity_tokens` empty —
so the venue geo-ladder, the Live Activity and the date-card path are still
genuinely unexercised in production.
**Recorded in:** deploy.md → the 2026-08-07 release block; corrected in every
block above the 2026-08-02 marker (older blocks left as historical record).

## 2026-08-07 — three dependency overrides had rotted below their advisories

**Kind:** deviation from plan
**What:** `pnpm security:audit` — a mandatory preflight gate — failed with 7
advisories during the 2026-08-07 release. Three existing `pnpm.overrides` entries
(`postcss` 8.5.18, `fast-uri` 3.1.4, `brace-expansion` 5.0.8) each sat exactly
one patch below a newly published advisory. I raised those three and added
`js-yaml` 4.3.1 and `ip-address` 10.3.1, which was not part of the requested
scope.
**Why:** the alternative was shipping past a gate this runbook calls mandatory.
The advisories were already live in prod (the lockfile had not changed since
2026-08-02), so the release did not introduce them — but skipping the fix would
have carried them another release and left the gate red for whoever ran it next.
Only the `ip-address` chain (`apps/bot > express-rate-limit`) reaches the droplet
runtime; the rest are `apps/video` build-time or `eslint` dev tooling.
**What it changes going forward:** an override is not a one-time fix. Re-check
the pinned versions against `pnpm audit` on every deploy — each of these three
was correct when written and looked deliberate right up to the moment it wasn't.
**Recorded in:** deploy.md → Preflight ("an override rots") and the 2026-08-07
release block; root `package.json` `pnpm.overrides`.

## 2026-08-07 — Type Radar shipped as a two-file hotfix ahead of the release

**Kind:** deviation from plan
**What:** the Type Radar gate fix (`e0079df`) went to production as a targeted
two-file patch about an hour before the 84-commit release that also contained it,
rather than waiting for the full preflight.
**Why:** it was the only backlog item actively blocking work — iOS onboarding was
impassable in production, which blocked the founder's live photo/verification
runs. deploy.md warns that a single-file rsync from a newer tree crash-loops prod
(the 2026-08-01 incident), and that warning is right in general. It did not apply
here for a checkable reason: **both files it touches are changed by exactly one
commit in the whole `7f19a72..c25adbc` range**, so prod's version plus `e0079df`
IS the target version and the patch pulls in no module prod lacked.
**What it changes going forward:** that ancestry check — `git log --oneline
<prod-sha>..<target> -- <path>` returning a single commit per file — is the
precondition for ever repeating this. A file touched by two commits does not
satisfy it. Also: stage the patch under a **`.hotfix.ts`** name, not `.ts.new`;
tsx refuses an unknown extension, so the mandated in-place import test cannot run
against a `.new` file.
**Recorded in:** deploy.md → the Type Radar block's "shipped ahead of the rest"
note.

## 2026-08-07 — deploying from an isolated worktree, and two backups rsync would have eaten

**Kind:** deviation from plan
**What:** the 2026-08-07 release was deployed from `git worktree add
/tmp/gennety-deploy c25adbc` rather than from the working tree, and preflight was
run there. Separately, the documented rsync flag set was found to destroy **two**
droplet-only database backups, not the one deploy.md mentions.
**Why:** a parallel session was writing the `/v1/*` proxy-chat server half in the
same checkout, and rsync copies the working tree — so deploying from it would
have shipped someone's unfinished module, and running preflight there would have
produced test numbers describing code that was not being deployed. The backup
hazard: `--exclude '*-backup-*.json'` appears only in a 2026-08-02 release note,
names only `ethnicity-backup-*.json`, and was **absent from the flag set itself**
— following the runbook literally also destroys the 3.3 MB
`prod-backup-2026-07-27T14-08-06-066Z.json`.
**What it changes going forward:** deploy from a clean worktree whenever the tree
is not yours alone. The exclude is now in the documented flag set in both the
dry-run and the real sync. A clean worktree also means `--delete` removes
accumulated junk — 176 of this release's 189 deletions were gitignored
`apps/video/{build,out}` artifacts that earlier deploys had shipped because the
exclude list covers `dist/` but not `build/` or `out/`. Read every deletion line
anyway; that is what separates junk from the `keys/` directory an earlier deploy
destroyed.
**Recorded in:** deploy.md → Deploy Full Server Code (flag set + the two backup
paths) and the 2026-08-07 release block.

## 2026-08-07 — both photo shimmers count, and "which flow did they ask about" was the wrong axis

**Kind:** founder decision + change of mind
**What:** both photo-upload shimmers — the onboarding media stage (§1.3) and the
§2.1 photo manager — now carry a singular script for a burst that is still one
photo. Shipped in two commits hours apart: I scoped the first to onboarding and
recorded the manager as a deliberate exclusion; the founder came back with the
manager, and the exclusion was wrong.
**Why the first cut was wrong, since that is the reusable part:** I drew the
boundary around the *flow the founder named* ("при регистрации") rather than
around the *defect*, and reasoned that the manager's copy is about uploading
rather than looking, so it was a separate decision. Two things were missing. The
manager is REACHED from registration — the §1.4 verification gate's "📷 upload
different photos" is the only photo surface a not-yet-verified account has, and
that is exactly where the founder was standing (`menuState=edit_photos`,
`onboarding_step=completed`) when they reported it a second time. And a lone
upload is the *usual* case there, not an edge one: you open the manager to
replace one bad photo. So the surface I called out-of-scope had the worse
version of the same false statement.
**What it changes going forward:** when a founder reports a copy or UX defect
against a named flow, check where else the SAME code path or the same sentence
is user-visible before scoping to what they named — particularly across the
onboarding/menu boundary, which users do not perceive as a boundary at all.
Mechanically: the two scripts per surface must stay the same LENGTH, because a
growing burst is revised in place beat for beat (`reviseStatusScript`, shared by
both). A count-neutral beat (the manager's "almost there") is one i18n key used
by both scripts, not two identical ones.
**Recorded in:** PRODUCT_SPEC.md §1.3 + §2.1, `services/analysis-status.ts`,
`services/ai-stream.ts`, `handlers/onboarding/conversational.ts`,
`handlers/menu/edit-profile.ts`.

## 2026-08-07 — ten Kyiv venues promoted to premium; the catalog file is not the prod DB

**Kind:** founder decision
**What:** Cafe Marko, Porto Maltese, Elevato, Кафе Fandom, SHO and Vicini
Italiani go into the Kyiv `premium` tier (Кувшин, Good Girl and La Veranda were
already there). Fandom and Elevato are an explicit reversal of the demotion
made on the same day in `e7d10d8`.
**Why:** that demotion argued they "read weaker than venues sitting free in
base, so paywalling them argues against the upsell". The founder now wants the
premium board to carry them regardless. No new evidence was produced against
the earlier reasoning — this is a preference change, not a correction, and the
next person reading `e7d10d8` should not treat it as still standing.
**What it changes going forward:** premium is now 46 unique Kyiv venues (230
rows). A future premium review must start from this list, not from the
2026-08-07 morning one.
**Recorded in:** commits `a117535`, `d205bbf`;
`scripts/curated-venues.kyiv.{additions,expansion,approved}.json`.

## 2026-08-07 — NIKA (Taryan Towers) deliberately not added

**Kind:** not done
**What:** the sixth venue in the second request was left out of the catalog.
**Why:** Google Places has no such venue. A nearby sweep of Taryan Towers
(вул. Іоанна Павла II 12) returns Дублер, Balcony and others but no NIKA, and
the only "Nika" restaurant text search offers sits in Tashkent. Guessing a
place id is the one failure this catalog cannot absorb: the row is a real
address a real couple is sent to, which is why `resolve-venues:kyiv` refuses
low-confidence name matches by design.
**What it changes going forward:** it needs the exact Google Maps link or the
venue's registered listing name before it can be added. Do not re-resolve it
from the name alone.
**Recorded in:** commit `d205bbf`.

## 2026-08-07 — venue catalog changes stop at the file; prod import is its own decision

**Kind:** founder decision
**What:** both premium batches changed only
`scripts/curated-venues.kyiv.*.json`. No `seed-venues:import` was run against
production.
**Why:** following the precedent set in `a204acf` ("catalog file only —
production DB import pending explicit approval"). It matters more than usual
right now: **prod still carries the pre-expansion catalog (127 venues / 538
rows) while the file holds 247 venues / 1238 rows**, because the 141-venue
expansion in `000bc16` was only ever imported into the demo DB. So an import
would land the whole expansion, plus five deliberate demotions, at the same
time as these ten promotions.
**What it changes going forward:** anyone running `seed-venues:import` against
prod is making that larger decision, whether or not they mean to. Check the
row-count gap first.
**Recorded in:** commits `a117535`, `d205bbf`; deploy.md has no PENDING block
for this — there is nothing to deploy.

## 2026-08-07 — tier drift between the catalog files is a real failure mode

**Kind:** deviation from plan
**What:** while promoting the requested venues I also back-propagated five
demotions (PAUL ×2, Волконський, The Burger, Дуже по-французьки) from
`approved.json` into `expansion.json`, and set the missing `tier` on Кувшин /
Good Girl in `additions.json`. None of that was asked for.
**Why:** `sync-venues:kyiv --check` was RED before this work, on exactly those
rows. The manifest is what a re-sync replays, so the next `--apply` would have
silently re-promoted all five demoted venues; and `additions.json` is what
`resolve`+`merge` replays, so a re-run would have sent Кувшин and Good Girl
back to base. Both are silent regressions that only surface as a wrong tier on
a live board.
**What it changes going forward:** a tier lives in three files and they drift.
Treat `sync-venues:kyiv --check` as the gate — it is green now (215 places ×
5 domains) and should be run after any tier edit.
**Recorded in:** commits `a117535`, `d205bbf`.

## 2026-08-07 — decision journal introduced

**Kind:** founder decision
**What:** every product decision voiced in conversation, plus any change of mind
or deviation from the plan during a task, is recorded in this file — in every
session, whatever the task.
**Why:** only files cross session boundaries. Several decisions during the iOS
stage-3/4 work existed solely as chat messages (what was deliberately skipped and
why, which alternatives were rejected), and a fresh session had no way to see
them.
**What it changes going forward:** writing the entry is part of the same turn and
the same commit as the work itself. Mirrored in the iOS repo; the file loads
automatically via `CLAUDE.md`.
**Recorded in:** `AGENTS.md` → "Documentation Impact Check", `CLAUDE.md`.
