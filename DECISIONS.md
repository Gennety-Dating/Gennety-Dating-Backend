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

## 2026-08-07 — Premium moves to 750⭐/$17.99 with the App Store left behind on purpose

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

## 2026-08-07 — the onboarding photo shimmer counts; the photo manager stays as it is

**Kind:** founder decision + deviation from plan
**What:** the onboarding upload shimmer gets a singular script for a one-photo
burst; the plural one is kept for two or more. Scoped to onboarding — the §2.1
photo manager's identical plural-for-one wording ("Загружаю фотографии…") was
deliberately left alone.
**Why:** the founder noticed the effect firing in the plural when they had sent
a single photo, which reads as the bot miscounting what it was just handed. The
manager was excluded because it is a different flow with different copy (about
*uploading*, not looking) and was not what was asked for; widening the change is
the founder's call, not mine.
**What it changes going forward:** the two scripts must stay the same LENGTH.
The burst can grow after the shimmer starts (photos sent one at a time join the
same batch), so the handler revises later beats in place, beat for beat — a
length mismatch would silently drop one. Two tests pin this: equal length/cadence
per language, and `runStatusSequence` reading each step's text at its own
transition rather than snapshotting up front. That read-per-transition behaviour
was previously incidental and is now a contract.
**Recorded in:** PRODUCT_SPEC.md §1.3 (media stage), `services/analysis-status.ts`,
`handlers/onboarding/conversational.ts`, `services/ai-stream.ts`.

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
