import type { Api, RawApi, Transformer } from "grammy";

/**
 * A callback answer that arrived too late is not an error worth telling anyone
 * about.
 *
 * `answerCallbackQuery` exists to dismiss the spinner on a tapped inline
 * button. It never carries the RESULT of the tap — that arrives as an edited
 * card, a new message, or a Mini App opening — so its failure changes nothing
 * the person can see, except when it escapes.
 *
 * Telegram expires a callback query after about a minute and then answers
 * `400: query is too old and response timeout expired or query id is invalid`.
 * Seventy-nine of the hundred-and-six call sites had no `.catch`, so that 400
 * travelled up to `bot.catch`, which replied "Something went wrong. Please try
 * again" — to someone whose tap had, in fact, worked. The likeliest way to be
 * a minute late is a slow handler, which is exactly when the person most needs
 * to be told the truth about what happened.
 *
 * Fixed here rather than at seventy-nine call sites, for the same reason the
 * blocked-chat observer and the rate limits live in transformers: this is where
 * the refusal actually arrives, and a rule written once cannot be forgotten by
 * the eightieth call site.
 */

/** The `answerCallbackQuery` failures that mean "too late", nothing more. */
function isStaleCallbackQuery(description: string | undefined): boolean {
  if (!description) return false;
  const text = description.toLowerCase();
  return (
    text.includes("query is too old") ||
    text.includes("query id is invalid") ||
    text.includes("response timeout expired")
  );
}

export function staleCallbackAnswerTransformer(): Transformer<RawApi> {
  return async (prev, method, payload, signal) => {
    const result = await prev(method, payload, signal);
    if (method !== "answerCallbackQuery") return result;
    if (result.ok) return result;
    if (result.error_code !== 400 || !isStaleCallbackQuery(result.description)) {
      return result;
    }
    // Answered as success: the spinner is already gone on the client, and the
    // caller has nothing useful to do with the distinction. The cast goes
    // through `unknown` because the union is narrowed to the error arm here —
    // rewriting it to the success arm is exactly the point.
    return { ok: true, result: true } as unknown as typeof result;
  };
}

/** Install on the main bot's Api. */
export function installStaleCallbackAnswers(api: Api<RawApi>): void {
  api.config.use(staleCallbackAnswerTransformer());
}
