import { GrammyError, HttpError } from "grammy";

/**
 * What an error is allowed to put into a log line.
 *
 * Exists because the obvious `console.error(..., botError)` is a credential
 * leak (audit B-03): a grammY `BotError` carries `ctx`, `ctx.api` carries the
 * raw API client, and the client's `token` is a public field — Node's inspector
 * prints all of it, together with the whole update (names, phone numbers,
 * message text). The reducer keeps only what diagnoses the failure: the
 * error's own name/message/stack and, for a Telegram refusal, the method and
 * code. The update is identified by its id alone.
 */
export interface LoggedError {
  name: string;
  message: string;
  stack?: string;
  method?: string;
  error_code?: number;
  description?: string;
  cause?: string;
}

// `bot123456:AA…` as it appears in a Bot API URL. A network error's message can
// quote the request URL, and that URL embeds the token.
const BOT_TOKEN_IN_TEXT = /\d{5,}:[A-Za-z0-9_-]{20,}/g;

export function redactBotToken(text: string): string {
  return text.replace(BOT_TOKEN_IN_TEXT, "<redacted-token>");
}

export function summarizeError(err: unknown): LoggedError {
  if (!(err instanceof Error)) {
    return { name: typeof err, message: redactBotToken(String(err)) };
  }
  const out: LoggedError = {
    name: err.name,
    message: redactBotToken(err.message),
  };
  if (err.stack) out.stack = redactBotToken(err.stack);
  if (err instanceof GrammyError) {
    out.method = err.method;
    out.error_code = err.error_code;
    out.description = err.description;
  } else if (err instanceof HttpError) {
    const inner = err.error;
    out.cause = redactBotToken(inner instanceof Error ? inner.message : String(inner));
  }
  return out;
}

/** The log-safe view of a `BotError`: the underlying error plus the update id. */
export function summarizeBotError(err: {
  error: unknown;
  ctx?: { update?: { update_id?: number } };
}): { update_id: number | undefined; error: LoggedError } {
  return {
    update_id: err.ctx?.update?.update_id,
    error: summarizeError(err.error),
  };
}
