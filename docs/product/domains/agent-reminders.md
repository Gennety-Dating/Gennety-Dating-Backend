<!-- WHEN_TO_READ: You are changing personal reminders the agent sets on request («напомни в пятницу написать ей») — how they are created in the chat, stored, delivered by the worker, answered («Сделано», «Напомни завтра»), listed or cancelled, or the `remind` suggested-reply step. Reminders about saved ideas are `memory-ideas.md`. -->

# Agent reminders — «напомни в пятницу»

Status: approved by the founder 2026-11-19 with all four defaults below;
built behind `AGENT_REMINDERS_ENABLED` (decision
`docs/architecture/decisions/2026-11-20-agent-reminders.md`). A snooze moves
`dueAt` and returns the row to `pending` (counted in `snoozes`), so there is no
`snoozed` state.

## Why

The founder approved reminders as a full feature on 2026-11-19, while
suggested replies were being built («напомни в пятницу — почему бы и нет,
давай полноценно»). A reminder is the cleanest step offline the agent can
offer. The person decides now to do something later in their real life, and
the agent keeps the promise at the right moment. Then it lets them go.

So a reminder is always the person's own intention, in their own words, about
their life outside the chat. It is never a way for the agent to bring someone
back.

## Principles

1. **Only on request.** The agent sets a reminder when the person asks for one,
   or taps the `remind` suggested reply, which is the same ask in their words.
   The agent never sets one on its own.
2. **About life, not about the chat.** «Напиши ей», «купи цветы», «позвони
   маме», «спроси про субботу». Never «вернись поговорить», «загляни в
   Gennety». The agent refuses such a reminder and says why in one line.
3. **The promise is visible.** Every reminder that was set gets a code-owned
   receipt: «Напомню в пятницу, 10:00: написать Маше». The person sees exactly
   what will happen and when.
4. **It arrives as a message from the agent,** in the chat where it was set,
   with a push on iOS and a bot message in Telegram. It never brings a
   question and never adds «а ещё…» (agent concept rules 6–7).
5. **Quiet hours hold.** A reminder that falls into the person's quiet hours
   (`cross-cutting.md`) arrives when they end, unless the person set that exact
   time themselves («в 23:30»).
6. **No duplicates of what the product already does.** The date has its own
   reminders (T-5h, T-1h chat, the Date Terminal). When the person asks to be
   reminded about their booked date, the agent says that this is already
   coming and sets nothing.
7. The blind decision invariant, the stances and the consent gate for profile
   writes are not touched. A reminder never mentions the partner's decision.

## Phase 1 — Creating one in the chat

1. **A tool on both surfaces:** `set_reminder { text, dueAt, timeZone }`. The
   model resolves the time from the person's words and the clock line it
   already has (agent concept). Code validates it and writes the row.
   - Default times when only a day is named: the morning is 10:00 local,
     «вечером» is 19:00, «завтра» is 10:00 tomorrow. «В пятницу» means the next
     Friday that is not today; if today is Friday and it is before 10:00, it
     means today.
   - Limits: at least 5 minutes ahead, at most 90 days ahead, text 1–200
     characters, at most 10 live reminders per person. Over a limit the tool
     answers with the reason, and the agent says it in one line.
   - Ambiguous time («потом», «как-нибудь»): the agent asks once, with
     suggested replies when they fit («Завтра утром», «В пятницу вечером»).
2. **The receipt** is code-owned, like profile receipts. On iOS it is a
   receipt line (`receipts`). In Telegram it is the «✓» line. Its format is
   «Напомню {day}, {time}: {text}» in the person's language.
3. **The `remind` suggested reply** joins the step catalogue of
   `suggested-replies.md`. It is offered only when the agent's reply names a
   concrete future action by the person («напиши ей в пятницу»). Its text is
   the ask itself («Напомни в пятницу»). A tap runs the ordinary turn, which
   calls the tool.
4. **Listing and cancelling in the chat.** `list_reminders` and
   `cancel_reminder { id }` are read and write tools. «Какие у меня
   напоминания?» gets a short list. «Отмени про цветы» cancels one and gets a
   receipt. Cancelling needs no confirmation: it is undoable by asking again.

## Phase 2 — Storage

1. **New table `agent_reminders`** (a schema change, which is why this plan
   waits for a yes). Columns, in prose:
   - `id`, `userId` (cascade on account deletion);
   - `text` (the person's words, up to 200 characters) and `dueAt`;
   - `timeZone` (the zone it was set in, so the receipt and the message read
     in the person's local time);
   - `surface` (`app` or `telegram`) and `sessionId` (the app chat it was set
     in, nullable);
   - `state`, one of `pending`, `sent`, `done`, `snoozed`, `cancelled`;
   - `exactTime` (true when the person named the time, which lets it pass quiet
     hours);
   - `sentAt`, `answeredAt`, `messageId` (the agent row it arrived as),
     `createdAt`;
   - indexes `(state, dueAt)` and `(userId, state)`.
2. **Retention:** rows that are `done`, `cancelled`, or `sent` and unanswered
   are deleted 30 days after their last change by the existing retention
   worker. The text lives no longer than it is useful.
3. It is not merged with `memory_reminders`. Those belong to a saved idea and
   carry no text of their own; these are free text from the chat. Two small
   tables are clearer than one with two meanings.

## Phase 3 — Delivery

1. **A worker `agent-reminders`,** every minute, the same skeleton as the
   memory reminders (`guardedTick`, claim a row with a conditional update
   before sending, so a row is sent at most once).
2. **App.** The reminder becomes an assistant row in the chat it was set in.
   If that chat is older than six hours, it goes to a new chat titled with the
   reminder. The row carries a reminder card (`messages.attachment`, kind
   `agent_reminder`) with two buttons, «Сделано» and «Напомни завтра». A push
   follows: title «Напоминание», body the reminder text, payload
   `{ "type": "chat.reminder", "sessionId" }`, which opens that chat.
3. **Telegram.** A bot message «Напоминаю: {text}» with two inline buttons,
   «Сделано» and «Завтра».
4. **The buttons.** «Сделано» marks the row `done`, answers with one short warm
   line and nothing after it. «Напомни завтра» moves `dueAt` to the same time
   tomorrow (state `snoozed`, then `pending` again), at most three times.
   Ignoring a reminder is fine: it stays `sent`, and nothing nags.
5. **Wording.** The arriving message is code-owned, not written by the model:
   «Напоминаю: {text}» plus at most one line of context the person gave when
   setting it. No question, no new topic.

## Phase 4 — Contract, clients, i18n

1. **OpenAPI.** A new card `ChatReminderCard` (`state`, `text`, `dueAt`) on the
   history row and on the turn reply, for a build that lists `reminder` in
   `X-Gennety-Chat-Cards`. `POST /v1/chat/messages/{id}/reminder { action:
   done | tomorrow }`. The push type is `chat.reminder`. The receipt needs no
   new field.
2. **iOS.** The card under the agent's reminder message, with two secondary
   buttons; the push opens the chat; the regenerated `APIClient`.
3. **Telegram.** The inline buttons and their callbacks in the menu router.
4. **i18n.** The receipt, the arriving line, the buttons and the «done» line
   in all five languages.

## Phase 5 — Flag, demo, privacy, success

1. **Flag.** `AGENT_REMINDERS_ENABLED` (default off), plus a preview list like
   suggested replies. Off means the tools are not offered and the worker
   sends nothing; rows already set wait.
2. **Demo mode.** The demo visitor can set a reminder. The worker delivers it
   in the demo bot as in production; the demo does not speed time up. Demo and
   synthetic accounts are excluded from Pulse.
3. **Privacy.** The text is the person's own words about their life. It is
   stored only for this, erased with the account, and deleted 30 days after
   it is finished. The push shows it on the lock screen by default (open
   question 2). It never reaches the partner or any other person.
4. **Success in Pulse.** `agent_reminders_set`, `agent_reminders_done_share`
   (done ÷ sent, the north star of this feature: the person did the thing),
   `agent_reminders_snoozed_share`. A reminder marked «Сделано» counts as an
   offline step in the suggested-replies metrics too.

## Phase 6 — Tests and the live check

1. Unit tests for time resolution (days of the week, «завтра», «вечером»,
   across zones and across a DST change), the limits, the refusal of
   «come back» reminders, quiet hours, the claim-once worker, the buttons and
   the snooze cap.
2. A live-model run over scripted asks in all five languages: the tool is
   called only on a real request, the time is right, a date reminder is
   declined, a «come back» reminder is refused.
3. On the device: set one for two minutes ahead, see the receipt, get the
   push, tap «Сделано».

## Open questions for the founder

1. Creating: right away on the request with a receipt (default), or a
   confirmation card first.
2. The push: shows the reminder text on the lock screen (default — the person
   wrote it for themselves), or only «Напоминание от Gennety».
3. The buttons: «Сделано» and «Напомни завтра» (default), or no buttons.
4. Managing: in the chat only in this version (default), or also a
   «Напоминания» list in the iOS settings.
