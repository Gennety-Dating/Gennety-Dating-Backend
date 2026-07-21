import { env } from "../config.js";
import { openaiFetch } from "./openai-fetch.js";

/**
 * Thin OpenAI chat-completions wrapper used by the AI prompt pipeline.
 *
 * Two modes:
 *   - `callOpenAIJson<T>` — enforces `response_format: { type: "json_object" }`
 *     so the response is guaranteed valid JSON. Used for parsing prompts (#1, #5, #6).
 *   - `callOpenAIText` — standard text completion. Used for generation prompts (#2, #3, #4).
 *
 * Uses `fetch` directly per AGENTS.md (no new dependencies without approval).
 * Both functions accept an optional `fetchFn` for test injection.
 */

const MODEL = "gpt-4.1-mini";
const OPENAI_TIMEOUT_MS = 45_000;
const MAX_TOKENS_JSON = 1024;
const MAX_TOKENS_TEXT = 512;

interface ChatCompletionResponse {
  choices: Array<{
    message: { content: string | null };
    finish_reason: string;
  }>;
}

export interface OpenAICallOptions {
  /** Override the model (default: gpt-5.4-mini). */
  model?: string;
  /** Override max tokens. */
  maxTokens?: number;
  /** Injectable fetch for testing. */
  fetchFn?: typeof fetch;
  /** Temperature (default: 0.7 for text, 0.3 for JSON). */
  temperature?: number;
  /** Optional strict Structured Outputs schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
}

/**
 * Call OpenAI with JSON mode enabled. Returns the parsed object or null
 * if the call fails or the response isn't valid JSON.
 *
 * The system prompt MUST include the word "JSON" — OpenAI requires this
 * when `response_format: { type: "json_object" }` is set.
 */
export async function callOpenAIJson<T>(
  systemPrompt: string,
  userContent: string,
  options: OpenAICallOptions = {},
): Promise<T | null> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const fetchFn = options.fetchFn ?? openaiFetch;
  const model = options.model ?? MODEL;
  const maxTokens = options.maxTokens ?? MAX_TOKENS_JSON;
  const temperature = options.temperature ?? 0.3;

  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        response_format: options.jsonSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: options.jsonSchema.name,
                strict: true,
                schema: options.jsonSchema.schema,
              },
            }
          : { type: "json_object" },
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`OpenAI JSON call failed: ${res.status} ${body}`);
      return null;
    }

    const json = (await res.json()) as ChatCompletionResponse;
    const raw = json.choices[0]?.message?.content?.trim();
    if (!raw) return null;

    return JSON.parse(raw) as T;
  } catch (err) {
    console.warn("OpenAI JSON call error:", err);
    return null;
  }
}

/**
 * Call OpenAI for a plain text response. Returns the text or an empty
 * string if the call fails.
 */
export async function callOpenAIText(
  systemPrompt: string,
  userContent: string,
  options: OpenAICallOptions = {},
): Promise<string> {
  const apiKey = env.OPENAI_API_KEY;
  if (!apiKey) return "";

  const fetchFn = options.fetchFn ?? openaiFetch;
  const model = options.model ?? MODEL;
  const maxTokens = options.maxTokens ?? MAX_TOKENS_TEXT;
  const temperature = options.temperature ?? 0.7;

  try {
    const res = await fetchFn("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        max_completion_tokens: maxTokens,
        temperature,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userContent },
        ],
      }),
      signal: AbortSignal.timeout(OPENAI_TIMEOUT_MS),
    });

    if (!res.ok) {
      const body = await res.text();
      console.warn(`OpenAI text call failed: ${res.status} ${body}`);
      return "";
    }

    const json = (await res.json()) as ChatCompletionResponse;
    return json.choices[0]?.message?.content?.trim() ?? "";
  } catch (err) {
    console.warn("OpenAI text call error:", err);
    return "";
  }
}
