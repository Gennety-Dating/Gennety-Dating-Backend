<!-- WHEN_TO_READ: You change the screenshot library routes with the flag off, idea reminders, the import period, or anything the 2026-11 backend audit of screenshots and ideas touched. -->

# 2026-11-02 — Backend audit of the screenshot library and ideas: behaviour changes

1 entry. Report: `docs/audits/2026-11-screenshots-backend-audit.md` (branch `audit/screenshots-backend`).

## 2026-11-02 — Three agreed behaviours tightened by the audit; one left for the founder

**Kind:** deviation from plan (audit fixes that change an API answer), and not done (one finding waits for a decision).

**What.**

1. With `SCREENSHOT_LIBRARY_ENABLED` off, `/v1/me/screenshots` still serves `GET` (state, list, one item; not
   `?q=` search) and every `DELETE`. Before, every route answered 404 `feature-disabled`, which contradicted the
   2026-11-01 rule that revoking and deleting work with the flag off and spec 01 §11.
2. `PUT /v1/me/memory/ideas/{id}/reminder` and the chat tool `set_idea_reminder` refuse with 409
   `needs-own-dates` when the idea is not usable for the person's own dates. Before, the reminder was accepted
   and the sender cancelled it silently at the due time, which is every reminder on a new idea.
3. An automatic upload whose `capturedAt` is older than the library's `rangeDays` answers 409 `out-of-range`.
   Only the phone applied the period before. A manual pick and a missing capture time are not limited.

**Why.** Each one made the server answer differently from what actually happens: a person who cannot delete after
a rollback, a «напомню» that never comes, and an import scope that only a correct client respected.

**Not done, for the founder.** The pair overlap can be probed: the viewer can save ideas with any `topic` or
`placeId` and see which ones come back as `shared`, which lists the partner's ideas allowed for their own dates,
one probe per request. Closing it changes what overlap means (for example a closed topic vocabulary, counting only
ideas saved before the pair's mutual yes, or requiring the partner's `partner` grant), so it is a product call.

**What it changes going forward.** A new screenshot route decides explicitly whether it is served with the flag
off. A consumer that drops a reminder at send time must refuse it at set time with the same rule.
iOS must handle `needs-own-dates` and `out-of-range` (listed in the report's iOS contract section).

**Recorded in.** `apps/bot/src/public/routes/screenshots.ts`, `apps/bot/src/services/memory-planning.ts`,
`apps/bot/src/services/screenshot-library.ts`, `openapi/gennety-v1.yaml`, `docs/product/domains/screenshot-library.md`,
`docs/product/domains/memory-ideas.md`. Nothing deployed; both flags stay off.
