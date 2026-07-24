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
 * The configured GPT-5.6 models (`models.ts`) are reasoning models, and the
 * OpenAI `/v1/chat/completions` endpoint rejects two things the pre-migration
 * GPT-5.4/4.1 call sites still send:
 *
 *   1. Any `temperature` other than the default `1` → hard 400 ("Unsupported
 *      value: 'temperature' does not support 0 with this model. Only the
 *      default (1) value is supported."). Many chat call sites pass 0 / 0.3 /
 *      0.7, correct for the old families but fatal now (degraded pitch, Elo
 *      seed, vibe axes, fact extraction, …).
 *   2. Function `tools` without `reasoning_effort: "none"` → hard 400
 *      ("Function tools with reasoning_effort are not supported for
 *      gpt-5.6-terra in /v1/chat/completions. To use function tools, use
 *      /v1/responses or set reasoning_effort to 'none'."). This breaks the
 *      three tool-calling agents (menu, onboarding, Aether) — the failing
 *      request bubbles up and the caller silently falls back to the plain
 *      menu / a canned reply.
 *
 * Both are normalised here, in one place, so every chat request that flows
 * through `openaiFetch` is corrected regardless of call site: drop a
 * non-default `temperature`, and inject `reasoning_effort: "none"` whenever the
 * body carries function `tools` (respecting an explicit value if a caller ever
 * sets one). Non-tool requests are otherwise untouched, bodies that aren't JSON
 * strings (embeddings, streams) pass through unchanged, and any parse failure
 * leaves the request as-is.
 *
 * SINGLE REVERT POINT: when a model that supports custom temperature and tool
 * calls without this flag is configured (an `OPENAI_MODEL_*` override), remove
 * this shim.
 */
function normalizeChatCompletionBody(
  init: RequestInit | undefined,
): RequestInit | undefined {
  if (!init || typeof init.body !== "string") return init;
  let parsed: unknown;
  try {
    parsed = JSON.parse(init.body);
  } catch {
    return init;
  }
  if (typeof parsed !== "object" || parsed === null) return init;
  const body = parsed as Record<string, unknown>;

  let changed = false;

  // (1) Drop a non-default temperature — GPT-5.6 only accepts the default (1).
  if ("temperature" in body && body.temperature !== 1) {
    delete body.temperature;
    changed = true;
  }

  // (2) Function tools require `reasoning_effort: "none"` on these reasoning
  // models. Only inject for a non-empty tools array, and never overwrite an
  // explicit value a caller already set.
  if (
    Array.isArray(body.tools) &&
    body.tools.length > 0 &&
    !("reasoning_effort" in body)
  ) {
    body.reasoning_effort = "none";
    changed = true;
  }

  if (!changed) return init;
  return { ...init, body: JSON.stringify(body) };
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
  const requestInit = normalizeChatCompletionBody(init);
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
