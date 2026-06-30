import { env } from "../../config.js";
import type {
  ModerationProviderResult,
  ModerationSignal,
  ProviderError,
} from "./types.js";

const MODERATION_ENDPOINT = "https://api.openai.com/v1/moderations";
const MODERATION_MODEL = "omni-moderation-latest";
const DEFAULT_TIMEOUT_MS = 15_000;

// The coarse `sexual` boolean is intentionally NOT a hard block for images:
// omni-moderation flags ordinary revealing dating photos (swimwear, lingerie,
// bare torso, cleavage) as `sexual`, which was a real false-positive source for
// the adult-audience product. The precise explicit-nudity line (exposed
// genitalia / female breast) is drawn by AWS Rekognition's granular taxonomy in
// `awsModerationSeverity`. `sexual/minors` stays an absolute block (CSAM).
const IMAGE_BLOCK_CATEGORIES = new Set([
  "sexual/minors",
  "self-harm",
  "violence/graphic",
]);

const IMAGE_REVIEW_CATEGORIES = new Set([
  "violence",
]);

const TEXT_BLOCK_CATEGORIES = new Set([
  "sexual",
  "sexual/minors",
  "self-harm",
  "self-harm/intent",
  "self-harm/instructions",
  "violence/graphic",
]);

const TEXT_REVIEW_CATEGORIES = new Set([
  "harassment/threatening",
  "hate/threatening",
  "illicit/violent",
  "violence",
]);

interface OpenAIModerationResponse {
  results?: Array<{
    flagged?: boolean;
    categories?: Record<string, boolean>;
    category_scores?: Record<string, number>;
  }>;
}

export interface OpenAIModerationOptions {
  apiKey?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

export async function moderateImageWithOpenAI(
  buffer: Buffer,
  mime: string,
  options: OpenAIModerationOptions = {},
): Promise<ModerationProviderResult> {
  if (buffer.byteLength === 0) {
    return { ok: false, error: "invalid_response" };
  }

  const dataUrl = `data:${mime || "image/jpeg"};base64,${buffer.toString("base64")}`;
  return callModeration(
    [
      {
        type: "image_url",
        image_url: { url: dataUrl },
      },
    ],
    IMAGE_BLOCK_CATEGORIES,
    IMAGE_REVIEW_CATEGORIES,
    options,
  );
}

export async function moderateTextWithOpenAI(
  text: string,
  options: OpenAIModerationOptions = {},
): Promise<ModerationProviderResult> {
  const trimmed = text.trim();
  if (!trimmed) return { ok: true, signals: [] };

  return callModeration(
    trimmed,
    TEXT_BLOCK_CATEGORIES,
    TEXT_REVIEW_CATEGORIES,
    options,
  );
}

async function callModeration(
  input: string | Array<Record<string, unknown>>,
  blockCategories: ReadonlySet<string>,
  reviewCategories: ReadonlySet<string>,
  options: OpenAIModerationOptions,
): Promise<ModerationProviderResult> {
  const apiKey = options.apiKey ?? env.OPENAI_API_KEY;
  if (!apiKey) return { ok: false, error: "not_configured" };

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(MODERATION_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODERATION_MODEL,
        input,
      }),
      signal: controller.signal,
    });

    if (!response.ok) return { ok: false, error: "api" };

    const payload = (await response.json()) as OpenAIModerationResponse;
    const result = payload.results?.[0];
    if (!result || typeof result.flagged !== "boolean") {
      return { ok: false, error: "invalid_response" };
    }

    const categories = result.categories ?? {};
    const scores = result.category_scores ?? {};
    const signals: ModerationSignal[] = [];

    for (const [category, flagged] of Object.entries(categories)) {
      if (!flagged) continue;
      const severity = blockCategories.has(category)
        ? "block"
        : reviewCategories.has(category)
          ? "review"
          : null;
      if (!severity) continue;
      signals.push({
        provider: "openai",
        category,
        score: clampScore(scores[category]),
        severity,
      });
    }

    // NB: we intentionally do NOT escalate a bare `result.flagged` with no
    // mapped category into a review signal. The omni-moderation model flags
    // images for many soft categories we don't gate on (and sometimes
    // borderline-false on ordinary photos); turning that catch-all into a hard
    // reject was a real false-positive source on normal profile photos. Only
    // the explicitly-mapped block/review categories above can reject media.
    return { ok: true, signals };
  } catch (error) {
    return {
      ok: false,
      error: providerError(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

function clampScore(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function providerError(error: unknown): ProviderError {
  const name = (error as { name?: string }).name;
  return name === "AbortError" || name === "TimeoutError" ? "timeout" : "api";
}
