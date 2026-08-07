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
