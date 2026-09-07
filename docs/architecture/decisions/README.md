<!-- WHEN_TO_READ: BEFORE starting any task (the journal protocol is mandatory, see AGENTS rule below), and again before you record a new decision. This file is the protocol only — the decisions themselves are in the dated files listed below. -->
<!-- SOURCE: DECISIONS.md (lines 1-49) — migrated 2026-09-01 -->

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
> (`~/Desktop/Gennety-iOS`). Each repo's root instruction file loads automatically
> (here: `AGENTS.md`; this journal is now read on demand via `INDEX.md`, not imported).

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

## Where the entries live

The journal was one 11k-line file; it is now split by date. Newest first:

| File | Range | Entries |
|---|---|---|
| [2026-08-27_2026-09-01.md](./2026-08-27_2026-09-01.md) | 2026-08-27 .. 2026-09-01 | 40 |
| [2026-08-23_2026-08-26.md](./2026-08-23_2026-08-26.md) | 2026-08-23 .. 2026-08-26 | 42 |
| [2026-08-20_2026-08-22.md](./2026-08-20_2026-08-22.md) | 2026-08-20 .. 2026-08-22 | 44 |
| [2026-08-13_2026-08-19.md](./2026-08-13_2026-08-19.md) | 2026-08-13 .. 2026-08-19 | 36 |
| [2026-08-07_2026-08-12.md](./2026-08-07_2026-08-12.md) | 2026-08-07 .. 2026-08-12 | 93 |

**How to use it:** grep [INDEX.md](./INDEX.md) for your topic (it lists every entry title),
then open only the dated file it points to. Never read the dated files top to bottom.

**Adding a new entry:** append to the newest dated file above using the entry format
described in this document, and add one row to `INDEX.md`.
