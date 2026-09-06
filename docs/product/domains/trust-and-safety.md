<!-- WHEN_TO_READ: You are changing reports, strikes, or blocking (Phase 5). Read before any change that can hide, ban, or restrict a user. -->
<!-- SOURCE: PRODUCT_SPEC.md (lines 6891-7000) — migrated 2026-09-01 -->

## Phase 5 — Trust & Safety (Reports + Strikes)

Post-match the bot offers `[Report]` (callback `report:open:{matchId}`).
Free-text reason is LLM-triaged into a `tier`:

| Tier | Meaning | Action (`services/moderation.ts`) |
|---|---|---|
| **1 — Preference** | Personal preference mismatch, not unsafe | Append to *reporter's* `negativeConstraints`. No penalty on reported. |
| **2 — Ethical** | Unethical / boundary issues | `reported.strikes += 1`. **Strike 1** → warning DM. **Strike 2** → `status = suspended`, `suspendedUntil = now + 14 d`. **Strike ≥3** → `status = banned`. Cancel in-flight matches at strike ≥2. |
| **3 — Safety** | Safety threat | `status = pending_investigation` immediately, cancel in-flight matches, report row stays `adminReviewed = false` for the manual queue. |

**The reported category bounds the tier in BOTH directions (2026-07-26).** The
reporter picks a category, and that category sets a floor *and* a ceiling; the
LLM only refines within the band. The floor has always existed (the classifier
can never downgrade below what the category implies). The ceiling is new, and
closes a real escalation path: the classifier's only input beyond the category
label is the reporter's free text, so before this a reporter could choose the
mildest category and write text engineered to produce Tier 3 — freezing an
innocent partner's account and cancelling their in-flight matches on the
classifier's word alone. **Tier 3 is now reachable only from the three
categories the reporter themselves marked safety-grade** (`wrong_person`,
`unsafe_red_flag`, `spam_or_fraud`), where floor and ceiling coincide and the
LLM has no say. `fake_photos` / `offensive_behavior` / `inappropriate_profile`
cap at 2; `other` caps at 2 as well — an unclassified free-text report can still
produce a strike, but cannot auto-freeze anyone. Nothing is lost for genuine
safety reports filed under a mild category: Tier 2 already suspends at strike
≥2, and the row reaches the moderation queue either way. The report text is
additionally fenced as untrusted data in the triage prompt, but the clamp — not
the prompt — is what bounds the outcome.

**Every step of the report flow can be backed out of, and the details step stops
owning the chat (2026-08-03).** Choosing a category put the session into
`awaiting_report_details`, where the next plain message became the report body —
with no deadline, and nothing that ever released the state. Two consequences,
both real: an abandoned report turned a user's **next unrelated message, days
later, into a filed report** on their partner (LLM-triaged, up to a strike or a
suspension); and the step offered no way out at all — the category screen has a
"← Back" (`rb:`), but the details screen had only "send without details", and
for **Other** literally no button, so the only exits were filing something or
walking away and leaving the claim open. The details prompt now carries that
same cancel on every category, and the claim expires after an hour or the moment
the user taps anything that isn't one of its own buttons (shared with the
emergency-reason and feedback paths — see §Phase 4 → Emergency Protocol).

Other safeguards:
- `(reporterId, matchId)` is unique — duplicate reports rejected at write
  time and surfaced as `reportDuplicate` to the user.
- `autoUnsuspendElapsed` runs hourly so a 14-day Tier-2 suspension that
  expires mid-week reactivates within the hour rather than waiting for the
  next Thursday batch.
- `MatchEvent` rows (`ACCEPTED`, `DECLINED`, `EXPIRED_SILENT`,
  `EXPIRED_PEER_IGNORED`, `CHEMISTRY_POSITIVE`, `CHEMISTRY_NEGATIVE`) drive Elo
  updates and the admin dashboard's behavioural views. The enum also declares
  `PROPOSAL_SHOWN` and `DATE_COMPLETED`, and **nothing writes either**
  (ARCHITECTURE.md → `match_events`) — a completed date leaves no
  `DATE_COMPLETED` row, so read completion from `Match.status`. Emergency
  cancellation's small peer boost is applied directly by
  `handlers/date/emergency.ts` and does not increment `eloMatchesPlayed`.

### Blocking (2026-08-23)

A **block is not a report**, and the separation is the design. A report is an
accusation addressed to moderation: it carries text, gets triaged into a tier,
and can cost the reported person a strike, a suspension or their account. A
block carries nothing, accuses nobody, and reaches no queue. A person who is
frightened of the human being they just met must be able to make them go away
without first building a case — and App Store guideline 1.2 requires the
product to offer both.

`POST /v1/matches/:id/block` — the match is the handle, because with no browsing
and no user-to-user chat a match is the only way two people ever meet here, and
the client is never handed a bare user id. Three effects, in order:

1. **The boundary is recorded** (`user_blocks`, unique on
   `(blocker_id, blocked_id)`, so a retry is the same row). Directional in
   storage — the blocker's list must show and undo it — and symmetric in every
   consumer.
2. **A live match between the two is cancelled**, through the same rail a freeze
   uses (`claimMatchCancellation` → `deliverCancelledPartnerEffects`): tickets
   go back to whoever paid, the partner receives the ordinary cancellation
   notice. Without this the button would be a lie — the blocked person would
   still be at the venue at eight. A block filed on a match that already ended
   cancels nothing, and **never touches a live date the blocker has with
   someone else**.
3. **The proxy chat closes** as a consequence, not as a separate rule: that
   window is gated on `status = "scheduled"`.

**The blocked side is never told.** No DM, no push, no visible state change
beyond the ordinary "your date was cancelled". That is what makes the button
safe to press.

**On matching the block is redundant today and load-bearing tomorrow.** The
lifetime pair ban already guarantees two people who have matched are never
paired again, so a block filed from a match changes nothing about the pool right
now. It is enforced anyway, in both directions, in `buildCandidateSql` and in
the batch's `loadExcludedPairs` — because the ban is a product decision under
periodic review (REMATCH_PRODUCT_SPEC.md circles it every time) and a block is a
promise to a user that must survive such a revision.

`GET /v1/me/blocks` returns a first name and a date and nothing else: enough to
recognise a mistake and undo it, no more. It never reveals who blocked THIS
user — that direction is not readable by anybody.
`DELETE /v1/me/blocks/:userId` removes the record only; the cancelled date is
not restored, and the two stay apart under the lifetime ban regardless.

**Entry point is iOS-only for now.** The effect is server-side and therefore
applies to both surfaces, but the Telegram bot has no Block button yet. Explicit
decision, not an accident of where the code was written (DECISIONS.md
2026-08-23) — Telegram gets it in its own slice.
