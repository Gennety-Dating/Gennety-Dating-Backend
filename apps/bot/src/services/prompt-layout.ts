import {
  AGENT_MEMORY_PAUSED_NOTE,
  AGENT_MEMORY_RULES,
  CONCEPT_RULES,
  LOOKS_RED_LINES,
  STANCE_RULES,
  TASTE_CANON,
} from "@gennety/shared";
import { VIDEO_RULES } from "./agent-video-takes.js";

/**
 * Cache-friendly order for an agent's system prompt (decision 2026-11-26).
 *
 * OpenAI reuses a request's prompt from its cache only up to the first token
 * that differs from an earlier request. Every agent block mixes fixed rules
 * (taste, looks, stances, memory, «why you exist») with live data about the
 * person and the minute (person card, notes, clock). The live data used to sit
 * in the middle, so about a third of the fixed rules after it were re-read at
 * full price on every call.
 *
 * Here the fixed rules keep their relative order and go first; the live
 * pieces keep theirs and go after, under one header. Nothing is dropped and no
 * wording changes.
 */

/** The fixed rule texts the agent blocks open with — identical on every turn. */
const RULE_TEXTS: readonly string[] = [
  AGENT_MEMORY_RULES,
  AGENT_MEMORY_PAUSED_NOTE,
  TASTE_CANON,
  LOOKS_RED_LINES,
  VIDEO_RULES,
  STANCE_RULES,
  CONCEPT_RULES,
];

/**
 * Split agent blocks into their fixed rules and their live remainder, both in
 * the original order. A block that IS a rule text goes to `rules`; a block that
 * opens with one (the concept block: rules, then «This person, for the rules
 * above») is split at that seam; anything else is live.
 */
export function splitRuleBlocks(blocks: ReadonlyArray<string | null | undefined | false>): {
  rules: string[];
  live: string[];
} {
  const rules: string[] = [];
  const live: string[] = [];
  for (const block of blocks) {
    if (!block) continue;
    const rule = RULE_TEXTS.find((text) => block === text || block.startsWith(`${text}\n`));
    if (!rule) {
      live.push(block);
      continue;
    }
    rules.push(rule);
    const rest = block.slice(rule.length).trim();
    if (rest) live.push(rest);
  }
  return { rules, live };
}

/** Opens the live part, so the model knows what changes and what governs it. */
export const LIVE_PART_HEADER = `## This turn — live data
Everything from here on is refreshed on every turn: facts about this person and
this moment, and any rule that applies to this turn only. The rules given before
it still govern how you use it.`;

/** Join the non-empty pieces of one prompt part. */
export function joinPromptPart(pieces: ReadonlyArray<string | null | undefined | false>): string {
  return pieces.filter((piece): piece is string => typeof piece === "string" && piece.trim().length > 0).join("\n\n");
}

/** Window history in steps so its start stays put for several turns (decision 2026-11-26). */
export const HISTORY_STEP = 10;

/**
 * How many of the newest rows to show when the chat holds `total` rows and at
 * least `min` are owed: the window starts on a multiple of `step`, so it shows
 * between `min` and `min + step - 1` rows and its first row stays the same for
 * `step` new rows. Never fewer than `min` (or `total`, when smaller).
 */
export function steppedWindowSize(total: number, min: number, step = HISTORY_STEP): number {
  if (total <= min) return total;
  const start = Math.floor((total - min) / step) * step;
  return total - start;
}
