import { env } from "../../config.js";
import { MODELS } from "../../models.js";
import { openaiFetch } from "../openai-fetch.js";
import {
  FEMALE_ATTRIBUTES,
  MALE_ATTRIBUTES,
  type RadarSet,
  type PhotoAttrs,
} from "@gennety/shared";
import type { AttractivenessImageInput } from "./score-attractiveness.js";

/**
 * Type Radar candidate tagging (PRODUCT_SPEC §Type Radar, step 6). A deliberately
 * ISOLATED vision pass — separate from the Elo attractiveness call — that
 * classifies a user's own appearance into the radar's categorical attributes
 * (hairColor / build / style / tattoos, plus hairLength for women / beard for
 * men) so the match engine can score it against a partner's `typePrefTags`
 * (`V_type`). Kept off the production attractiveness path on purpose: a tagging
 * regression must never perturb the live Elo seed. Uses the cheap `visionFast`
 * tier and only runs when `TYPE_RADAR_ENABLED` is on (zero cost while dark).
 */

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const TAG_MODEL = MODELS.visionFast;
const DEFAULT_TIMEOUT_MS = 30_000;

export type AppearanceTagResult =
  | { ok: true; tags: PhotoAttrs; model: string }
  | { ok: false; error: "disabled" | "api" | "timeout" | "no_signal" };

export interface TagOptions {
  openaiApiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

function attributesForSet(set: RadarSet): Record<string, readonly string[]> {
  return set === "female" ? FEMALE_ATTRIBUTES : MALE_ATTRIBUTES;
}

function buildInstruction(set: RadarSet): string {
  const attrs = attributesForSet(set);
  const lines = Object.entries(attrs).map(
    ([key, values]) => `- "${key}": one of [${values.map((v) => `"${v}"`).join(", ")}]`,
  );
  return [
    "You are shown several photos of the SAME person. Classify their appearance",
    "into the attributes below. Pick exactly ONE allowed value per attribute — the",
    "best fit across all the photos. For \"tattoos\", answer \"yes\" only if a tattoo",
    "is clearly visible on their body in any photo, otherwise \"no\". Judge hair",
    "color/length and build from the clearest photo. Do not invent attributes that",
    "are not listed.",
    "",
    "Attributes:",
    ...lines,
    "",
    'Return STRICT JSON exactly like: {"attributes": {' +
      Object.keys(attrs)
        .map((k) => `"${k}": "..."`)
        .join(", ") +
      "}}",
  ].join("\n");
}

/**
 * Classify one person's appearance from their profile photos into the radar
 * attribute schema for `set`. Aggregation is the model's job (it sees every
 * photo and returns one attribute set); we only validate values against the
 * allowed vocabulary and drop anything off-schema. Never throws.
 */
export async function tagAppearanceFromBuffers(
  images: readonly AttractivenessImageInput[],
  set: RadarSet,
  options: TagOptions = {},
): Promise<AppearanceTagResult> {
  const apiKey = options.openaiApiKey ?? env.OPENAI_API_KEY;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = options.fetchFn ?? openaiFetch;

  if (!apiKey) return { ok: false, error: "disabled" };
  if (images.length === 0) return { ok: false, error: "api" };

  const content = [
    { type: "text", text: buildInstruction(set) },
    ...images.flatMap((image, index) => [
      { type: "text", text: `Photo ${index + 1}` },
      {
        type: "image_url",
        image_url: {
          url: `data:${image.mime || "image/jpeg"};base64,${image.buffer.toString("base64")}`,
        },
      },
    ]),
  ];

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
        model: TAG_MODEL,
        max_completion_tokens: 300,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You are a careful visual classifier. You only ever output the allowed values.",
          },
          { role: "user", content },
        ],
      }),
    });
    if (!res.ok) return { ok: false, error: "api" };

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = json.choices?.[0]?.message?.content?.trim() ?? "";
    let parsed: { attributes?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw) as { attributes?: Record<string, unknown> };
    } catch {
      return { ok: false, error: "api" };
    }

    const tags = validateTags(parsed.attributes, set);
    if (Object.keys(tags).length === 0) return { ok: false, error: "no_signal" };
    return { ok: true, tags, model: TAG_MODEL };
  } catch (err) {
    if ((err as { name?: string }).name === "AbortError") {
      return { ok: false, error: "timeout" };
    }
    return { ok: false, error: "api" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Keep only attributes in the set's schema whose value is in the allowed list.
 * Exported for unit testing the validation independently of the network call.
 */
export function validateTags(
  attributes: Record<string, unknown> | undefined,
  set: RadarSet,
): PhotoAttrs {
  const allowed = attributesForSet(set);
  const out: PhotoAttrs = {};
  if (!attributes || typeof attributes !== "object") return out;
  for (const [key, values] of Object.entries(allowed)) {
    const value = attributes[key];
    if (typeof value === "string" && (values as readonly string[]).includes(value)) {
      out[key] = value;
    }
  }
  return out;
}
