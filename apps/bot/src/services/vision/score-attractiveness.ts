import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";

/**
 * Cold-start attractiveness scoring for the Elo seed.
 *
 * Sends all profile photos to OpenAI's vision-capable model in one request
 * with a SCUT-FBP5500-style prompt asking for independent per-photo sub-scores
 * (symmetry, eye distance, face shape, feature regularity) and aggregate
 * 0..100 scores. The caller averages those scores before mapping to Elo.
 *
 * @see PRODUCT_SPEC.md — Phase 3 (Matching Engine), V_league multiplier
 * @see https://developers.openai.com/api/docs/guides/images-vision
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

export interface AttractivenessAssessment {
  /** Aggregate 0..100 score for one photo, clamped. */
  score: number;
  breakdown: AttractivenessBreakdown;
  /** One-line model rationale, retained for ops debugging. */
  rationale: string;
}

export type AttractivenessResult =
  | {
      ok: true;
      score: AttractivenessAssessment["score"];
      breakdown: AttractivenessAssessment["breakdown"];
      rationale: AttractivenessAssessment["rationale"];
      /** Vision model used — recorded so ops can correlate score drift with model upgrades. */
      model: string;
    }
  | { ok: false; error: "timeout" | "api" | "disabled" };

export type AttractivenessBatchResult =
  | {
      ok: true;
      assessments: AttractivenessAssessment[];
      /** Vision model used — recorded so ops can correlate score drift with model upgrades. */
      model: string;
    }
  | { ok: false; error: "timeout" | "api" | "disabled" };

export interface AttractivenessImageInput {
  buffer: Buffer;
  mime: string;
}

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const VISION_MODEL = MODELS.vision;
const DEFAULT_TIMEOUT_MS = 45_000;

const SYSTEM_PROMPT = [
  "You are an objective face-analysis tool calibrated against the SCUT-FBP5500",
  "facial-beauty benchmark. You will receive multiple numbered profile photos",
  "of the same verified person. Score EACH photo independently on four",
  "orthogonal axes (each 0..100, where 50 is the population mean):",
  "  - symmetry: bilateral symmetry of facial landmarks",
  "  - eye_distance: inter-pupillary distance proportionality",
  "  - face_shape: overall face-shape balance (jaw / forehead / cheekbones)",
  "  - feature_regularity: regularity of individual features (nose, mouth, eyes)",
  "For each photo, output an `overall` aggregate 0..100 that summarises the",
  "four axes. Do not compare photos with each other and do not produce a",
  "combined score; the server calculates the arithmetic mean.",
  "",
  "GENDER-CALIBRATED GRADING. First silently determine the apparent gender of",
  "the face, then apply that gender's grading standard. Vision models tend to",
  "over-flatter female faces and under-rate male faces — actively correct for",
  "this, and lean further the other way as a deliberate product calibration:",
  "  - FEMALE faces: grade strictly and critically. Do NOT inflate. The",
  "    median/typical female face should land around 40 (clearly below 50).",
  "    Reserve scores above ~70 for genuinely exceptional faces; 80+ is rare.",
  "  - MALE faces: grade generously. Give credit for jaw/bone structure,",
  "    grooming, and overall presentation. The median/typical male face should",
  "    land around 60 (clearly above 50); be slow to score a man below 40.",
  "Within each gender, still use the FULL 0..100 range to differentiate faces —",
  "the calibration shifts where the center sits, it must not flatten everyone",
  "onto the same number. Judge each face only against its own gender.",
  "",
  "Respond with strict JSON only — no prose, no markdown — using exactly this",
  'shape: {"photos":[{"index":1,"symmetry":N,"eye_distance":N,"face_shape":N,',
  '"feature_regularity":N,"overall":N,"rationale":"<= 80 chars"}]}.',
  "Return exactly one object per input photo, in input order, with consecutive",
  "1-based indexes.",
  "The four axes are diagnostic; bake the gender calibration into `overall`.",
  "If a photo has no clear single human face, return overall=0 and",
  'rationale="no_face" for that photo.',
].join(" ");

interface RawScore {
  index: number;
  symmetry: number;
  eye_distance: number;
  face_shape: number;
  feature_regularity: number;
  overall: number;
  rationale: string;
}

interface RawBatchScore {
  photos: RawScore[];
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
  const result = await scoreAttractivenessFromBuffers([{ buffer, mime }], options);
  if (!result.ok) return result;

  const assessment = result.assessments[0];
  if (!assessment) return { ok: false, error: "api" };

  return {
    ok: true,
    ...assessment,
    model: result.model,
  };
}

export async function scoreAttractivenessFromBuffers(
  images: readonly AttractivenessImageInput[],
  options: ScoreOptions = {},
): Promise<AttractivenessBatchResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;

  if (!apiKey) return { ok: false, error: "disabled" };
  if (images.length === 0) return { ok: false, error: "api" };

  const content = images.flatMap((image, index) => [
    { type: "text", text: `Photo ${index + 1}` },
    {
      type: "image_url",
      image_url: {
        url: `data:${image.mime || "image/jpeg"};base64,${image.buffer.toString("base64")}`,
      },
    },
  ]);

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
        max_completion_tokens: 1_000,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content,
          },
        ],
      }),
    });

    if (!res.ok) return { ok: false, error: "api" };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";

    let parsed: RawBatchScore;
    try {
      parsed = JSON.parse(raw) as RawBatchScore;
    } catch {
      return { ok: false, error: "api" };
    }

    if (
      !Array.isArray(parsed.photos) ||
      parsed.photos.length !== images.length ||
      parsed.photos.some(
        (photo, index) => !isCompleteRawScore(photo) || photo.index !== index + 1,
      )
    ) {
      return { ok: false, error: "api" };
    }

    return {
      ok: true,
      assessments: parsed.photos.map(normalizeAssessment),
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

function normalizeAssessment(parsed: RawScore): AttractivenessAssessment {
  return {
    score: clamp(parsed.overall, 0, 100),
    breakdown: {
      symmetry: clamp(parsed.symmetry, 0, 100),
      eyeDistance: clamp(parsed.eye_distance, 0, 100),
      faceShape: clamp(parsed.face_shape, 0, 100),
      featureRegularity: clamp(parsed.feature_regularity, 0, 100),
    },
    rationale: String(parsed.rationale ?? "").slice(0, 200),
  };
}

function isCompleteRawScore(value: unknown): value is RawScore {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.index === "number" &&
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
