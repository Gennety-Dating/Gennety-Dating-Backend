<!-- WHEN_TO_READ: You are changing the aura / attractiveness / swag-gap cards in the app chat, the `show_vibe_card` tool, the `vibe` or `sticker` reply fields, the stickers the server sends after a card, or how these cards meet the looks red lines. -->

# Agent vibe cards — aura, attractiveness and swag gap on a photo

Status: **founder chose the literal variant C on 2026-11-21** (decision
`docs/architecture/decisions/2026-11-21-agent-vibe-cards.md`). App chat only;
Telegram is a later step. Production waits for the founder's yes.

## Why

People already send the agent selfies and couple photos and ask «какая у меня
аура», «насколько я привлекательный», «кто кого могнул». A short, honest,
beautiful answer is the most shareable thing the agent can make, and it is the
lead scene of the agent's promo video. The answer is a card, not a paragraph.

## Phase 1 — What the person sees

1. The person attaches a photo and asks. The reply arrives in a fixed order:
   - the card, with its entrance animation;
   - optionally, one ordinary line from the agent (it never repeats the
     numbers);
   - optionally, one sticker.
2. Three kinds of card.
   - **Aura.** Aura percent («сила ауры»), an archetype in two or three words,
     three bars — energy, style, frame — up to three short «reads» from the
     photo, and one step that adds aura.
   - **Attractiveness.** Attractiveness percent, three bars — face, style,
     presence — up to three reads, and one step that would raise the number.
     The body has no number of its own.
   - **Swag gap.** Two people on one photo (or two photos in one turn). For
     each: a label the person used or «слева» / «справа», a style in two or
     three words, how current it is (in trend, classic, dated) and a swag
     score. The gap is the difference of the two scores, computed on the
     server. A verdict — who mogs whom, said straight — and up to two steps
     that close the gap before the date.
3. Every card says it is a reading of this one photo, and has a share button.

## Phase 2 — Rules for the agent

1. The card is the only place a number about looks appears. Without a photo in
   this chat (a celebrity by name, «он красивый?») the old red lines hold: no
   rating in words.
2. Numbers are honest, from 1 to 100. No flattery, no cruelty: a low number
   comes with the concrete step that would raise it.
3. Steps are what actually works: grooming, skin basics, a haircut, fit,
   posture, light and angle, sleep, training. Never bone smashing, extreme
   dieting, steroids or peptides without a doctor, DIY injections, or surgery
   as the answer.
4. No card, and no number in words, when:
   - anyone on the photo may be under 18;
   - there is no person on the photo;
   - the person shows self-hatred about their looks, disordered eating or body
     dysmorphia — safety mode from `agent-advisor.md` phase 5;
   - the model will not rate. Then it answers in words without a refusal
     lecture.
5. `scoreLeague` and `attractivenessBalance` stay internal. The agent never
   links a card to matching («поэтому тебе такие и попадаются»).
6. Only photos attached in this chat. A partner's profile photos are never
   fetched for a card.

## Phase 3 — How it is built

1. Tool `show_vibe_card`, offered only on a turn with at least one photo, to a
   build that lists `vibe` in `X-Gennety-Chat-Cards`, while
   `AGENT_VIBE_CARDS_ENABLED` is on, and when the code word list
   `VIBE_CARD_SAFETY_TERMS` finds nothing in the recent messages.
2. The tool requires two checks from the model before the numbers: a person is
   visible, and everyone visible clearly looks 18 or older. Either one false
   means the server refuses the card.
3. The server clamps every number and cuts every text to the limits in
   `packages/shared/src/vibe-cards.ts`, computes the gap, and stores the card on
   the assistant row: `messages.attachment`, kind `vibe_card`. Labels and the
   footnote come from shared i18n in the account language.
4. Sticker. The model asks for one with `sticker: true`; the server picks it
   from the closed list in `design-stickers.md` (iOS repo) by kind and score —
   `aura` with the caption «+1000 AURA» for a strong aura, `lockin` with
   «LOCK IN» for a swag gap or a step to work on, `found` for a strong
   attractiveness card — at most one per turn, never in safety mode.
5. The reply and the history row carry `vibe` (`ChatVibeCard`) and `sticker`
   (`ChatSticker`). A build without the token never gets either, and the agent
   gets no tool.
6. No schema change.
7. Demo mode: the same as production. The demo bot is Telegram, so it gets the
   cards with the Telegram step.

## Phase 4 — Proof

1. Unit tests for validation, clamping, the gap, the safety word list, the
   minor and no-person refusals, sticker choice, and the route fields.
2. Live eval `apps/bot/scripts/vibe-eval.ts` on the production model with
   generated photos: a selfie per kind, a couple, a landscape, a teenager-like
   drawing, a self-hatred message, and a request without a photo.

## Phase 5 — Later

1. Telegram: the agent learns to see photos, and the card is rendered as an
   image like the date card.
2. A vetted help-line list per market for safety mode.
