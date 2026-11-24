<!-- WHEN_TO_READ: You are changing emoji reactions in the app chat with Gennety — the person's reaction on Gennety's replies, Gennety's own `react` tool and its server guard, the `reactions` chat-card token, `PUT /v1/chat/messages/{id}/reaction`, `messages.user_reaction` / `agent_reaction`, or `AGENT_REACTIONS_*`. Reactions in the anonymous pre-date chat are the proxy chat (decision 2026-09-08). -->

# Emoji reactions in the chat with Gennety

On 2026-11-24 the founder asked for two things in the app chat: that a person
can react to Gennety's messages with an emoji, and that Gennety reacts too. He
approved a two-step plan. This file is step 1. Decision:
`docs/architecture/decisions/2026-11-24-agent-reactions.md`.

## Phase 1 — the person's reaction (built)

1. The set is the proxy chat's five: ❤ 👍 🔥 🤣 🙏 (`REACTION_EMOJI` in
   `packages/shared/src/agent-reactions.ts`, the same constant the proxy chat
   now reads).
   - `❤` is stored and returned without the variation selector, as Telegram
     spells it. A client may send the red `❤️`; the server folds it.
   - There is no 👎 and no open keyboard: the product forbids like/dislike as a
     rating mechanic.
2. One reaction per side per message. A new emoji replaces the old one. The
   same emoji again, `null` or an empty body takes it off.
3. Only Gennety's replies take the person's reaction. The person's own message,
   someone else's message or a missing one is refused.
4. A reaction never starts a turn and never costs tokens.
5. On the next turn the model is told what landed.
   - A system block names every reaction set since the person's previous
     message, with the first 60 characters of the reply it sits on: «They
     reacted ❤ to your message «Бар с джазом на Подоле…»».
   - The same block says that a reaction is not a reply and not a yes: it
     books, saves, accepts or confirms nothing, and an offer or a card still
     waits for a tap or words.
   - Every earlier reply with a reaction carries a short note in the history
     («[They reacted ❤ to this message.]»), so the reaction is not lost after
     that turn.
6. Stored on the row: `messages.user_reaction` and `messages.reacted_at`.
   Visible on every device through `/v1/chat/history`.

## Phase 2 — Gennety's reaction on a closing (built)

1. The only occasion in step 1 is a closing: the person ends the topic («ок,
   спасибо», «понял», «👍»). Gennety may answer it with 🙏, 👍 or ❤ instead of an
   empty «Пожалуйста! Обращайся».
2. The agent does it through the tool `react(emoji)`. The target is always the
   person's message of this turn. When the agent reacts and writes nothing, the
   turn stores no assistant row and the response has no `message`.
3. The server decides before the model is called whether the tool exists on
   this turn (`agentReactionGate` in `apps/bot/src/services/chat-reactions.ts`).
   The prompt is never the only rule. The tool is offered only when all of these
   hold:
   - the message is a short closing: a goodbye, thanks or «ok» phrase from the
     suggested-replies list (`isLeavingTurn`), or up to three closing emoji, no
     question mark, at most 40 characters;
   - the turn has no photo and no context (a chip, a quote, an inbox item);
   - Gennety's previous message did not end with a question and holds no open
     change offer — an «ок» there may be a yes, and a reaction is not a yes;
   - none of the person's six newest messages contains a sad, anxious,
     complaint, date-cancellation or danger word
     (`AGENT_REACTION_SENSITIVE_TERMS`, five languages), and the chat's
     suggested-replies safety latch is not set;
   - Gennety reacted to none of the person's previous four messages: at most one
     reaction per five of the person's messages, so never two in a row.
4. The tool offers only the emoji the occasion allows (🙏 👍 ❤ for a closing),
   and the server checks the call again. 🤣 is never allowed on a photo or on
   what the person tells about themselves, whatever a later occasion allows.
5. When the server refuses a call, the tool answers «no reaction, answer in
   words» and the model writes its reply in the same loop. No second turn and
   no canned line are needed, so a refusal costs at most one more model round.
6. A turn that reacted and also changed something, or made a card or a button,
   keeps a reply, so a receipt is never hidden behind an emoji.
7. A turn may also react and write a line. Then the response carries both
   `message` and `agentReaction`.
8. Stored on the person's row: `messages.agent_reaction` and
   `messages.reacted_at`. The next turn's history marks it («[You reacted 🙏 to
   this message.]»).

## Phase 3 — gating

1. Client capability: a build that lists `reactions` in `X-Gennety-Chat-Cards`.
   Only such a build gets `reactions` on history rows, the reaction endpoint and
   the agent's reactions. Any other build always gets `message` on a turn.
2. Feature flag: `AGENT_REACTIONS_ENABLED` (default off) or the person's id in
   `AGENT_REACTIONS_USER_IDS`, read only through `agentReactionsOn` in
   `feature-preview.ts`. Off, the endpoint answers 404, history carries no
   `reactions`, the agent has no tool and the prompt names no reaction.
   Reactions already stored stay in the table.
3. Telegram is out of scope: the Telegram agent has its own native reactions
   and no change here.

## Phase 4 — demo mode

1. The person's reactions work the same way.
2. Gennety reacts by the same rules and the same guard: the app chat has no demo
   branch, and the demo bot is Telegram, which this feature does not touch.

## Phase 5 — contract

1. `ChatReactions { user: string|null, agent: string|null }`.
2. `ChatHistoryMessage.reactions` is present on every row, both sides possibly
   null, only when the build sent `reactions` and the gate is on. Its presence
   tells the client to show the reaction UI.
3. `PUT /v1/chat/messages/{id}/reaction`, body `{ emoji: string|null }` →
   200 `ChatReactions`. 404 when the gate is off, the build did not send
   `reactions`, or the message is not the caller's. 409 `not-assistant`. 422
   `bad-reaction`.
4. `POST /v1/chat/message` and `POST /v1/chat/voice` add `userMessageId` (the
   stored id of the person's message of this turn) on every turn, and
   `agentReaction { messageId, emoji }` when Gennety reacted. `message` is
   absent only for a build that sent `reactions` when Gennety answered with the
   reaction alone.

## Not in step 1

1. Gennety reacting to photos or good news. Step 2 adds an occasion and its
   emoji to `AGENT_REACTIONS.occasionEmoji` and a branch to the guard; the tool,
   storage and contract stay as they are.
2. Reactions in the Telegram agent chat.
