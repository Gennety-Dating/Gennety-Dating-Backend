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
