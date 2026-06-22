import { env } from "../../config.js";
import { openaiFetch } from "../openai-fetch.js";
import type { ProviderError } from "./types.js";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const MODEL = "gpt-5.4-nano";
const DEFAULT_TIMEOUT_MS = 15_000;

export type DuplicatePairResult =
  | { ok: true; duplicate: boolean }
  | { ok: false; error: ProviderError };

export interface DuplicateClassifierOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export async function classifyDuplicatePairWithOpenAI(
  first: Buffer,
  second: Buffer,
  options: DuplicateClassifierOptions = {},
): Promise<DuplicatePairResult> {
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };
  if (first.byteLength === 0 || second.byteLength === 0) {
    return { ok: false, error: "invalid_response" };
  }

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  try {
    const response = await (options.fetchFn ?? openaiFetch)(OPENAI_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: MODEL,
        temperature: 0,
        max_completion_tokens: 16,
        messages: [
          {
            role: "system",
            content:
              "Determine whether the two images come from the same underlying photograph, " +
              "including crops, screenshots, filters, resizing, recompression, or minor edits. " +
              "Different photographs of the same person are not duplicates. Reply only true or false.",
          },
          {
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${first.toString("base64")}`,
                },
              },
              {
                type: "image_url",
                image_url: {
                  url: `data:image/jpeg;base64,${second.toString("base64")}`,
                },
              },
            ],
          },
        ],
      }),
    });

    if (!response.ok) return { ok: false, error: "api" };
    const payload = (await response.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const answer = payload.choices?.[0]?.message?.content
      ?.trim()
      .toLowerCase()
      .replace(/[.!]+$/u, "");
    if (answer === "true") return { ok: true, duplicate: true };
    if (answer === "false") return { ok: true, duplicate: false };
    return { ok: false, error: "invalid_response" };
  } catch (error) {
    const name = (error as { name?: string }).name;
    return {
      ok: false,
      error:
        name === "AbortError" || name === "TimeoutError" ? "timeout" : "api",
    };
  } finally {
    clearTimeout(timer);
  }
}
