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

function extractTotalTokens(body: unknown): number {
  const usage = (body as UsagePayload | null)?.usage;
  if (!usage) return 0;
  if (typeof usage.total_tokens === "number") return usage.total_tokens;
  const prompt = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === "number" ? usage.completion_tokens : 0;
  return prompt + completion;
}

export const openaiFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);

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
