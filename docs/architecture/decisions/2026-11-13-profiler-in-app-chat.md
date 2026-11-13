<!-- WHEN_TO_READ: Touching the Profiler on the native app, `POST /v1/chat/profiler`, or how `POST /v1/chat/message` treats a reply to an «about you» question. -->

# 2026-11-13 — «About you» questions move into the app's chat

**Type:** founder decision (iOS decision journal 2026-11-02, confirmed 2026-11-13: "вариант А, бэкенд разрешаю").

**Why.** On «Сегодня» the questions rebuilt the whole screen, and every transition left a seam. The founder moved them into the chat with Gennety; «Сегодня» keeps a live chat block that leads there.

**What.**

1. `POST /v1/chat/profiler { sessionId }` writes the due question (`getNativeProfilerBatch`) as an ordinary `assistant` row of that chat, with `attachment: { kind: "profiler_question", questionId }`, and returns it as `{ message }`. `{}` when nothing is due or the chat already ends with that question. The session is claimed like a first message's.
2. `POST /v1/chat/message`: when the chat ends with a question row that is still answerable (`nativeProfilerQuestionOpen`), a plain typed message (no images, no context chip) is recorded through `answerNativeProfilerQuestion` — the same claim, answer row and Telegram copy retirement as `/v1/me/profiler/answer`. The reply is the next question row, or `profilerSeriesDone` / `profilerRefusalAck` from shared i18n. No model call, no usage beyond the guard. An answer that is not taken writes nothing and the message becomes an ordinary concierge turn; a failure inside the profiler path is logged and does the same.
3. Chat text: the context card (`profilerContextMarkdown` without the `> ` quote marks), the question, and for a closed (contextual) question its options numbered. A number or an option's words pick the option; anything else is the person's own words.
4. The rows stay in the chat: history reads them back, and the concierge sees what was asked and answered.

**Deliberately not done.**

- Voice replies (`/v1/chat/voice`) still go to the concierge — a spoken answer to a question is an agent turn for now.
- No quick-answer chips in the history DTO: the iOS build answers in words and numbers first.
- «На потом» questions are not posted into the chat.
- Telegram is untouched: the worker keeps pushing batches to Telegram users.

**Demo mode.** No change: the demo bot runs in Telegram; the native route has no demo branch.

**Deploy.** Not deployed. Production needs this commit before the iOS build that calls `/v1/chat/profiler`; an older server answers that call 404, and the app then simply shows no question.
