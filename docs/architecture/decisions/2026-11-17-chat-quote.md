<!-- WHEN_TO_READ: Touching how the person quotes an agent reply in the app chat, the `chat_quote` chat context, or quotes in voice notes. -->

# 2026-11-17 — quoting an agent reply in the app chat

The founder asked for a quote to look the way ChatGPT shows it, not as text pasted into the input in «ёлочки». The founder also asked that a quote work with a voice note. They chose the ChatGPT look (one line inside the input) over the Gemini reply bar, and said yes to deploying the backend to production after green tests.

1. **Where the quote lives.** A quote is a new chat context kind, `chat_quote`, on the existing `context` field of `/v1/chat/message`. On `/v1/chat/voice` it is the `contextKind`/`contextId` form fields plus a new `contextText`.
   - `id` is the quoted reply's message id. It must be the caller's own `assistant` row, otherwise 404.
   - `text` is the quoted piece, 1–300 characters (`CHAT_QUOTE_MAX_CHARS`) after whitespace is collapsed, otherwise 400.
   - The snapshot `{ kind: "chat_quote", id, title: text }` is stored in `messages.context` with no schema change. `/v1/chat/history` returns it, so the quote line over the person's bubble survives a reload.
2. **What the agent sees.** The quote rides in front of the person's turn as one line, `[Replying to this part of your earlier message: «…»]`, in the user role. It is there on this turn and on every later turn of the chat. It never goes into the system prompt: it is the person's own input. A quote never becomes the active context, and an inbox chip sent earlier keeps grounding through it.
3. **Not checked.** The server does not require the text to be a substring of the reply. The app's bubble text and the stored text can differ in markdown and spaces, and a mismatch would refuse a real quote. The text cannot reach anyone but the person's own agent, so nothing is gained by refusing it.
4. **Demo mode.** It behaves the same. The quote is only context for one turn and writes nothing outside the chat.
5. **Telegram.** Unchanged. A reply-to in Telegram is not part of this.
