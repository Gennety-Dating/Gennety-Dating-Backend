<!-- WHEN_TO_READ: You touch `POST /v1/chat/voice` field `text` / `leadMessageId`, `ChatTurnInput.leadText`, `VideoTakeTurn.thisTurnTexts`, the iOS composer while a voice note records, or someone asks why a typed link was lost when they recorded a voice note. -->

# 2026-11-26 — text typed before a voice note goes with it: two bubbles, one answer

**Kind:** founder request (iOS chat, 2026-11-26). The founder chose two
separate bubbles over one combined bubble («нужно дизайнить новый вариант
пузыря — я так не хочу»), approved composer design A («строка в капсуле») from
the mockup canvas «Текст перед голосовым», and chose «Один раз»: Gennety
answers both together.

**Why.** A voice note took the photos from the input field with it
(2026-10-16), but not the typed or pasted text. While the voice note
recorded, the text faded out with the field and stayed in the draft. The
`/v1/chat/voice` route had no text field. A pasted Instagram link therefore
never reached the agent.

## What changed

1. Server:
   1. `POST /v1/chat/voice` takes an optional multipart field `text`. It is
      trimmed and has the same 4000-character limit as `/message`
      (413 `message_too_long`). The limit is checked before transcription.
   2. `runChatTurn` stores `leadText` as its own user message right before
      the transcript row. The history and the feed read two messages, and
      the turn is answered once.
   3. The response carries `leadMessageId`, also on a reaction-only turn.
   4. The video read counts both messages as this turn
      (`VideoTakeTurn.thisTurnTexts = 2`). A link in the typed half gets the
      «Смотрю видео…» status and feeds the trend glossary.
2. iOS:
   1. While a voice note records or is reviewed, the typed text stays
      visible. It is one quiet line in the capsule above the recording, like
      the quote row, with links in the accent colour. Under the capsule a
      caption reads «Текст уйдёт отдельным сообщением перед голосовым»
      (`chat.voice.lead.caption`).
   2. Only the app chat passes `ChatComposerVoiceLead`. The onboarding
      interview composer is unchanged.
   3. On send, the field is emptied. The text becomes a pending bubble right
      above the voice bubble, and both travel in one `/voice` request.
   4. An Instagram or TikTok link in the text is read through the phone's
      preview first (decision 2026-11-20).
   5. On success, the text bubble is rebound to `leadMessageId`.
   6. If the voice note is not recognised (422), the text goes back into the
      field, like the photos and the quote.
   7. On any other failure, the text bubble waits beside the voice bubble,
      and the voice bubble's retry resends both.
3. Unchanged on purpose:
   1. Typing into the hidden field during recording is still blocked, as
      before. The text visible above the recording is what was typed
      before recording started.
   2. Demo mode behaves the same: no gate and no paid step.

## Rejected

1. One combined bubble: the founder declined it because it needs a new
   bubble design.
2. Sending the text as a plain `/message` before the voice note: Gennety
   would answer twice, the first time to the link alone.
3. Mockup variants B (a dashed bubble above the field) and C (the text as an
   attachment card): not chosen.

## Not deployed

1. The backend needs the founder's «да» for production.
2. Older app builds never send `text`, so for them nothing changes.
