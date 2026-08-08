import { prisma } from "@gennety/db";
import { parseRejectionFeedbackPrompt } from "@gennety/shared";
import { callOpenAIJson } from "../../services/openai.js";
import { refreshUserEmbedding } from "../../workers/embedding-refresh.js";

/**
 * Distill a free-form rejection reason into a concise constraint string
 * and append it to `Profile.negativeConstraints`.
 *
 * Uses `parseRejectionFeedbackPrompt` + OpenAI JSON mode to extract
 * structured constraints. Falls back to simple text normalization when
 * the API is unavailable.
 */

const MAX_REASON_LEN = 240;

export interface ParsedRejectionConstraint {
  constraint_type: string;
  constraint_summary: string;
  confidence: string;
  extracted_traits_to_avoid: string[];
  reasoning: string;
}

/** Trim + collapse whitespace + cap length. Exported for tests. */
export function normalizeReason(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, MAX_REASON_LEN);
}

/**
 * Parse the rejection reason through the LLM to extract structured
 * constraints. Returns null if the API is unavailable (caller falls
 * back to simple normalization).
 */
async function parseRejectionWithLLM(
  rawReason: string,
  language: string,
): Promise<ParsedRejectionConstraint | null> {
  const systemPrompt = parseRejectionFeedbackPrompt({ language });
  return callOpenAIJson<ParsedRejectionConstraint>(systemPrompt, rawReason);
}

export interface AppendNegativeConstraintOptions {
  /**
   * Attempt the immediate embedding refresh (default true). Pass `false` only
   * when the caller appends several constraints in a row and refreshes once
   * itself — see `handlers/date/feedback.ts`.
   */
  refreshEmbedding?: boolean;
}

/**
 * Append a distilled constraint to a user's profile. Uses the LLM to
 * extract structured constraints when available, falling back to simple
 * text normalization. Creates the profile row if it doesn't yet exist.
 */
export async function appendNegativeConstraint(
  userId: string,
  rawReason: string,
  language: string = "en",
  options: AppendNegativeConstraintOptions = {},
): Promise<void> {
  const normalized = normalizeReason(rawReason);
  if (!normalized) return;

  // Attempt LLM-powered constraint extraction
  let constraintText = normalized;
  try {
    const parsed = await parseRejectionWithLLM(rawReason, language);
    if (parsed?.constraint_summary && parsed.confidence !== "low") {
      const traits = parsed.extracted_traits_to_avoid.length > 0
        ? ` [${parsed.extracted_traits_to_avoid.join(", ")}]`
        : "";
      constraintText = `[${parsed.constraint_type}] ${parsed.constraint_summary}${traits}`;
    }
  } catch {
    // Fallback: use normalized text
  }

  const existing = await prisma.profile.findUnique({
    where: { userId },
    select: { negativeConstraints: true },
  });

  const prefix = existing?.negativeConstraints?.trim();
  const merged = prefix
    ? `${prefix}\n- ${constraintText}`
    : `- ${constraintText}`;

  // M-2: mark embedding dirty — negative constraints participate in the
  // penalty score, but the LLM's psychological summary embedding is what
  // V_explicit reads, so refresh on every constraint change too.
  await prisma.profile.upsert({
    where: { userId },
    create: {
      userId,
      negativeConstraints: merged,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
    update: {
      negativeConstraints: merged,
      embeddingDirty: true,
      embeddingDirtyAt: new Date(),
    },
  });

  // …and close the window it just opened. `embeddingDirty` does not merely
  // schedule work: `findCandidatesFor` fail-closes on the SEEKER's own dirty
  // flag, so between this write and the 5-minute cron the user is withheld from
  // matching entirely. Bio and partner-preference edits have always closed that
  // window with an immediate user-scoped refresh (PRODUCT_SPEC → Embedding
  // freshness); this writer did not — and it is the one that fires seconds
  // before the product may want to match the same person again.
  //
  // Two reachable consequences, both observed rather than theorised. The paid
  // Rematch offer (§3.11) is sent on the decline path, so a man who explains
  // why he passed and then buys a re-run inside the window is told the engine
  // found nobody — and refunded — when in truth it refused to look. And the
  // demo, which pitches seconds after the same reason is given, simply stopped.
  //
  // Best-effort by the same rule as every other refresh call site: a failure
  // leaves the marker intact and the cron retries, so this can only ever make
  // the flag clear sooner, never keep a stale vector alive.
  if (options.refreshEmbedding ?? true) {
    await refreshUserEmbedding(userId).catch((err: unknown) => {
      console.warn("[negative-constraints] immediate embedding refresh failed:", err);
    });
  }
}
