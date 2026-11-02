<!-- WHEN_TO_READ: Before turning on SCREENSHOT_LIBRARY_ENABLED or MEMORY_IDEAS_ENABLED, before changing the screenshot library or ideas on the server, or when the iOS audit needs the backend's findings and contract changes. -->

# Backend audit: screenshot library and the ten integrations («memory ideas»), 2026-11

Branch `audit/screenshots-backend`, from `origin/main` at `4cd7f595`. Backend only; the iOS client is audited
separately. Brief: `docs/product/specs/screenshots/03-audit.md` (sections 1–14, backend scope). Expected behaviour:
`01-implementation.md`, `02-integrations.md`. Later explicit decisions that override the specs, and were used here:
`docs/architecture/decisions/2026-10-31-screenshot-library.md`, `2026-11-01-memory-ideas.md`,
`2026-11-01-screenshot-agent-coverage.md`. New entry: `2026-11-02-screenshots-backend-audit.md`.

This audit does not claim to have found every defect. Coverage and what was not checked are stated below.

## 1. Scope, versions, environment, depth

1. Code read in full: `public/routes/screenshots.ts`, `public/routes/memory.ts`, `services/screenshot-library.ts`,
   `services/memory-ideas.ts`, `services/memory-planning.ts`, `services/chat-screenshots.ts`,
   `services/chat-memory.ts`, `services/chat-consent.ts`, `services/event-check.ts`, `workers/screenshot-library.ts`,
   `workers/memory-ideas.ts`, the two migrations, `packages/shared/src/memory-ideas.ts`, `screenshots.ts`
   constants, the screenshot parts of `services/storage.ts`, `services/chat-agent.ts` (tool loop, consent gate, card
   handling), `services/chat-wishlist.ts` (idea links), `workers/embedding-refresh.ts` (preference consumer),
   `services/account-deletion.ts` (screenshot bucket), rate limiters and the router mounts.
2. Read for context only: the Share route (no idea or library code in it), venue-intent and venue-change consumers,
   Style Picks digest, push and quiet hours.
3. Runtime: Node v26.7.0 locally (repo targets Node 20; all suites pass on 26), pnpm 10.33.0, Prisma 6.19.3,
   PostgreSQL 16 + pgvector in a private local Docker container (`pgvector/pgvector:pg16`, loopback port 5433,
   schema from `db:push`). macOS, 16 GB.
4. Flags: `SCREENSHOT_LIBRARY_ENABLED` and `MEMORY_IDEAS_ENABLED` off by default and off in production (nothing of
   this is live). Tests turn them on through mocked `env` where needed.
5. No production access, no deploy, no real push, no purchase, no OpenAI or Supabase call. Storage and the model are
   stubbed; `OPENAI_API_KEY` is the test placeholder. No migration was added.
6. Depth: every server entry point that reads or changes library or idea data was traced to its queries; confirmed
   findings were reproduced on a real database or through the real route/agent code with stubs.

## 2. Readiness verdict

Code-level readiness of the backend improved; the features are still not ready to switch on in production.

Blockers before turning the flags on (none of them is a code defect left unfixed by this audit, except F-03):

1. F-03, the pair-overlap probe, needs a founder decision before `MEMORY_IDEAS_ENABLED` goes on.
2. F-11, indexing capacity: one tick indexes 6 items, about 8,600 a day for the whole service, shared newest-first.
   Acceptable for a small pilot, not for a public launch with 2,000-item first imports.
3. Open items from the 2026-10-31 decision remain: the private bucket must exist, the search distance limit
   (`SCREENSHOT_MATCH_MAX_DISTANCE = 0.72`) is still not measured with the real embedding model, real token counts
   are not measured, the policy text needs legal review, and `check_event` has never run against the live provider.
4. iOS must handle the two new 409 codes (section 9) before the flags go on.

## 3. Findings registry

Severity counts: High 0; Medium 3 (F-01, F-02, F-03); Low 7 (F-04, F-05, F-06, F-07, F-08, F-09, F-12);
informational / not fixed 4 (F-10, F-11, F-13, F-14). Fixed and verified: 9. Not fixed: 5 (one needs a founder
decision, four documented with reasons).

### F-01 — Medium — flag off strands the person's data (fixed and verified)

1. Category: data rights / rollout. Scenario: the library flag is turned off after rollout (rollback).
2. Where: `apps/bot/src/public/routes/screenshots.ts` (router-level flag check, before the fix lines 31–37).
3. Evidence: with the flag off every route answered 404 `feature-disabled`, including `DELETE /library`
   (disconnect and delete) and `DELETE /{id}`. Regression test `src/public/routes/screenshots.test.ts` fails 4 of 6 on
   the old router.
4. Expected (spec 01 §11, decision 2026-11-01 for ideas): switching a feature off never removes the ability to see
   and delete what is stored. Actual: nothing could be deleted through the API; only the cron purge kept running.
5. Root cause: one blanket flag middleware. Fix: `stillServedWhenOff` keeps `GET` (without `?q=`) and `DELETE`
   served; connect, upload, commit, reconcile and search still stop.
6. Verification: route tests with supertest, flag off and on, token still required.

### F-02 — Medium — a reminder that is accepted and never sent (fixed and verified)

1. Category: false success / notifications. Scenario: «Напомни вовремя» on a dated idea.
2. Where: `apps/bot/src/services/memory-planning.ts` `setReminder` (now line 449) against
   `apps/bot/src/workers/memory-ideas.ts` `sendDueReminders` (cancels when `!usableForOwnDates`).
3. Evidence: a new idea has no uses granted. `setReminder` resolved `{ dueAt }`, the chat tool answered success, and
   at the due time the sender cancelled it with no push. Repro: `screenshots-audit.integration.test.ts`, block F-02,
   failed on the old code («promise resolved … instead of rejecting»). The pre-existing test granted `own_dates`
   first, which hid it.
4. Impact: every reminder on an idea the person had not also allowed for their own dates was silently lost.
5. Fix: `setReminder` refuses with 409 `needs-own-dates` using the same `usableForOwnDates` rule as the sender; the
   chat tool explains it; `setEventDate` no longer throws on a closed wish. OpenAPI updated.
6. Verification: integration tests (refusal, granted path delivers exactly one push, chat tool reports the refusal);
   existing reminder tests still pass.

### F-03 — Medium — pair overlap can be probed to list the partner's ideas (not fixed: founder decision)

1. Category: disclosure between a pair. Scenario: both said yes (`negotiating`, `negotiating_venue`, `scheduled`).
2. Where: `apps/bot/src/services/memory-planning.ts` `pairOverlap` (line 148); `topic` and `placeId` are free strings
   from the client (`apps/bot/src/public/routes/memory.ts` lines 133–135) and from the chat tool.
3. Evidence (local, synthetic): partner B allowed two ideas for own dates, topic `ceramics` and place `gp-loza`.
   Viewer A saved nine probe ideas one by one with candidate topics and place ids, granted `own_dates`, called
   `GET …/matches/{id}/planning`, and deleted each probe. Exactly `ceramics` and `gp-loza` came back as `shared`,
   in nine calls. The probe test was run once in a scratch file and not committed, because it asserts the
   current, unwanted behaviour.
4. Expected (spec 02 §7): only an allowed formulation of a shared idea; private wishes and their existence stay
   hidden. Actual: B's `own_dates` grant becomes, through fabricated ideas, a disclosure that the separate `partner`
   grant was meant to control. Rate limit 120 requests a minute per person bounds speed only.
5. Why not fixed: every fix changes what overlap means. Options for the founder: a closed `topic` vocabulary and
   catalog-only `placeId`; count only the viewer's ideas saved before the pair's mutual yes; require B's `partner`
   grant for overlap; or cap distinct probes per pair. Recommended: the first two together.

### F-04 — Low — upload reserved during «Отключить и удалить» survives it; cap race (fixed and verified)

1. Category: race / deletion. Where: `services/screenshot-library.ts` `reserveUpload` (lock at line 269).
2. Evidence: a transaction holding the library row (the same first statements as `disconnectLibrary`) was kept open at
   a barrier while `reserveUpload` ran. Old code: the reservation finished during the pause and left a live row in a
   closed library; after reconnecting, the same bytes returned that stale row and commit answered 404 until the
   24-hour sweep. Separately, three concurrent reservations at 1,999 of 2,000 items produced two successes in one
   run (not every run: a timing race).
3. Fix: the insert runs under `SELECT … FOR UPDATE` on `screenshot_libraries`, re-checking status, generation,
   pause and auto-import, and counts the cap there (after hiding the replaced version).
4. Verification: barrier test passes 5 of 5 runs; cap test one success of three; unit tests updated.

### F-05 — Low — indexer pays for whatever bytes are stored, unchecked (fixed and verified)

1. Category: upload validation / cost. Where: `workers/screenshot-library.ts` `indexOne` (line 274), `reindexOne`.
2. Evidence: the signed upload URL is `x-upsert` and stays valid after commit, so bytes can be replaced after commit
   validated them. The worker sent the stored object to the vision model without a check. Repro test fed HTML bytes:
   the model stub was called once on the old code.
3. Impact: owner-only (the bucket is private), but a paid call per replaced object and arbitrary content in the
   model input. Fix: the same `isAcceptableImage` check before any paid call; failure is final for that row.
4. Verification: integration test; existing worker tests now use valid PNG headers.

### F-06 — Low — screenshot card reported as shown when it was dropped (fixed and verified)

1. Category: AI tool result vs reality. Where: `services/chat-agent.ts` screenshot branch (line ~826).
2. Evidence: with another card already under the reply, or a second `show_screenshots` in the turn, the card was
   dropped (or replaced the first) while the tool answered success and «the cards are under your reply»; a
   «connect» button could be promised the same way. Unit tests failed 2 of 2 on the old code.
3. Fix: such a call answers `one_card_per_reply`, as the other card tools already did.

### F-07 — Low (Medium at scale) — cancelled plans never released past the first page; N+1 tick (fixed and verified)

1. Category: data integrity / performance. Where: `services/memory-planning.ts` `reconcilePlans` (line 398).
2. Evidence: the release pass read the first 200 planned ideas in no order and filtered in memory. Ideas planned
   for completed dates stay planned, so once they fill that page a cancelled date never gives its wish back. Repro
   with `limit = 2` and six completed plans: `released` was 0 in 3 of 3 runs on the old code. The planning pass ran one
   query per booked date every minute.
3. Fix: one SQL join selects only plans whose match is missing, cancelled, expired or moved; one query reads the
   candidate ideas of all booked dates.
4. Measurement in section 7: 203 statements to 3 per idle tick with 200 booked dates.

### F-08 — Low — retries with the same Idempotency-Key fail after success (fixed and verified)

1. Category: at-least-once. Where: `services/memory-ideas.ts` `change`, `mergeIdeas`, `splitIdea` (`afterRace` line 304).
2. Evidence on the old code: a merge repeated after a lost answer → 404 `not-found`; a split → 400 `bad-split`; two
   concurrent changes with one key → one success and one rejection (409, or 500 from the key's unique index).
3. Fix: a recorded key returns the first attempt's result, also after a lost race.

### F-09 — Low — lint red at baseline, including a layering violation (fixed and verified)

`pnpm lint` failed with 4 errors in feature files: two unused imports and `services/chat-screenshots.ts`,
`services/event-check.ts` importing `public/usage-middleware.ts`. `isOverTokenBudget` moved to
`services/usage-budget.ts`, re-exported by the middleware. Lint is green.

### F-12 — Low — chosen import period enforced only by the phone (fixed and verified)

`reserveUpload` stored `rangeDays` but accepted any `capturedAt`. Automatic uploads older than the period now answer
409 `out-of-range`; manual picks are not limited. Integration test.

### F-10 — Informational — listing cursors skip rows that share a millisecond (not fixed)

`listItems` (`services/screenshot-library.ts`, `createdAt < before`) and `listIdeas` (`updatedAt < before`) page by a
millisecond timestamp only; rows with the same timestamp as the page's last row are skipped. Needs a compound cursor,
which changes the `nextBefore` contract shared with iOS. Low likelihood (distinct requests rarely share a
millisecond). Left for a contract change agreed with iOS.

### F-11 — Informational — indexing capacity (not fixed: capacity decision)

`INDEX_BATCH = 6` per one-minute tick, global, newest first across all libraries
(`workers/screenshot-library.ts` line 33). See verdict. Raising it multiplies vision spend per minute; the Batch API
path for old archives (decision 2026-10-31) is not built.

### F-13 — Informational — `check_event` can write its verdict to an unrelated idea (not fixed: needs a rule)

`chat-screenshots.ts` line 426 applies the verdict to any idea id the model passes, with no check that the idea is an
event or matches the checked name. Owner-scoped, so no cross-account effect; a wrong id can give an idea a
`confirmed` date it does not have. A guard needs a rule (kind `event` only? title match across languages?).

### F-14 — Informational — dates without a time (not fixed)

`applyEventCheck` stores a date-only event as 12:00 UTC (`memory-planning.ts` line 524), `memoryIdeaFitsPlan` allows
12 hours between event and date (`packages/shared/src/memory-ideas.ts` line 173), and `checkEvent` compares with the
UTC day (`event-check.ts` line 331). In Europe these agree; in UTC−6 and beyond an evening date drops a same-day
event, and in UTC+12 and beyond the stored day shifts. Matters only with a second market.

## 4. Confirmed correct (evidence, no defect)

1. Two-account isolation: one integration test drives B with A's known ids through `readItem`, `deleteItem`,
   `listItems`, `read_screenshot`, `view_screenshot`, `show_screenshots`, `search_screenshots`, `getIdea`, `setUsage`,
   `setReason`, `removeSource`, `mergeIdeas` both ways, `deleteIdea`, `saveIdea` with A's screenshot as source,
   `listIdeas`, the `grant_idea_use` tool and `planningSuggestions` on A's match. All answer as for a missing id and
   A's rows are unchanged. Owner filters are in every SQL statement before ranking.
2. Disconnect closes in one transaction: rows hidden with text and hash cleared, ideas resting only on screenshots
   closed, an idea with another source kept, chat tools see nothing.
3. SQL: all raw queries are parameterised; the search's regex words are escaped and length-capped. No server-side
   fetch of URLs from OCR, the model or Share exists (the only web access is the provider's `web_search`), so there is
   no SSRF surface in this scope.
4. Consent: widening a use, saving, deleting, preferences and reminders pass the strict consent check in chat, which
   fails closed; narrowing runs at once. Idea uses default to off; `actor: system` cannot grant.
5. Account deletion lists and removes every object under `${userId}/` in the screenshot bucket; tables cascade.
6. Sensitive preference words are refused on every path (existing tests).

## 5. User-path trees (server side)

Legend: works; works with friction; defect (now fixed); not verified; needs product decision.

1. Library connect → upload → index → search → card → delete.
   1. Connect with the current consent version: works. Old version: 409 `consent-required`, works.
   2. Reserve: duplicate bytes, works; excluded source, works; paused, works; racing disconnect, defect F-04 (fixed);
      older than the period, defect F-12 (fixed); cap, works (race fixed).
   3. Commit: bad bytes hidden, works; missing bytes retryable, works; repeat, works.
   4. Index: retries with back-off, stuck rows requeued, late answer after delete changes nothing, works; replaced
      bytes, defect F-05 (fixed); throughput, F-11 (decision).
   5. Search: words then meaning with owner filter, works; negatives answer nothing on the word path (held-out set);
      meaning threshold, not verified (needs the real model).
   6. Chat card: restored from ids, deleted shows as unavailable, works; dropped card claimed shown, defect F-06 (fixed).
   7. Delete one: hidden at once, exclusion stops re-import, hand pick brings it back, works.
   8. Disconnect: closes at once, purge later, `counts.deleting` shows progress, works; with the flag off, defect F-01 (fixed).
   9. Signed URL after delete: valid until its 1-hour expiry or until the purge removes the object, whichever is first;
      the product text should not promise instant unavailability (not a defect, stated).
2. Function 1, reason: question list, snooze, skip, gift/reference clear uses, works.
3. Function 2, one idea from many sources: canonical joins, same-name candidates, merge, split, works; retries,
   defect F-08 (fixed). Edited screenshot (new version) closes an idea that rested only on the old version: needs
   product decision (Q4).
4. Function 3, map: catalog points only, no invented coordinates, works.
5. Function 4, planning: allowed wishes minus known mismatches, `needsCheck`, works; date-only events, F-14.
6. Function 5, pair overlap: stage and block gates work; probe, F-03 (decision); overlap during the unpaid Date
   Ticket gate, needs product decision (Q2).
7. Function 6, preferences and matching: confirmed preference with its own grant reaches the embedding, revocation
   marks the profile dirty, works. The idea-level `matching` and `partner` grants have no consumer (Q1).
8. Function 7, Style Picks and memo: words only, owner only, works. Briefing and Tempo Sync are not read by this code.
9. Function 8, impression: only after a confirmed visit, place/format apart from the person, works.
10. Function 9, reminders: set without the needed use, defect F-02 (fixed); one per occasion, gap, quiet hours,
    re-read at send, works; push opt-out and a cross-feature push budget do not exist in the project (Q3).
11. Function 10, plain-language management: chat tools validate ids and enums server-side, works; wrong idea for
    `check_event`, F-13.

Not verified at all: anything on the device (PhotoKit, background tasks, local queue), the live model's tool choices
and prompt-injection resistance (prompt evals were not run), Supabase bucket settings, real latency on production
hardware.

## 6. Commands and results

Baseline at `4cd7f595` and final at the branch head, same machine and database:

1. `pnpm typecheck`: baseline pass; final pass.
2. `pnpm lint`: baseline fail (4 errors, F-09); final pass.
3. `pnpm --filter @gennety/bot test`: baseline 479 files / 7,732 tests passed; final FINAL_UNIT.
4. `pnpm --filter @gennety/shared test`: baseline 27 / 454 passed; final FINAL_SHARED.
5. `pnpm --filter @gennety/bot test:integration` (needs the local test database): baseline 12 / 139 passed; final
   FINAL_INT.
6. `npx @redocly/cli@1.34.5 lint openapi/gennety-v1.yaml`: final FINAL_OPENAPI.
7. Regression files added: `apps/bot/src/services/screenshots-audit.integration.test.ts`,
   `apps/bot/src/services/screenshot-search-holdout.integration.test.ts`,
   `apps/bot/src/public/routes/screenshots.test.ts`, and new cases in `chat-agent-screenshots.test.ts`.

Reproduce the database: `docker compose -f docker-compose.test.yml up -d`, then `pnpm test:db:push`.

## 7. Measurements

Conditions: local PostgreSQL 16 in Docker on the same Mac, synthetic rows only, warm process, no other load. Statement
counts from `log_statement = all` between markers; timings with logging off. Command:
`pnpm --filter @gennety/bot exec tsx evals/screenshot-audit/bench.ts` with the local test `DATABASE_URL` and the
dummy env the unit tests use.

1. `reconcilePlans`, 200 booked dates, nothing to plan (the per-minute idle case): before 203 statements per tick,
   9 runs, median 116 ms (range 81–180); after 3 statements, 9 runs, median 14 ms (range 8–22). Correctness: same
   results on the existing integration tests, plus the F-07 regression.
2. `indexBatch` with an empty queue over 200,000 items in 100 libraries: 5 statements, 9 runs, median 15–36 ms across
   two sessions. Not a bottleneck; not changed.
3. Retrieval, word path only, on the held-out set (16 queries, 12 with answers, 4 negatives; never used for tuning):
   recall at page size 0.75, precision 1.0, negatives answered 0 of 4; someone else's and a deleted row never
   returned. Misses: a typo («Sakra»), an English plural against a singular («ceramics»), and two queries that only
   meaning search could answer. Meaning search was not measured (needs the embedding model); the sample is small and
   the figures describe this set, not production quality.

## 8. Product questions and improvements (not defects)

1. Q1. Idea-level `matching` and `partner` grants are stored and shown but nothing reads them; only confirmed
   preferences reach matching, and the wishlist never reads `partner`. Should the switches be hidden until a consumer
   exists, or should a consumer be built?
2. Q2. `negotiating` also covers the unpaid Date Ticket gate. Should overlap and planning ideas wait for the ticket?
3. Q3. Reminder pushes put the idea title on the lock screen and have no global push budget across features (none
   exists in the project). Is the title acceptable, or should the body be generic?
4. Q4. An edited screenshot is a new version; the sweep then closes an idea that rested only on the old version,
   losing the person's stated intent. Re-pointing the source to the new version would keep it. Change the agreed rule?
5. Q5. F-03 options (section 3).
6. Improvement, safe: search word stems ignore English plurals; a light plural fold would fix «ceramics», measured by
   the held-out set. Not done (changes search behaviour, wants the meaning-path numbers first).
7. Improvement, safe: `dateMemo` reads ideas one by one (up to 20 queries); batch when it matters.

## 9. iOS contract changes

1. `PUT /v1/me/memory/ideas/{id}/reminder`: new 409 `needs-own-dates`.
2. `POST /v1/me/screenshots/uploads`: new 409 `out-of-range` for `source: auto` older than `rangeDays`.
3. With `SCREENSHOT_LIBRARY_ENABLED` off: `GET /v1/me/screenshots/library`, `GET /v1/me/screenshots` (without `q`),
   `GET /v1/me/screenshots/{id}`, `DELETE /v1/me/screenshots/library` and `DELETE /v1/me/screenshots/{id}` now answer as
   with the flag on instead of 404 `feature-disabled`.
4. No schema or field changed; OpenAPI descriptions updated for 1 and 2.

## 10. Changed components, external settings, rollout

1. Changed: `public/routes/screenshots.ts`, `public/usage-middleware.ts`, `services/usage-budget.ts` (new),
   `services/screenshot-library.ts`, `workers/screenshot-library.ts`, `services/memory-ideas.ts`,
   `services/memory-planning.ts`, `services/chat-memory.ts`, `services/chat-agent.ts`, `services/chat-screenshots.ts`,
   `services/event-check.ts`, `openapi/gennety-v1.yaml`, two domain docs, one decision entry, tests and evals listed
   above. No migration.
2. External settings unchanged and still required: the private screenshot bucket (and a file-size limit on it), the
   OpenAI key for vision and embeddings, the legal text.
3. Rollout: code on branch `audit/screenshots-backend` only, not merged, not deployed. Both flags off. Code ready
   is not settings applied and not released.
