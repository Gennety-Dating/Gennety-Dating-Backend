import { prisma } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import { parseLLMDumpPrompt } from "@gennety/shared";
import { env } from "../config.js";
import { callOpenAIJson } from "./openai.js";

/**
 * Profile analysis service.
 *
 * Takes a raw LLM dump text, uses the `parseLLMDumpPrompt` system prompt
 * with OpenAI JSON mode to extract a structured profile, generates an
 * embedding for semantic match search, and persists both on the profile row.
 *
 * The embedding column is declared as `Unsupported("vector(1536)")` in
 * schema.prisma, so it must be written via raw SQL with a `::vector` cast.
 */

export interface LegacyProfileSummary {
  personality_traits?: string[];
  communication_style?: string;
  interests?: string[];
  values?: string[];
  attachment_style?: string;
  social_energy?: string;
  humor_style?: string;
  ideal_partner?: string;
  dealbreakers?: string[];
  summary?: string;
}

export type EvidenceKind = "explicit" | "pattern" | "inference";

export interface EvidenceSignal {
  signal: string;
  basis: string;
  kind: EvidenceKind;
}

export const EVIDENCE_SECTION_KEYS = [
  "relationships",
  "emotions_and_conflict",
  "needs_and_boundaries",
  "values_in_action",
  "life_rhythm_and_social_energy",
  "sustained_interests",
  "partner_fit",
  "likely_friction",
] as const;

export type EvidenceSectionKey = (typeof EVIDENCE_SECTION_KEYS)[number];

export interface ParsedProfileSummary extends LegacyProfileSummary {
  schema_version?: 2;
  relationships?: EvidenceSignal[];
  emotions_and_conflict?: EvidenceSignal[];
  needs_and_boundaries?: EvidenceSignal[];
  values_in_action?: EvidenceSignal[];
  life_rhythm_and_social_energy?: EvidenceSignal[];
  sustained_interests?: EvidenceSignal[];
  partner_fit?: EvidenceSignal[];
  likely_friction?: EvidenceSignal[];
  grounded_summary?: string | null;
}

export interface EvidenceProfileSummary extends ParsedProfileSummary {
  schema_version: 2;
  relationships: EvidenceSignal[];
  emotions_and_conflict: EvidenceSignal[];
  needs_and_boundaries: EvidenceSignal[];
  values_in_action: EvidenceSignal[];
  life_rhythm_and_social_energy: EvidenceSignal[];
  sustained_interests: EvidenceSignal[];
  partner_fit: EvidenceSignal[];
  likely_friction: EvidenceSignal[];
  grounded_summary: string | null;
}

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

/**
 * Try to extract a JSON object from free-form text. Looks for the first
 * `{` … matching `}` fragment and attempts `JSON.parse`. Used as a
 * fallback when the LLM JSON-mode call is unavailable.
 *
 * Also strips common markdown fences (```json ... ```) that some LLMs
 * still add even when told not to.
 */
export function extractJsonSummary(text: string): ParsedProfileSummary | null {
  // Strip ```json / ``` fences if present — LLMs sometimes wrap the object
  // despite being told not to.
  const fenceStripped = text
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "");

  const start = fenceStripped.indexOf("{");
  const end = fenceStripped.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;

  const candidate = fenceStripped.slice(start, end + 1);
  try {
    const parsed = JSON.parse(candidate);
    if (parsed && typeof parsed === "object") {
      return parsed as ParsedProfileSummary;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Check whether an extracted JSON object has the minimum shape we need to
 * skip the server-side LLM parse entirely. The fast-path is intentionally
 * strict: if ANY required field is missing or malformed we fall back to
 * the LLM parser, which is more forgiving of partial output.
 */
export function isValidFastPathSummary(
  parsed: unknown,
): parsed is ParsedProfileSummary {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;

  if (p.schema_version === 2) return isEvidenceProfileSummary(parsed);

  const hasStringArray = (v: unknown, min: number, max: number): boolean =>
    Array.isArray(v) &&
    v.length >= min &&
    v.length <= max &&
    v.every(
      (x) => typeof x === "string" && x.trim().length > 0 && x.length <= 2_000,
    );

  const hasNonEmptyString = (v: unknown): boolean =>
    typeof v === "string" && v.trim().length > 0 && v.length <= 4_000;

  return (
    hasStringArray(p.personality_traits, 3, 10) &&
    hasStringArray(p.interests, 2, 20) &&
    hasStringArray(p.values, 2, 20) &&
    hasStringArray(p.dealbreakers, 1, 20) &&
    hasNonEmptyString(p.communication_style) &&
    hasNonEmptyString(p.attachment_style) &&
    hasNonEmptyString(p.social_energy) &&
    hasNonEmptyString(p.humor_style) &&
    hasNonEmptyString(p.ideal_partner) &&
    hasNonEmptyString(p.summary)
  );
}

/**
 * Strict V2 validator. All sections must be present, but every one may be
 * empty. This is the load-bearing difference from V1: "no evidence" is a
 * valid result and must not trigger a second model that fills the gaps.
 */
export function isEvidenceProfileSummary(
  parsed: unknown,
): parsed is EvidenceProfileSummary {
  if (!parsed || typeof parsed !== "object") return false;
  const p = parsed as Record<string, unknown>;
  if (p.schema_version !== 2) return false;

  const validKind = (value: unknown): value is EvidenceKind =>
    value === "explicit" || value === "pattern" || value === "inference";
  const validItem = (value: unknown): value is EvidenceSignal => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
      typeof item.signal === "string" &&
      item.signal.trim().length > 0 &&
      item.signal.length <= 240 &&
      typeof item.basis === "string" &&
      item.basis.trim().length > 0 &&
      item.basis.length <= 500 &&
      validKind(item.kind)
    );
  };

  for (const key of EVIDENCE_SECTION_KEYS) {
    const section = p[key];
    if (!Array.isArray(section) || section.length > 3 || !section.every(validItem)) {
      return false;
    }
  }

  // A model that has no summary should emit `null`, but some emit an empty or
  // whitespace-only string instead. Treat that as "no summary" rather than
  // rejecting an otherwise-valid payload (which would needlessly discard real
  // section evidence and force a repair round).
  if (typeof p.grounded_summary === "string" && p.grounded_summary.trim().length === 0) {
    p.grounded_summary = null;
  }
  const grounded = p.grounded_summary;
  if (
    grounded !== null &&
    (typeof grounded !== "string" || grounded.length > 1_200)
  ) {
    return false;
  }

  const hasEvidence = EVIDENCE_SECTION_KEYS.some(
    (key) => (p[key] as EvidenceSignal[]).length > 0,
  );
  return hasEvidence || grounded === null;
}

/**
 * Parse a raw LLM dump.
 *
 * Fast path: if the user's paste is already a valid JSON object matching
 * our schema (because their LLM followed the Magic Prompt), return it
 * directly — no second OpenAI call.
 *
 * Slow path: send the raw text to OpenAI JSON mode with
 * `parseLLMDumpPrompt`. Invalid output is rejected; raw text is never used as
 * a persisted profile fallback.
 */
export async function parseDumpWithLLM(
  rawDump: string,
  firstName: string,
  language: string,
): Promise<ParsedProfileSummary | null> {
  const fastPathCandidate = extractJsonSummary(rawDump);
  if (fastPathCandidate && isValidFastPathSummary(fastPathCandidate)) {
    return fastPathCandidate;
  }

  const systemPrompt = parseLLMDumpPrompt({ firstName, language });
  const result = await callOpenAIJson<unknown>(
    systemPrompt,
    rawDump.slice(0, 12_000), // cap input to stay within context limits
    { maxTokens: 3_000, temperature: 0.2 },
  );
  if (isValidFastPathSummary(result)) {
    return result;
  }
  // Do not save a partial object or the raw dump as a profile. The caller can
  // safely ask for a retry while a valid old or V2 JSON paste still works
  // without this server-side model call.
  return null;
}

/**
 * Build a single compact text representation of the profile used as input
 * for the embedding model. Deterministic key order keeps embeddings stable
 * across re-runs with the same data.
 */
export function buildEmbeddingInput(
  parsed: ParsedProfileSummary | null,
  raw: string,
): string {
  if (!parsed) return raw.slice(0, 8000);

  if (isEvidenceProfileSummary(parsed)) {
    const parts: string[] = [];
    const grounded = parsed.grounded_summary?.trim();
    if (grounded) parts.push(`Summary: ${grounded}`);

    const labels: Record<EvidenceSectionKey, string> = {
      relationships: "Relationships",
      emotions_and_conflict: "Emotions and conflict",
      needs_and_boundaries: "Needs and boundaries",
      values_in_action: "Values in action",
      life_rhythm_and_social_energy: "Life rhythm and social energy",
      sustained_interests: "Sustained interests",
      partner_fit: "Partner fit",
      likely_friction: "Likely friction",
    };
    for (const key of EVIDENCE_SECTION_KEYS) {
      const signals = parsed[key].map((item) => item.signal.trim()).filter(Boolean);
      if (signals.length) parts.push(`${labels[key]}: ${signals.join("; ")}`);
    }
    return parts.join("\n").slice(0, 8000);
  }

  const parts: string[] = [];
  if (parsed.summary) parts.push(`Summary: ${parsed.summary}`);
  if (parsed.personality_traits?.length) {
    parts.push(`Personality: ${parsed.personality_traits.join(", ")}`);
  }
  if (parsed.communication_style) {
    parts.push(`Communication: ${parsed.communication_style}`);
  }
  if (parsed.interests?.length) {
    parts.push(`Interests: ${parsed.interests.join(", ")}`);
  }
  if (parsed.values?.length) {
    parts.push(`Values: ${parsed.values.join(", ")}`);
  }
  if (parsed.attachment_style) {
    parts.push(`Attachment: ${parsed.attachment_style}`);
  }
  if (parsed.social_energy) {
    parts.push(`Social energy: ${parsed.social_energy}`);
  }
  if (parsed.humor_style) {
    parts.push(`Humor: ${parsed.humor_style}`);
  }
  if (parsed.ideal_partner) {
    parts.push(`Ideal partner: ${parsed.ideal_partner}`);
  }
  if (parsed.dealbreakers?.length) {
    parts.push(`Dealbreakers: ${parsed.dealbreakers.join(", ")}`);
  }
  return parts.join("\n").slice(0, 8000);
}

export interface EmbeddingClient {
  embed(input: string): Promise<number[]>;
}

export interface FallbackProfileAnalysisInput {
  firstName: string;
  age: number;
  gender: string;
  preference: string;
  height: number;
  ethnicity: string | null;
  hobbies: string[];
  partnerPreferences: string;
  homeCityKey: string;
  /**
   * Vibe answers (PRODUCT_SPEC §1.3). Folded into the embedding text so a
   * declined-Magic-Prompt profile still carries real psychological signal.
   */
  fridayVibe?: string | null;
  vibeFocus?: string | null;
  /** Why ordinary onboarding answers are being used for the base profile. */
  source?: "declined" | "no_relevant_ai_memory";
}

/**
 * Default OpenAI embedding client backed by the REST API. Uses `fetch`
 * directly so we don't pull in the `openai` package (see AGENTS.md — no
 * new dependencies without approval).
 */
const EMBEDDING_TIMEOUT_MS = 30_000;

export function createOpenAIEmbeddingClient(apiKey: string): EmbeddingClient {
  return {
    async embed(input: string): Promise<number[]> {
      const res = await openaiFetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input }),
        signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`OpenAI embeddings failed: ${res.status} ${body}`);
      }
      const json = (await res.json()) as {
        data: Array<{ embedding: number[] }>;
      };
      const vec = json.data?.[0]?.embedding;
      if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIMS) {
        throw new Error(`Unexpected embedding shape: length ${vec?.length}`);
      }
      return vec;
    },
  };
}

/**
 * Format a number[] as pgvector literal: `[0.1,0.2,...]`. Used inside a
 * parameterised raw query so no SQL injection surface.
 */
export function toPgVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

/**
 * Persist the parsed summary (raw text) and the embedding on the profile
 * row. The embedding is written via raw SQL because Prisma lists `vector`
 * as `Unsupported`.
 */
export async function saveProfileAnalysis(
  userId: string,
  rawSummary: string,
  embedding: number[] | null,
): Promise<boolean> {
  const embeddingDirtyAt = new Date();
  await prisma.profile.upsert({
    where: { userId },
    create: {
      userId,
      psychologicalSummary: rawSummary,
      embeddingDirty: true,
      embeddingDirtyAt,
    },
    update: {
      psychologicalSummary: rawSummary,
      embeddingDirty: true,
      embeddingDirtyAt,
    },
  });
  if (!embedding) return false;

  const literal = toPgVectorLiteral(embedding);
  const updated = await prisma.$executeRaw`
    UPDATE profiles
       SET embedding = ${literal}::vector,
           embedding_dirty = false,
           embedding_dirty_at = NULL
     WHERE user_id = ${userId}::uuid
       AND embedding_dirty_at IS NOT DISTINCT FROM ${embeddingDirtyAt}
  `;
  return updated > 0;
}

/**
 * Render the vibe answers into a compact natural-language block for the
 * embedding. Returns "" when neither answer is present. Shared by the fallback
 * builder and the accepted-path summary append so the wording stays identical.
 */
export function buildVibeBlock(
  fridayVibe?: string | null,
  vibeFocus?: string | null,
): string {
  const parts: string[] = [];
  const friday = fridayVibe?.trim();
  const focus = vibeFocus?.trim();
  if (friday) parts.push(`Ideal Friday night: ${friday}`);
  if (focus) parts.push(`What matters most on a night out: ${focus}`);
  return parts.join("\n");
}

/**
 * Build the embedding text for a profile that declined the Magic Prompt.
 *
 * Demographics (name, age, gender, preference, height, dating city) are
 * DELIBERATELY excluded: they are already scored by `V_research` and the hard
 * SQL filters, and as near-identical boilerplate they used to wash out the
 * embedding's discriminative power (PRODUCT_SPEC §3.2). What remains is genuine
 * open-ended signal — hobbies, partner preferences, ethnicity, and the vibe.
 */
export function buildFallbackProfileAnalysis(
  input: FallbackProfileAnalysisInput,
): string {
  const source = input.source ?? "declined";
  const lines = [
    source === "no_relevant_ai_memory"
      ? "Profile source: onboarding answers (AI memory contained no supported dating signals)"
      : "Profile source: onboarding answers (AI memory export declined)",
    `Ethnicity/nationality: ${input.ethnicity?.trim() || "not provided"}`,
    `Hobbies/interests: ${input.hobbies.length ? input.hobbies.join(", ") : "none provided"}`,
    `Partner preferences: ${input.partnerPreferences}`,
  ];
  const vibe = buildVibeBlock(input.fridayVibe, input.vibeFocus);
  if (vibe) lines.push(vibe);
  return lines.join("\n");
}

export async function saveFallbackProfileAnalysis(
  userId: string,
  input: FallbackProfileAnalysisInput,
  client?: EmbeddingClient,
): Promise<{ summary: string; embeddingSaved: boolean }> {
  const summary = buildFallbackProfileAnalysis(input);
  const embeddingClient =
    client ?? (env.OPENAI_API_KEY ? createOpenAIEmbeddingClient(env.OPENAI_API_KEY) : null);

  let embedding: number[] | null = null;
  if (embeddingClient) {
    try {
      embedding = await embeddingClient.embed(summary);
    } catch (err) {
      console.warn("Fallback embedding generation failed, continuing without it:", err);
    }
  }

  const embeddingSaved = await saveProfileAnalysis(userId, summary, embedding);
  return { summary, embeddingSaved };
}

/**
 * High-level orchestrator used by the bot handler. Parses the dump through
 * the strict V1/V2 pipeline, generates an embedding when `OPENAI_API_KEY` is
 * present, and saves only validated, redacted profile text. Never persists
 * the raw import when parsing or repair fails.
 */
export async function analyseAndSaveProfile(
  userId: string,
  rawDump: string,
  client?: EmbeddingClient,
  userMeta?: { firstName?: string; language?: string },
): Promise<{ parsed: ParsedProfileSummary | null; embeddingSaved: boolean }> {
  const firstName = userMeta?.firstName ?? "User";
  const language = userMeta?.language ?? "en";

  let parsed: ParsedProfileSummary | null;
  try {
    parsed = await parseDumpWithLLM(rawDump, firstName, language);
  } catch {
    const candidate = extractJsonSummary(rawDump);
    parsed = isValidFastPathSummary(candidate) ? candidate : null;
  }

  const embeddingClient =
    client ?? (env.OPENAI_API_KEY ? createOpenAIEmbeddingClient(env.OPENAI_API_KEY) : null);

  // Reject an unparseable payload instead of persisting the raw dump. A valid
  // V1/V2 JSON response takes the fast path; prose/partial JSON gets one
  // evidence-only repair attempt above.
  if (!parsed) return { parsed: null, embeddingSaved: false };

  // Build the compact text used for both embedding and persistence. Evidence
  // bases served their grounding purpose at import time; only the redacted
  // signals are retained, so private third-party context is not exposed in the
  // user's profile or future prompts.
  const sanitisedSummary = buildEmbeddingInput(parsed, rawDump);

  let embedding: number[] | null = null;
  if (embeddingClient && sanitisedSummary.trim()) {
    try {
      embedding = await embeddingClient.embed(sanitisedSummary);
    } catch (err) {
      console.warn("Embedding generation failed, continuing without it:", err);
    }
  }

  const embeddingSaved = await saveProfileAnalysis(
    userId,
    sanitisedSummary,
    embedding,
  );
  return { parsed, embeddingSaved };
}

/**
 * Accepted-Magic-Prompt path: append the vibe block to the existing
 * `psychologicalSummary` and re-mark the embedding dirty so the
 * `embedding-refresh` worker re-embeds with the vibe included. The declined
 * path already bakes the vibe into the fallback summary, so this is only for
 * profiles whose summary came from the Magic Prompt.
 *
 * Idempotent: a finalize retry that re-appends is a no-op because the block is
 * already present. No-op when there is no vibe text or no profile.
 */
export async function appendVibeToSummary(
  userId: string,
  fridayVibe?: string | null,
  vibeFocus?: string | null,
): Promise<void> {
  const block = buildVibeBlock(fridayVibe, vibeFocus);
  if (!block) return;

  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { psychologicalSummary: true },
  });
  if (!profile) return;

  const summary = profile.psychologicalSummary ?? "";
  if (summary.includes(block)) return; // already folded in

  await prisma.profile.update({
    where: { userId },
    data: {
      psychologicalSummary: summary ? `${summary}\n${block}` : block,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });
}
