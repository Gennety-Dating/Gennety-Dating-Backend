import { env } from "../config.js";

/**
 * Reading an OpenAI response's `usage` into what the token budgets count.
 * Its own module so a test that mocks `openai-fetch` keeps the real arithmetic.
 */

/** Chat Completions names the fields `prompt_*` / `completion_*`; Responses, `input_*` / `output_*`. */
interface UsageField {
  total_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/** What one response spent, and what of it counts against the budgets. */
export interface CallUsage {
  prompt: number;
  cached: number;
  completion: number;
  /** Fresh tokens whole, cached prompt tokens at `LLM_CACHED_TOKEN_WEIGHT`. */
  counted: number;
}

const count = (value: unknown): number => (typeof value === "number" && value > 0 ? value : 0);

/**
 * Read a response's `usage` into what the budgets count (decision 2026-11-26).
 *
 * Every call re-sends the system prompt, the tool list and the history, and
 * OpenAI serves most of that from its prompt cache at about a tenth of the
 * price. Counting those tokens whole made a person's daily budget run out
 * after a handful of turns while the bill barely moved, so a cached token
 * counts at `LLM_CACHED_TOKEN_WEIGHT` and everything else whole.
 */
export function usageOf(body: unknown, cachedWeight = env.LLM_CACHED_TOKEN_WEIGHT): CallUsage | null {
  const usage = (body as { usage?: UsageField } | null)?.usage;
  if (!usage) return null;
  const prompt = count(usage.prompt_tokens ?? usage.input_tokens);
  const completion = count(usage.completion_tokens ?? usage.output_tokens);
  const total = typeof usage.total_tokens === "number" ? count(usage.total_tokens) : prompt + completion;
  const cachedField = usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens;
  const cached = Math.min(count(cachedField), prompt || total);
  // A test double of `env` may not carry the weight: fall back to the default.
  const weight = Number.isFinite(cachedWeight) ? cachedWeight : 0.1;
  const counted = Math.round(total - cached + cached * weight);
  return { prompt, cached, completion, counted };
}
