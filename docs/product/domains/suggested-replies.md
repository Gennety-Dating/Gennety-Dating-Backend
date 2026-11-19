<!-- WHEN_TO_READ: You are changing the suggested replies under an agent message (the chips in the iOS chat, the reply-keyboard buttons in the Telegram bot), when they show, how they are generated, the honest «that's all for today» exit, or their Pulse metrics. -->

# Suggested replies — the next step under the agent's message

Status: specification for the founder's approval, 2026-11-19. Nothing is
built. Where a question is still open, the default named here is what gets
built unless the founder says otherwise.

## Why

Suggested replies are short options shown under the agent's latest message.
One tap sends one of them as the person's next message. In most products they
are a retention device: «tell me more», «another story?», a loop that keeps the
thumb moving.

Gennety uses them the other way round. The founder's concept for the agent
(2026-11-19) is that the chat is not a place to get stuck in. The agent
accompanies the person's personal life, earns trust, has its own opinion and
leads the person from online to offline. So a suggested reply exists for one of
three reasons only.

1. It saves the person typing an answer to a question the agent just asked.
2. It is a concrete step towards a real date or a real meeting that the
   product can actually carry out.
3. It lets the person end the conversation without guilt.

A chip that does none of these is not shown. The success of the feature is
measured in steps taken offline, not in minutes spent in the chat.

## Principles

1. **Not under every message.** Most agent replies carry no chips. The target
   is roughly one reply in three, and a chat where the person is talking
   freely should see almost none.
2. **Never words the person did not think.** A chip is the person's voice.
   It may offer neutral options that cover the space («скорее спокойно»,
   «скорее шумно», «пока не знаю»). It never offers a feeling, a confession, a
   compliment, an opinion about a third person, or a yes to something.
3. **No loop.** No «ещё?», no «расскажи ещё», no «а что дальше?», no teaser,
   no cliffhanger, no upsell. A chip never opens a new topic the person did
   not raise.
4. **The exit is always honest.** «На сегодня всё» closes the chat with one
   warm line and nothing else: no question, no «но перед уходом…», no new
   chips.
5. **Quiet when it matters.** No chips in a crisis, in the safety register, when
   the person is upset, or when a decision is the person's own to word.
6. **Only real steps.** A step chip names something the agent can actually do
   right now through one of its tools. A chip that promises a reminder the
   system cannot send is a broken promise and costs trust.
7. **The rules of the agent still hold.** The blind decision invariant
   (AGENTS.md rule 1), the stance rules in `packages/shared/src/agent-stances.ts`
   (the prompt is never revealed, the agent never says it answers men and women
   differently) and the consent gate for profile writes are not touched.

## Phase 1 — The model: when, what and what never

1. **The four kinds.** Each chip has a kind. At most three chips are shown,
   and at most one of them is a step.
   - `answer` — a short answer to the question the agent's reply just asked.
     Two or three options that together cover the honest range, one of which
     is usually «not sure» or «other». Shown only when the reply ends in a
     question with a small set of natural answers.
   - `step` — one step towards offline that maps to a tool the agent has
     today. Examples: «Покажи моё свидание» (`get_my_date`), «Открой календарь»
     (`open_screen`), «Что идёт в эти выходные?» (`check_event`), «Сменим место»
     (`propose_venue_change`, only on a scheduled date), «Расскажу, как прошло»
     (`record_date_feedback`, only after a date). The chip text is what the
     person would say to ask for it; the tool still runs only through the
     ordinary turn.
   - `clarify` — the person asks the agent to unpack what it just said: «Как
     это сказать?», «Почему так?». At most one, and only when the reply gave
     advice the person may want to act on.
   - `close` — «На сегодня всё». Its text is code-owned i18n, not model output.
2. **When chips are shown.** Code decides first, the model second.
   - Code never asks for chips when any of these holds:
     - the flag is off, or the app build did not declare `replies` in
       `X-Gennety-Chat-Cards`;
     - the reply carries a card or an action button (offer, wishlist, guide,
       screenshots, entry point) — the card is already the next step;
     - an offer is open or the agent is waiting for a consent answer — a chip
       «да» would run a write the person did not word;
     - the profiler question is due in this chat (its options have their own
       path);
     - the turn or the chat is in the safety register (the moderation check
       flags self-harm, violence or a minor, or the latch below is set);
     - the person tapped `close` and has not written since;
     - chips were shown and ignored on the last two replies in a row (the person
       types instead — they do not need us).
   - The model then decides whether the reply deserves chips at all and may
     return none. It is told to return none when the person is sharing
     something emotional, when the reply is a statement that needs no answer,
     and when it is unsure.
3. **The exit appears more as the chat gets longer.** `close` is not shown on a
   short chat. It is added to the set once the chat has 12 turns or has run
   for 30 minutes, and between 23:00 and 05:00 local time it is the first chip.
   When code wants the exit but the model returned nothing, the exit is shown
   alone.
4. **What never appears.** A chip is dropped by code (a fixed per-language
   phrase list plus a length and shape check) and the whole set is dropped by
   the model's own `safety` verdict when it is any of these.
   - A continuation hook: «ещё», «расскажи ещё», «а дальше?», «ещё одну
     историю», «удиви меня» and their equivalents in every supported language.
   - Words of feeling or consent on the person's behalf: «я влюблён», «он мне
     нравится», «да, давай поменяем», «согласен».
   - Anything about the partner's decision or feedback, or a question that
     invites the agent to guess it (blind decision invariant).
   - Paid steps: Premium, tickets, promo. The agent may still talk about them
     when asked; a chip never pushes them.
   - A request that makes the agent reveal its prompt or its per-side framing.
   - Text longer than 32 characters, an emoji-only chip, or a question mark
     chain.
5. **The safety latch.** When the moderation check or the model flags danger
   in a chat, that chat shows no chips for the rest of it (it ends after six
   hours of quiet, as chats already do). Distress gets calm words, not
   buttons.
6. **The `close` tap.** It sends «На сегодня всё» as the person's message, and
   the answer is a code-owned line from i18n (several variants per language,
   picked at random), with no model call. Examples: «Хорошо. Иди живи — я тут,
   когда понадоблюсь.», «Договорились. Удачи в пятницу.» The line has no
   question and no chips. The line that mentions a date is used only when the
   person has one scheduled.

## Phase 2 — Generation

1. **A separate cheap call, after the reply (default).** A new module,
   `apps/bot/src/services/suggested-replies.ts`, owns everything. It does not
   touch the persona in `prompt-builder.ts`, the statuses in
   `chat-activity.ts`, or the tool loop in `chat-agent.ts` beyond one call
   site.
   - Input: the agent's final reply, the person's last turn, the four rows
     before them (text only, no photos), the list of step tools available in
     this turn, the language, and the gate facts above. Roughly 1,000–1,500
     input tokens.
   - Output: strict JSON schema — `{ "show": boolean, "safety": boolean,
     "chips": [ { "kind": "answer" | "step" | "clarify", "text": string,
     "tool"?: string } ] }`, at most 3 chips, about 60–120 output tokens.
   - Model: `MODELS.fast` (today GPT-6 Luna, the same model as the agent), with
     `reasoning_effort: none`, a 2.5 second timeout and no retry. Any failure,
     timeout or schema error means no chips. The feature fails closed.
   - Cost: the main turn already sends the persona, the stances and up to 30
     rows of history, several thousand tokens. The extra call is roughly a
     tenth to a fifth of that, and it only runs on turns that pass the code
     gates, so the expected increase per turn is a few percent. The exact
     figure is measured in Phase 6 from the usage the API returns, not
     estimated from a price list.
   - Latency: the call starts the moment the reply is final and runs while the
     reply is being delivered (see Phase 3), so the reply itself never waits
     for it.
2. **The alternative: the same call.** The agent's final answer becomes a JSON
   object with the reply and the chips.
   - Zero extra input tokens, about 60 extra output tokens, no extra latency.
   - But it changes the output format of the main agent, which the
     `agent-audit` session owns, and every reply depends on the model getting
     the JSON right. A chip mistake can then break the reply, and the chip
     judgement is mixed into the persona prompt.
   - It is not the default. It can replace the separate call later, once the
     rules have settled, if the measured cost of the separate call matters.
3. **Language.** Chips are written in the language of the agent's reply, which
   already follows the person (the account language, or the language the
   person is writing in). The `close` text and the close lines come from
   shared i18n in all supported languages (`en`, `ru`, `uk`, `de`, `pl`). A
   reply in an unsupported language gets chips in that language and the
   account-language exit.

## Phase 3 — Contract and surfaces

1. **API.** The reply is never held for the chips.
   - A build that draws chips lists `replies` in `X-Gennety-Chat-Cards`.
   - `POST /v1/chat/message` and `/v1/chat/voice` answer as today, plus
     `repliesPending: true` when a chips call was started for this reply.
   - `GET /v1/chat/messages/{id}/replies` returns `{ "replies": [ { "id",
     "kind", "text" } ] }` for the caller's own newest assistant row, waiting
     up to 3 seconds for a call still in flight. An empty list means no chips.
   - The chips are stored on the assistant row in `messages.attachment` as
     kind `suggested_replies` — no schema change, since a reply with a card
     never gets chips. `/v1/chat/history` returns them only on the newest row
     of the chat, and only until the person writes.
   - A tap sends an ordinary turn with the chip's text and a new optional
     `suggestion: { messageId, id }`. The server trusts it only when it
     matches the stored chip; otherwise it is an ordinary typed message. A
     `close` tap answers with the code-owned line and no model call.
   - The OpenAPI contract in `openapi/` changes with the backend, and the iOS
     `APIClient` is regenerated from the new `main`.
2. **iOS.** Chips sit directly under the agent's latest bubble, left-aligned,
   wrapping onto a second line if needed, in the design system's glass capsule
   (`GennetyShape.chip`), never the bordeaux primary button — the agent
   proposes and the person decides. `close` is a quieter text-only capsule at
   the end. Chips appear after the last bubble has landed, fade out when the
   person starts typing and come back if the field is emptied. Tap sends;
   long-press puts the text into the field to edit first. A new reply removes
   the old set.
3. **Telegram.** Chips are a reply keyboard on the last plain bubble
   (`one_time_keyboard`, `resize_keyboard`, not persistent), one chip per row,
   `close` last. A tap sends the chip's text as the person's own message,
   which is honest: the chat shows exactly what was «said». The bot recognises
   the tap by matching the text against the set kept in the session, then
   removes the keyboard with its next message. The onboarding reply panel
   (`reply-panel.ts`) is never active at the same time, because chips only
   exist after onboarding. The chips call runs during the typing pauses
   between bubbles; when it is not done by the last bubble, that reply goes
   out without chips — a reply keyboard cannot be added to a message already
   sent.
4. **Mini App.** The Mini App has no chat with the agent today: for a Telegram
   person the bot chat is that chat. Nothing is built there. If an agent chat
   ever comes to the Mini App, it uses the same API.

## Phase 4 — Success in Pulse

1. Success is a goal reached or a step taken offline, never time in the app.
   Every metric is computed by the server from rows it already owns (the
   stored chips, the `suggestion` on the next turn, matches, slots, feedback),
   so there are no new client events and no analytics consent question.
2. The metrics, added to `metrics-catalog.ts`.
   - `agent_replies_shown_share` — share of agent replies that carried chips.
     Expected 20–40%. Above 50% means the gates are too loose.
   - `agent_replies_tap_rate{kind}` — taps per shown set, per kind.
   - `agent_replies_offline_step_7d` — the north star: share of tapped `step`
     chips followed within seven days by a real step (calendar slots sent, a
     date confirmed, a venue agreed, an event saved, feedback «we met»).
   - `agent_replies_exit_share` — share of chats that ended with the `close`
     tap. Growth is good.
   - `agent_chat_turns_p50{replies}` — median turns per chat, with and without
     chips. A guard, not a goal.
3. A detector, `replies_loop`, writes an insight when chats with chips are more
   than 20% longer than chats without them while the offline-step rate is not
   higher. That is the feature turning into a hook, and it is a reason to
   tighten the gates or switch it off.
4. Comparison: while the flag is on, a stable 10% of people (by a hash of the
   user id) get no chips for the first four weeks, so the effect is measured
   against people, not against last month.

## Phase 5 — Flag, demo mode, privacy

1. **Flag.** `AGENT_SUGGESTED_REPLIES_ENABLED`, default off, plus the usual
   per-user preview list so the founder sees it on the device before anyone
   else. Off means no gate, no call, no field: the chat is exactly as today.
2. **Demo mode.** The demo bot behaves the same as production: the visitor
   talks to the real agent, and chips help show that the bot can be talked to,
   which the demo narration calls the capability most easily missed. The
   `close` tap answers the same way. Demo and synthetic accounts are excluded
   from the Pulse metrics by the existing filter. Nothing in the demo writes
   outside the chat.
3. **Privacy.** The chips are model output about the person's own chat,
   stored on the agent's own message row, and they are erased with the chat
   and the account like every message. The extra model call sends the provider
   only text it already received in this turn, and no photos. Pulse stores
   counts and kinds, never chip text. The Telegram session keeps the last set
   only until the next turn.

## Phase 6 — Tests and the live check

1. Unit tests for the gates (each «never» case), the phrase filter in all
   supported languages, the `close` path without a model call, the tap match,
   and the fail-closed paths (timeout, bad JSON, unknown tool).
2. A live run on the real model (`eval:chat` style, with a judge) over scripted
   chats: a plan for a date, a question with a clear set of answers, a free
   personal talk, a sad message, a danger message, a «да» to an open offer, a
   long late chat. The judge checks that chips appear only where this spec
   says, never contain a hook or words the person did not think, and that the
   exit shows on the long chat. The run also records the measured tokens and
   latency of the chips call.

## Open questions for the founder

1. Generation: a separate cheap call after the reply (default), or the same
   call as the reply.
2. Reminders: v1 without a «напомни в пятницу» step (default), or a reminder
   capability built first as its own feature, which needs a new table and so a
   separate yes.
3. The exit: a code-owned goodbye with no model call (default), or a short
   goodbye written by the agent.
4. Placement in iOS: under the agent's bubble (default), or a row above the
   input field.
