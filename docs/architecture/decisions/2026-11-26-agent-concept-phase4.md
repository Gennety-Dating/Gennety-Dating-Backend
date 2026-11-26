<!-- WHEN_TO_READ: You are touching what Gennety sends on its own — Profiler batches and their off switch, onboarding re-engagement, the expired-match notice, campus drop / T+24h quiet hours, announcement pushes, the «only my dates» mute, `GET/PATCH /v1/me/notifications` — or you wonder why advisor phase 4 is not built. -->

# 2026-11-26 — agent concept phase 4: the proactive senders

**Kind:** founder decision («Да, внедряй» on 2026-11-26 to all nine
recommendations of `docs/product/domains/agent-concept.md` phase 4, as
written). The answer also approves the schema field of item 6.

**Why.** The 2026-11-19 audit found that the spam comes from the product's
proactive senders, not from the agent. Each item below changes one of them.

## Item 1 — Profiler batches in Telegram (built)

1. Two ignored Telegram questions in a row pause Telegram batches for 14 days.
   - «Ignored» is a question the stall sweep reclaims with no answer and no
     skip. Only a question that sat in the Telegram chat counts; one the app
     opened was never pushed at anyone.
   - Any answer or skip, on either surface, resets the count.
   - At the limit the count starts over, so the pause never silently extends.
   - Constants `PROFILER_IGNORED_BATCHES_LIMIT` (2) and
     `PROFILER_IGNORED_PAUSE_MS` (14 days).
   - The app's own pull (`GET /v1/me/profiler`) is not held by the pause: the
     person opening the app is not being pushed into.
2. «Не спрашивай больше» is a real off switch.
   - A whole-utterance list (`isProfilerStopRequest`, five languages) is
     checked before the refusal list. A bare «не спрашивай» stays a one-off
     refusal; only an explicit «больше» / «anymore» / «хватит вопросов»
     switches the Profiler off. Some of those phrases used to be refusals.
   - Typed in Telegram or in the app, it is recorded as a skip and the
     switch is set. Telegram answers with one line naming Settings.
   - While off, no Profiler question is asked on either surface: the worker
     sends nothing and `GET /v1/me/profiler` answers `{}`. Answers already
     given stay and keep feeding icebreakers and hints.
3. **Decided in the build (deviation from the brief):** the brief said
   «Mini App settings». The Mini App has no settings screen; Telegram's
   settings are the bot's ⚙️ Settings menu. The toggle («💬 Вопросы о тебе:
   вкл/выкл») is there, and the API is `GET/PATCH /v1/me/notifications`
   `{ profilerQuestions }` for the iOS settings screen. No new Mini App screen
   was built.
4. Schema: additive migration `20261126100000_profiler_pause_off_switch`
   (`profiles.profiler_ignored_streak`, `profiler_paused_until`,
   `profiler_opted_out_at`).
5. Demo mode: the same. The demo bot runs the same worker and menu; a visitor
   who says «не спрашивай больше» gets the same switch, and it goes with the
   demo reset.

## Item 2 — Onboarding re-engagement (built)

1. At most five touches per account, for life. `reEngagementStep` is now the
   lifetime count: `onboardingActivityPatch` no longer resets it, it only moves
   `lastMessageAt` (the anchor) and wakes the worker 15 minutes later.
2. The worker re-times a touch woken early to its own slot from the new
   anchor (`touchTimeFor`), and parks a spent chain (`reEngagementNextAt =
   null`) without a send. No schema change.
3. The LLM brief changed from «bring them back» to «name the one step left»:
   no «come back», no «we miss you», and the fifth touch lets them go. The
   Telegram fallbacks (used only when the model call fails) are unchanged.
4. Not changed: the verification-stall reminder, which the audit kept; it
   still re-arms at the verification CTA.
5. Demo mode: the demo bot runs the same worker; nothing to branch.

## Item 3 — Paid offers on care messages (built)

1. The expired-match notice no longer sends the Rematch offer. Rematch stays
   on the screen: the pinned banner entry and the concierge.
2. Kept as they are: the next-date discount on the waiting notices
   (`no-match-notifier.ts`), and the Rematch offer after an explicit decline,
   which is the product's own pull moment and was not part of this item.
3. Demo mode: the demo has no paid Rematch to sell; nothing to branch.
