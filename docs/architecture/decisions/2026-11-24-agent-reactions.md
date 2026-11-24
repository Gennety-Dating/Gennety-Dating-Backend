<!-- WHEN_TO_READ: Touching emoji reactions in the app chat with Gennety — the person's reaction on Gennety's replies, Gennety's `react` tool and its guard, the `reactions` chat-card token, `PUT /v1/chat/messages/{id}/reaction`, `messages.user_reaction` / `agent_reaction`, or `AGENT_REACTIONS_*`. -->

# 2026-11-24 — emoji reactions in the chat with Gennety

**Kind:** founder decision (reverses an earlier one).

**What.** On 2026-11-24 the founder asked that a person can react to Gennety's
messages with an emoji and that Gennety reacts too, and approved a two-step
plan. Step 1 is built: the person reacts to Gennety's replies with the proxy
chat's five (❤ 👍 🔥 🤣 🙏), and Gennety may answer a closing message («ок,
спасибо», «понял», 👍) with 🙏 / 👍 / ❤ instead of an empty «Пожалуйста!
Обращайся». Step 2 (Gennety reacting to photos and good news) is not built.

**Reverses.** The iOS journal entry of 2026-08-24/25 (`Gennety-iOS`,
`docs/architecture/decisions/2026-08-24--25.md`, item 3 «Реакций в основном
чате нет»): it held because the only server reaction rule was the onboarding
one. Its other half stays — thumbs up/down on replies is a rating mechanic the
product forbids, so the set is closed and has no 👎.

**Why.** The founder wants the chat to feel like a messenger with a friend: a
reaction says «got it» without another message, and an empty polite reply after
«ок, спасибо» is exactly the attention trap the agent concept forbids.

**Decided in the build (defaults the founder did not set; each can change).**
1. A person's reaction never starts a turn. The next turn's prompt names it with
   a 60-character excerpt and says a reaction is not a yes: offers and cards
   still wait for their tap.
2. Gennety's frequency and safety are enforced by the server, not only the
   prompt: the `react` tool exists only on a turn the guard passes — a short
   closing message, no photo, no context, no open question or offer from
   Gennety, no sad / anxious / complaint / cancellation / danger word in the
   person's six newest messages, no safety latch, and no Gennety reaction among
   the person's previous four messages (one per five, never two in a row).
3. A refused call is answered «no reaction, answer in words» inside the same
   tool loop — the cheapest safe option: no re-run of the turn, no canned i18n
   line, at most one more model round.
4. 🤣 is written out as never allowed on a photo or on what the person tells
   about themselves, so step 2's wider lists cannot let it through.
5. Same again / null / `{}` takes the person's reaction off (toggle on the
   server, as requested). A retried PUT of the same emoji therefore removes it.
6. `❤` is stored without the variation selector (Telegram's spelling); `❤️` is
   accepted and folded.
7. Storage: three nullable columns on `messages` (`user_reaction`,
   `agent_reaction`, `reacted_at`), migration
   `20261124120000_chat_message_reactions`.
8. Gating: the `reactions` token in `X-Gennety-Chat-Cards` plus
   `AGENT_REACTIONS_ENABLED` / `AGENT_REACTIONS_USER_IDS` (off by default). A
   build without the token always gets `message` on a turn.
9. Demo mode: the same as production; the app chat has no demo branch and the
   Telegram demo bot is untouched.

**What it changes going forward.** Gennety's reactions go only through the
server guard; a new occasion widens `AGENT_REACTIONS.occasionEmoji` and the
guard, never the prompt alone. `message` on `/v1/chat/message` and
`/v1/chat/voice` is no longer required in the OpenAPI contract.

**Recorded in:** `docs/product/domains/agent-reactions.md`,
`apps/bot/src/services/chat-reactions.ts`, `packages/shared/src/agent-reactions.ts`,
`openapi/gennety-v1.yaml`, `docs/architecture/api-surface.md`.
