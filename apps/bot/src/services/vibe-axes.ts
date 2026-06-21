import { prisma } from "@gennety/db";
import type { Language } from "@gennety/db";
import { callOpenAIJson } from "./openai.js";

/**
 * Vibe-axis extraction (PRODUCT_SPEC §1.3 / §3.2).
 *
 * Maps the two free-text onboarding "vibe" answers — the ideal-Friday-night
 * answer and the "process vs who's with you" follow-up — into structured axes
 * the matching engine can score:
 *
 *   - `energyAxis`      internal (-1) ↔ external (+1)   — the "tempo" axis.
 *   - `orientationAxis` experience (-1) ↔ connection (+1).
 *   - `socialRole`      initiator | participant | observer (stored, not scored).
 *   - `anchorTags`      concrete interests for icebreakers / future scoring.
 *
 * The axes are scored by `researchScore` (quadrant proximity). `socialRole` is
 * STORED but not scored in v1 — role-complementarity matching (Phase 2) waits
 * for accept/decline data. Never throws: a missing OpenAI key or any failure
 * returns `null` so finalize stores nulls and never blocks onboarding.
 */

export const SOCIAL_ROLES = ["initiator", "participant", "observer"] as const;
export type SocialRole = (typeof SOCIAL_ROLES)[number];

export interface VibeAxes {
  energyAxis: number;
  orientationAxis: number;
  socialRole: SocialRole | null;
  anchorTags: string[];
}

/** Raw JSON shape returned by the extractor model. */
interface RawVibeAxes {
  energy_axis?: unknown;
  orientation_axis?: unknown;
  social_role?: unknown;
  anchor_tags?: unknown;
}

const MAX_ANCHOR_TAGS = 6;

const SYSTEM_PROMPT = `You map a person's free-text answers about their ideal Friday night into a compact JSON profile of their social "vibe". Be honest and literal — read what they actually describe, never what sounds impressive.

Return ONLY a JSON object with these fields:
- "energy_axis": number in [-1, 1]. -1 = internal/low-key energy (quiet night in, alone or one close person, calm, recharging in solitude). +1 = external/high-energy (out among people, loud, busy, crowds, nightlife). 0 = balanced.
- "orientation_axis": number in [-1, 1]. -1 = experience-oriented (the activity/place/thing itself is the point). +1 = connection-oriented (who is there and the bond is the point). Use the follow-up answer ("process vs who's with you") as the strongest signal.
- "social_role": one of "initiator" (drives and plans the night), "participant" (happily joins in but doesn't lead), "observer" (prefers to be led / to watch and listen). Use null only if there is genuinely no signal.
- "anchor_tags": array of up to 6 short lowercase interest tags concretely named in the answer (e.g. "music", "food", "nature", "film", "gaming", "sport", "art", "books", "dancing"). [] if none.

Infer from substance, in any language. Output strictly valid JSON.`;

function clampAxis(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(-1, Math.min(1, n));
}

function coerceRole(value: unknown): SocialRole | null {
  return typeof value === "string" &&
    (SOCIAL_ROLES as readonly string[]).includes(value)
    ? (value as SocialRole)
    : null;
}

function coerceTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const tag = item.trim().toLowerCase();
    if (tag && tag.length <= 30) seen.add(tag);
    if (seen.size >= MAX_ANCHOR_TAGS) break;
  }
  return [...seen];
}

export interface ExtractVibeAxesOptions {
  fetchFn?: typeof fetch;
}

/**
 * Extract structured vibe axes from the two free-text answers. Returns `null`
 * when both answers are empty or the model is unavailable/failed.
 */
export async function extractVibeAxes(
  fridayText: string | null,
  focusText: string | null,
  language: Language,
  options: ExtractVibeAxesOptions = {},
): Promise<VibeAxes | null> {
  const friday = fridayText?.trim() ?? "";
  const focus = focusText?.trim() ?? "";
  if (!friday && !focus) return null;

  const userContent = JSON.stringify({
    language,
    friday_night_answer: friday,
    process_vs_who_answer: focus,
  });

  const raw = await callOpenAIJson<RawVibeAxes>(SYSTEM_PROMPT, userContent, {
    ...(options.fetchFn ? { fetchFn: options.fetchFn } : {}),
    temperature: 0,
  });
  if (!raw) return null;

  return {
    energyAxis: clampAxis(raw.energy_axis),
    orientationAxis: clampAxis(raw.orientation_axis),
    socialRole: coerceRole(raw.social_role),
    anchorTags: coerceTags(raw.anchor_tags),
  };
}

/**
 * Persist extracted axes on the profile, stamping `vibeExtractedAt` so the
 * finalize retry path is idempotent. No-op-safe: callers pass `null` when
 * extraction was unavailable, and we still stamp the timestamp so the profile
 * is marked as processed (the matching engine simply skips the quadrant factor
 * when the axes are null).
 */
export async function saveVibeAxes(
  userId: string,
  axes: VibeAxes | null,
): Promise<void> {
  await prisma.profile.update({
    where: { userId },
    data: {
      energyAxis: axes?.energyAxis ?? null,
      orientationAxis: axes?.orientationAxis ?? null,
      socialRole: axes?.socialRole ?? null,
      anchorTags: axes?.anchorTags ?? [],
      vibeExtractedAt: new Date(),
    },
  });
}
