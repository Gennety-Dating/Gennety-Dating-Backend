import { prisma } from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import { env } from "../config.js";

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMS = 1536;

export interface EmbeddingClient {
  embed(input: string): Promise<number[]>;
  /**
   * Embed a whole batch in ONE request.
   *
   * The Embeddings API takes up to 2048 inputs per call, and the weekly
   * preflight has thousands of dirty profiles to refresh before matching can
   * run. Asking for them one at a time turned that into a serial wall of HTTP
   * round-trips in front of the drop. Order is part of the contract: the
   * returned vectors line up with the inputs, index for index.
   */
  embedMany(inputs: string[]): Promise<number[][]>;
}

export interface QuestionnaireProfileAnalysisInput {
  firstName: string;
  age: number;
  gender: string;
  preference: string;
  height: number;
  hobbies: string[];
  partnerPreferences: string;
  homeCityKey: string;

  fridayVibe?: string | null;
  vibeFocus?: string | null;
}

/**
 * Default OpenAI embedding client backed by the REST API. Uses `fetch`
 * directly so we don't pull in the `openai` package (see AGENTS.md — no
 * new dependencies without approval).
 */
const EMBEDDING_TIMEOUT_MS = 30_000;

export function createOpenAIEmbeddingClient(apiKey: string): EmbeddingClient {
  async function embedMany(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) return [];
    const res = await openaiFetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: inputs }),
      // One request carrying many inputs is legitimately slower than one
      // carrying a single input, so the deadline scales with the batch — but
      // stays bounded, because the caller's own timeout is what leaves the rows
      // dirty for a retry rather than hanging the preflight.
      signal: AbortSignal.timeout(EMBEDDING_TIMEOUT_MS + inputs.length * 100),
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`OpenAI embeddings failed: ${res.status} ${body}`);
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[]; index?: number }>;
    };
    const rows = json.data;
    if (!Array.isArray(rows) || rows.length !== inputs.length) {
      throw new Error(
        `Unexpected embeddings response: asked for ${inputs.length}, got ${rows?.length}`,
      );
    }
    // The API documents `data` as index-tagged rather than order-guaranteed, so
    // the vectors are placed by `index` when it is present. Silently trusting
    // array order here would mismatch a person's vector with someone else's
    // text — an error nothing downstream could ever detect.
    const vectors = new Array<number[] | undefined>(inputs.length);
    rows.forEach((row, position) => {
      const at = row.index ?? position;
      if (!Array.isArray(row.embedding) || row.embedding.length !== EMBEDDING_DIMS) {
        throw new Error(`Unexpected embedding shape: length ${row.embedding?.length}`);
      }
      if (at < 0 || at >= inputs.length) {
        throw new Error(`Embedding response carried an out-of-range index ${at}`);
      }
      vectors[at] = row.embedding;
    });
    const missing = vectors.findIndex((vec) => vec === undefined);
    if (missing !== -1) {
      throw new Error(`Embedding response skipped input ${missing}`);
    }
    return vectors as number[][];
  }

  return {
    embedMany,
    async embed(input: string): Promise<number[]> {
      const [vec] = await embedMany([input]);
      return vec!;
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


export function buildQuestionnaireProfileAnalysis(
  input: QuestionnaireProfileAnalysisInput,
): string {
  const lines = [
    "Profile source: onboarding answers",
    `Hobbies/interests: ${input.hobbies.length ? input.hobbies.join(", ") : "none provided"}`,
    `Partner preferences: ${input.partnerPreferences}`,
  ];
  const vibe = buildVibeBlock(input.fridayVibe, input.vibeFocus);
  if (vibe) lines.push(vibe);
  return lines.join("\n");
}

export async function saveQuestionnaireProfileAnalysis(
  userId: string,
  input: QuestionnaireProfileAnalysisInput,
  client?: EmbeddingClient,
): Promise<{ summary: string; embeddingSaved: boolean }> {
  const summary = buildQuestionnaireProfileAnalysis(input);
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
