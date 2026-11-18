import {
  STANCE_LOOKBACK,
  STANCE_RULES,
  matchStances,
  stanceBlock,
  stanceSide,
} from "@gennety/shared";
import { env } from "../config.js";

/**
 * Agent stances — the bot half (spec `docs/product/domains/agent-stances.md`,
 * decision 2026-11-17, approved 2026-11-18).
 *
 * Every agent turn on both surfaces (`chat-agent.ts` for the app,
 * `menu-agent.ts` for Telegram) gets:
 *  - always: the hot-topic rules and the political boundary;
 *  - when the person's last messages name a topic: Gennety's position on it,
 *    framed for their side (`User.gender` + `User.preference`).
 *
 * Demo mode: the same — the stances cost nothing and are part of the voice.
 * Pure: no reads, no writes, never throws.
 */

export function agentStancesEnabled(): boolean {
  return env.AGENT_STANCES_ENABLED;
}

export interface StanceTurn {
  /** The person's recent messages, NEWEST first; the first is this turn's. */
  recentUserTexts: readonly string[];
  gender: string | null;
  preference: string | null;
}

export function agentStanceBlocks(turn: StanceTurn, enabled = agentStancesEnabled()): string[] {
  if (!enabled) return [];
  const text = turn.recentUserTexts.slice(0, STANCE_LOOKBACK).join(" \n ");
  const block = stanceBlock(matchStances(text), stanceSide(turn.gender, turn.preference));
  return block ? [STANCE_RULES, block] : [STANCE_RULES];
}
