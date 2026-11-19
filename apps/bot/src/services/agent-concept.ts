import { prisma } from "@gennety/db";
import { conceptBlock, isValidTimeZone } from "@gennety/shared";
import { env } from "../config.js";
import { RENDER_TZ } from "./datetime-entity.js";

/**
 * Agent concept — the bot half (spec `docs/product/domains/agent-concept.md`,
 * founder 2026-11-19, decision 2026-11-19-agent-concept).
 *
 * Every agent turn on both surfaces (`chat-agent.ts` for the app,
 * `menu-agent.ts` for Telegram) gets one block appended after the base prompt
 * and the stances: the concept rules (offline goal, spine, no attention traps,
 * letting them go, honest memory, fun with a point), their local clock, and
 * what they want from dating as their own profile answer.
 *
 * Appended, never woven into `buildSystemPrompt`, so the Telegram baseline
 * (`__fixtures__/prompt-tg-baseline.json`) stays byte for byte and
 * `AGENT_CONCEPT_ENABLED=false` returns each surface to its earlier prompt.
 *
 * Demo mode: the same — the rules cost nothing and are part of the voice; the
 * demo bot's persona reads them like production.
 */

export function agentConceptEnabled(): boolean {
  return env.AGENT_CONCEPT_ENABLED;
}

export interface ConceptTurn {
  now: Date;
  /** Their zone: the profile's on the app, `RENDER_TZ` when unknown. */
  timeZone: string | null;
  /** `Profile.relationshipIntents` as stored. */
  relationshipIntents: readonly unknown[];
  /** Only for the eval's report; the block reads the same on both surfaces. */
  surface?: "tg" | "app";
}

/** Pure: the blocks for this turn, empty when the flag is off. */
export function agentConceptBlocks(turn: ConceptTurn, enabled = agentConceptEnabled()): string[] {
  if (!enabled) return [];
  const zone = turn.timeZone && isValidTimeZone(turn.timeZone) ? turn.timeZone : RENDER_TZ;
  return [conceptBlock({ now: turn.now, timeZone: zone, relationshipIntents: turn.relationshipIntents })];
}

/**
 * The one read the block needs: their zone and intents. A failed read costs
 * the two lines, never the turn — the rules still go out.
 */
export async function loadConceptTurn(
  where: { userId: string } | { telegramId: bigint },
  now: Date = new Date(),
): Promise<ConceptTurn> {
  if (!agentConceptEnabled()) return { now, timeZone: null, relationshipIntents: [] };
  const user = await prisma.user
    .findUnique({
      where: "userId" in where ? { id: where.userId } : { telegramId: where.telegramId },
      select: { profile: { select: { timeZone: true, relationshipIntents: true } } },
    })
    .catch((err: unknown) => {
      console.warn("[agent-concept] profile read failed:", err instanceof Error ? err.message : err);
      return null;
    });
  return {
    now,
    timeZone: user?.profile?.timeZone ?? null,
    relationshipIntents: user?.profile?.relationshipIntents ?? [],
  };
}
