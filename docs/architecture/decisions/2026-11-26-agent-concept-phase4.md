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

## Item 4 — Quiet hours for the campus drop and the T+24h prompt (built)

1. Both use the same Kyiv window as match nudges and re-engagement
   (`workers/quiet-hours.ts`, 23:00–09:00) and wait for the first tick after
   09:00. The zone is Kyiv on purpose: it is the window the other nudges use,
   and one market has one night.
2. The campus drop's hourly tick does nothing at night. Nothing is created
   either, so a pitch's 24-hour deadline never starts while the person sleeps.
3. The T+24h prompt (Telegram question and app push) is held; the match still
   turns `completed` on time, and `feedbackPromptedAt: null` keeps it due for
   the morning tick.
4. Demo mode: the demo runs no campus drop; the T+24h prompt follows the same
   window there.

## Item 5 — Announcements cap (built)

1. At most one announcement push per person in seven days
   (`ANNOUNCEMENT_PUSH_MIN_GAP_MS`). The inbox row is still written and stays
   unread.
2. **Decided in the build:** no new column. The cap reads the person's other
   inbox rows. A held row is marked handled with `pushedAt = createdAt`;
   a real push always lands after its row was written, so `pushedAt >
   createdAt` separates the two, and a held row can never extend the cap.
   A push APNs refused (no token) still counts, so the cap errs quiet.
3. Not capped: the admin preview (one founder-picked account).
4. Demo mode: the fan-out is not scheduled in demo; nothing changes there.

## Item 6 — The per-type mute «only my dates» (built)

1. Schema approved with the founder's answer: `users.notify_only_dates`
   (`BOOLEAN NOT NULL DEFAULT false`), additive migration
   `20261126120000_notify_only_dates`.
2. **What «my dates» means (decided in the build).** A message is about the
   person's own dates when it concerns a match they are in or a date they
   have: pitches (scheduled, campus, the app's drop push), match nudges,
   scheduling, venue and ticket flow, the date lifecycle, the proxy chat,
   cancellations, safety. Also never muted: verification (mandatory), refunds
   and billing notices, an idea reminder for a planned date, the personal
   reminders the person asked for, the agent's answers to their own turn.
3. Muted, each in its own sender: Profiler batches, onboarding
   re-engagement, announcement pushes (the inbox row is still written and
   held like the weekly cap), waiting notices, pushed Rematch offers (the
   person's own tap on the entry is always answered), the wishlist session
   push, idea reminders not tied to a planned match (cancelled), and
   referral-reward messages (the tickets are still credited).
4. Premium renewal reminders stay unmuted on purpose: for an auto-renewing
   period they are the notice before a charge.
5. One list for the next sender: `services/notification-mute.ts`.
6. Toggle in the bot's ⚙️ Settings and `PATCH /v1/me/notifications
   { onlyMyDates }` (OpenAPI). The Mini App has no settings screen (see
   item 1).
7. Demo mode: the same switch and the same senders; the demo runs fewer of
   them (no announcement fan-out, no waiting notices), so there is less to
   mute.

## Item 7 — The pinned countdown banner (kept)

Kept as it is, as recommended: it re-edits a message already on screen and
sends no notification. No code changed.

## Item 8 — Telegram memory (already built; tests added)

1. Checked first, as asked: the long-term-memory work (decision 2026-11-19,
   question 6.5) had already given the Telegram agent the app's person card,
   the memory block, the four memory tools and `search_past_chats` /
   `read_past_chat`, behind `AGENT_MEMORY_ENABLED` / `AGENT_MEMORY_USER_IDS`.
   It reached production dark on 2026-11-24.
2. Missing was only coverage. The wiring moved unchanged from
   `menu-agent.ts` into `services/telegram-memory-turn.ts` and is tested
   there: flag off gives the old turn, flag on gives card, block, note and
   tools, and a failing card drops only the card.
3. Not changed: the Telegram replay window (24 h, 12 messages). Nothing new
   is behind a new flag; the existing memory flag and preview ids gate it.

## Item 9 — Advisor phase 4 (waiting, deliberately not built)

The founder's decision is to wait: the agent does not write first after a
date until this block has settled with real users. When it comes it stays
event-only (`agent-advisor.md`). Recorded here so the next session does not
build it.

## Deploy

Not deployed. Production and both migrations wait for the founder's separate
«да» (`docs/operations/deploy-journal/pending.md`).
