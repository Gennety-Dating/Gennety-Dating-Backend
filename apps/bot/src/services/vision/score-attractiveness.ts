import { env } from "../../config.js";

/**
 * Cold-start attractiveness scoring for the Elo seed.
 *
 * Sends a profile photo to OpenAI's vision-capable model with a SCUT-FBP5500-
 * style prompt asking for objective sub-scores (symmetry, eye distance, face
 * shape, feature regularity) and an aggregate 0..100 score. The aggregate is
 * mapped to the universal Elo range by `services/elo/seed-from-vision.ts`.
 *
 * @see PRODUCT_SPEC.md — Phase 3 (Matching Engine), V_league multiplier
 * @see https://platform.openai.com/docs/guides/vision
 *
 * The model is asked to return strict JSON (`response_format: json_object`),
 * so the parser is intentionally narrow: any deviation from the expected
 * shape returns `{ ok: false, error: "api" }` and the caller skips seeding.
 *
 * Failure modes are deliberately *not* "fail open": silently leaving everyone
 * at the default 500 would defeat the whole point of the seed. The caller is
 * expected to treat any non-`ok` result as "skip — try on the next webhook".
 */

export interface AttractivenessBreakdown {
  /** Bilateral symmetry of facial landmarks, 0..100. */
  symmetry: number;
  /** Inter-pupillary distance proportionality, 0..100. */
  eyeDistance: number;
  /** Overall face-shape balance (jawline, forehead, cheekbones), 0..100. */
  faceShape: number;
  /** Regularity of individual features (nose, mouth, eyes), 0..100. */
  featureRegularity: number;
}

export type AttractivenessResult =
  | {
      ok: true;
      /** Aggregate 0..100 score, clamped. */
      score: number;
      breakdown: AttractivenessBreakdown;
      /** One-line model rationale, retained for ops debugging. */
      rationale: string;
      /** Vision model used — recorded so ops can correlate score drift with model upgrades. */
      model: string;
    }
  | { ok: false; error: "timeout" | "api" | "disabled" };

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VISION_MODEL = "gpt-5.4-nano";
const DEFAULT_TIMEOUT_MS = 15_000;

const SYSTEM_PROMPT = [
  "You are an objective face-analysis tool calibrated against the SCUT-FBP5500",
  "facial-beauty benchmark. Given a single photo, score the visible face on",
  "four orthogonal axes (each 0..100, where 50 is the population mean):",
  "  - symmetry: bilateral symmetry of facial landmarks",
  "  - eye_distance: inter-pupillary distance proportionality",
  "  - face_shape: overall face-shape balance (jaw / forehead / cheekbones)",
  "  - feature_regularity: regularity of individual features (nose, mouth, eyes)",
  "Then output an `overall` aggregate 0..100 that summarises the four axes.",
  "Respond with strict JSON only — no prose, no markdown — using exactly these",
  'keys: {"symmetry":N,"eye_distance":N,"face_shape":N,"feature_regularity":N,',
  '"overall":N,"rationale":"<= 80 chars"}.',
  "If no clear single human face is visible, return overall=0 and rationale=\"no_face\".",
].join(" ");

interface RawScore {
  symmetry: number;
  eye_distance: number;
  face_shape: number;
  feature_regularity: number;
  overall: number;
  rationale: string;
}

export interface ScoreOptions {
  openaiApiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

export async function scoreAttractivenessFromBuffer(
  buffer: Buffer,
  mime: string,
  options: ScoreOptions = {},
): Promise<AttractivenessResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? fetch;

  if (!apiKey) return { ok: false, error: "disabled" };

  const dataUrl = `data:${mime || "image/jpeg"};base64,${buffer.toString("base64")}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchFn(OPENAI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: VISION_MODEL,
        max_completion_tokens: 200,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content: [{ type: "image_url", image_url: { url: dataUrl } }],
          },
        ],
      }),
    });

    if (!res.ok) return { ok: false, error: "api" };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: RawScore;
    try {
      parsed = JSON.parse(raw) as RawScore;
    } catch {
      return { ok: false, error: "api" };
    }

    if (!isCompleteRawScore(parsed)) return { ok: false, error: "api" };

    return {
      ok: true,
      score: clamp(parsed.overall, 0, 100),
      breakdown: {
        symmetry: clamp(parsed.symmetry, 0, 100),
        eyeDistance: clamp(parsed.eye_distance, 0, 100),
        faceShape: clamp(parsed.face_shape, 0, 100),
        featureRegularity: clamp(parsed.feature_regularity, 0, 100),
      },
      rationale: String(parsed.rationale ?? "").slice(0, 200),
      model: VISION_MODEL,
    };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

function isCompleteRawScore(value: unknown): value is RawScore {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.symmetry === "number" &&
    typeof v.eye_distance === "number" &&
    typeof v.face_shape === "number" &&
    typeof v.feature_regularity === "number" &&
    typeof v.overall === "number"
  );
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
