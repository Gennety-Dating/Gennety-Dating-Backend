<!-- WHEN_TO_READ: Touching the chat agent's photo ratings — the `show_vibe_card` tool, the aura / attractiveness / swag-gap cards, the `vibe` and `sticker` fields of a chat reply, the `vibe` chat-card token, `VIBE_CARD_*` constants, or the looks red lines and the `looks` stance where they meet these cards. -->

# 2026-11-21 — vibe cards: aura, attractiveness and swag gap on a photo

On 2026-11-20 the founder asked for three viral skills in the agent chat: «аура по фото» in percent with a breakdown, an attractiveness percentage, and «swag gap» between two people («кто кого могнул»). Each answer is a visual card in the chat feed, then an optional line from the agent, then an optional sticker, in that order.

The literal version conflicts with the looks red lines approved on 2026-11-16/18 (`agent-video-takes.md` phase 2, `LOOKS_RED_LINES`, glossary entry `mogging`, stance 0 `looks`, stance rule 10). The founder was shown three variants on 2026-11-20 (page https://claude.ai/artifact/APQyLrs4rii3Aqm4Eguhe9): A — vibe and style only, B — no numbers, C — literal. The recommendation was A. **On 2026-11-21 the founder chose C**: «более радикальный и прямой мне больше нравится».

1. **What changes in the red lines.**
   - The agent may rate appearance in numbers, including a face, but only through the card: the person sent a photo in this chat and asked for aura, attractiveness, a rating, swag gap or mog. The card is the only place the number appears; the reply text never adds a second rating.
   - Swag gap may compare two people on a photo the person sent, partner included, and name who mogs whom.
   - Everything else in the red lines stays: no rating in words without a photo (a celebrity by name, «он красивый?»), anti-harmful-practice takes, the argument with the blackpill frame, and safety mode.
   - `scoreLeague` / `attractivenessBalance` stay internal. The card's number is the model's reading of this one photo, never a matching factor, and the agent never links the two.
2. **Defaults chosen in the build (the founder did not decide them; each can be changed).**
   - No card when anyone on the photo may be under 18, when there is no person, in safety mode (self-hatred about looks, disordered eating, body dysmorphia), or when the model refuses. In those cases the agent answers in words with no number.
   - Safety mode is checked twice: by the prompt, and by a word list in code (`VIBE_CARD_SAFETY_TERMS`) that removes the tool for the turn.
   - Numbers are honest, 1–100, and every card carries at least one concrete step that would raise it (grooming, haircut, fit, light, posture), never a harmful practice.
   - The attractiveness breakdown is face, style and presence. The body has no separate number.
   - Only photos attached in this chat count. A partner's profile photos are never fetched for a card.
   - Stickers: the agent asks for one, the server picks it from a closed list by card kind and score, at most one per turn and never in safety mode.
   - Telegram later: the Telegram agent does not see photos, and the Mini App has no agent chat. The demo bot is Telegram, so it gets the cards only with the Telegram step.
3. **Shape.** Tool `show_vibe_card`, stored on the assistant row (`messages.attachment`, kind `vibe_card`), returned as `vibe` and `sticker` on the reply and on history rows, only to a build that sends `vibe` in `X-Gennety-Chat-Cards`. No schema change. Flag `AGENT_VIBE_CARDS_ENABLED` (default on; production waits for the founder's yes).
4. **Demo mode.** The same as production.
5. **Risks the founder accepted with C.** People on the photo did not consent to a rating. A low number can hurt. The model may refuse face ratings, and then there is no card.

Spec: `docs/product/domains/agent-vibe-cards.md`.

## Build notes (2026-11-21)

1. **Live eval** `apps/bot/scripts/vibe-eval.ts` on `gpt-6-luna`, generated portraits only (`hf_*.png`), 12 cases × 3 runs: **36/36**. Cases: aura ru/uk, attractiveness ru/en/a friend, swag gap, a landscape, a place with people («аура этого места»), a drawn child, «я урод… сколько из 100», a starving message, Gosling without a photo.
2. **Two calibrations the eval forced.**
   - The first run rated «the aura of this place» with a card. Rule added: a card always rates a person; a place, a dish, a thing or a pet goes in words.
   - «If in any doubt, not an adult» refused 2 of 36 cards on clearly adult twenty-year-olds — the core audience. The check is now «plausibly looks under 18: child or teen features, a school setting»; a young-looking adult in an adult setting is an adult. The drawn child is still refused 3/3.
3. **Empty line allowed.** After a card the model may write nothing; that is an answer, not a failed call (`allowEmpty`), so it costs no retries.

## Founder on 2026-11-22

1. **The card look is rejected.** «Слишком много текста, слишком мало визуала»: big bold type, few words, more drawing, native to the feed — «не как отдельный блок, а прям продолжение чата… чат оказался доской, на которой что-то нарисовали». The shipped `ChatVibeCardView` is to be replaced.
2. **Three directions shown, no choice yet** (https://claude.ai/artifact/1HuGdVRDHinrja3jWgcqXZ): A «Силуэт» — the person cut out on the chat ground, the number behind, the aura along the contour; B «Маркер» — the agent draws over the photo and the pluses add up to the score; C «Уровень» — the chat fills with aura to the score. Recommended: A.
3. **No production deploy of the backend for now** («Пока нет»). `show_vibe_card` stays undeployed.
4. **Not checked yet**: subject lifting with Apple Vision ran on this Mac on four generated portraits, not on an iPhone. B needs the breakdown as points that sum to the score, which the server does not send today.
