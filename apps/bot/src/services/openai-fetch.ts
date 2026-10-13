import { normalizeChatCompletion } from "../models.js";
import { currentUsageKey } from "./usage-context.js";
import { usageLimiter } from "./usage-limiter.js";

/**
 * A `fetch` drop-in for OpenAI HTTP calls that transparently meters token
 * usage. Every OpenAI `chat/completions` and `embeddings` response carries an
 * exact, server-counted `usage` object; this wrapper reads
 * `usage.total_tokens` (falling back to prompt+completion) and attributes it to
 * the ambient spender (services/usage-context.ts) plus the global counter,
 * then returns the **untouched** response so each call site's own `.json()` /
 * `.text()` parsing keeps working.
 *
 * Wiring is a one-word change at each call site: `fetchFn ?? fetch` →
 * `fetchFn ?? openaiFetch`, or a direct `fetch(` → `openaiFetch(`. Test
 * injections that pass their own `fetchFn` bypass this entirely.
 *
 * Accounting is best-effort and never affects the request: the body is read
 * from a clone in a detached promise (no added latency), guarded so a parse
 * failure, a non-JSON body, or a streaming response is simply a no-op.
 */

interface UsagePayload {
  usage?: {
    total_tokens?: number;
    prompt_tokens?: number;
    completion_tokens?: number;
  };
}

const DEFAULT_OPENAI_TIMEOUT_MS = 30_000;

/**
 * Normalize only chat requests, never embeddings, moderation or audio.
 *
 * A body the rules leave as it is goes out as the caller's own string. That is
 * every caller that already normalized its object before `JSON.stringify` —
 * the shared `openai.ts` helpers and the vision scorer with its multi-MB base64
 * photos among them — and every model the rules do not cover. Re-serializing
 * such a body only reproduced the same JSON text (`JSON.stringify` of what
 * `JSON.parse` read back from `JSON.stringify` output is that output), at the
 * cost of a second full serialization on the main thread.
 */
function normalizeChatCompletionBody(
  input: Parameters<typeof fetch>[0],
  init: RequestInit | undefined,
): RequestInit | undefined {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).pathname !== "/v1/chat/completions" || !init || typeof init.body !== "string") return init;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return init;
  const body = parsed as Record<string, unknown>;
  const normalized = normalizeChatCompletion(body);
  if (sameTopLevelEntries(body, normalized)) return init;
  return { ...init, body: JSON.stringify(normalized) };
}

/**
 * Same own keys in the same order with identical values. `normalizeChatCompletion`
 * only ever sets or deletes top-level fields of a shallow copy, so this is
 * exactly "it changed nothing" — and then both serialize to the same text.
 */
function sameTopLevelEntries(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): boolean {
  if (before === after) return true;
  const keys = Object.keys(before);
  const afterKeys = Object.keys(after);
  if (keys.length !== afterKeys.length) return false;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    if (afterKeys[i] !== key || after[key] !== before[key]) return false;
  }
  return true;
}

function extractTotalTokens(body: unknown): number {
  const usage = (body as UsagePayload | null)?.usage;
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return prompt + completion;
}

export const openaiFetch: typeof fetch = async (input, init) => {
  const requestInit = normalizeChatCompletionBody(input, init);
  const res = await fetch(input, {
    ...requestInit,
    signal: requestInit?.signal ?? AbortSignal.timeout(DEFAULT_OPENAI_TIMEOUT_MS),
  });

  // Capture the spender synchronously while the ALS context is still active —
  // the detached read below may settle after the caller's context has exited.
  const key = currentUsageKey();

  try {
    const contentType = res.headers.get("content-type") ?? "";
    if (res.ok && contentType.includes("application/json")) {
      // Clone before the caller consumes the body; read the clone detached so
      // we add zero latency to the caller's `await`.
      const clone = res.clone();
      void clone
        .json()
        .then((body: unknown) => {
          const total = extractTotalTokens(body);
          if (total > 0) usageLimiter.recordTokens(key, total);
        })
        .catch(() => {
          /* best-effort: never let token accounting surface an error */
        });
    }
  } catch {
    /* cloning/headers failed — skip accounting, request is unaffected */
  }

  return res;
};
