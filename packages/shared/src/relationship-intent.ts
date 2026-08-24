/**
 * Relationship intent — the one thing the product asks about the FUTURE
 * (PRODUCT_SPEC §1.3 / §3.2).
 *
 * A single ordered axis: how far ahead the person is looking. Everything else
 * usually hung on this question (children, marriage) belongs to a different
 * product — this one's horizon is one date on Thursday — and the two other
 * dimensions people reach for, tempo and process-vs-person, are already
 * measured by the vibe axes (`energyAxis` / `orientationAxis`). Measuring them
 * twice would double their weight for nothing.
 *
 * Four points rather than three or six: at three the middle swallows everyone
 * who is unsure, and past four people stop distinguishing neighbours and the
 * answer becomes noise.
 *
 * The wording is a product invariant, not a style choice. Each option has to
 * read as a taste, never as a confession — the moment `spark` reads as "I am
 * not serious", social desirability drags the whole population rightward and
 * the axis stops measuring anything. That is also why `spark` is FIRST and
 * plainly equal, rather than a footnote after the respectable answers.
 *
 * Pure and env-free, like `type-radar.ts`: the engine passes the floor and
 * decides whether the factor is live.
 */

/** The axis, ordered by horizon. Index IS the position — do not reorder. */
export const RELATIONSHIP_INTENTS = [
  /** A short, intense story. Here and now, no plans attached. */
  "spark",
  /** No expectations either way; open to wherever it goes. */
  "open",
  /** Looking to feel something, ready for it to continue. */
  "falling",
  /** A relationship with a future. */
  "longterm",
] as const;

export type RelationshipIntent = (typeof RELATIONSHIP_INTENTS)[number];

/** Widest possible gap on the axis — derived, so adding a point rescales. */
export const INTENT_MAX_DISTANCE = RELATIONSHIP_INTENTS.length - 1;

export function isRelationshipIntent(value: unknown): value is RelationshipIntent {
  return (
    typeof value === "string" &&
    (RELATIONSHIP_INTENTS as readonly string[]).includes(value)
  );
}

/** Position on the axis, or `null` for anything that is not an intent. */
export function intentPosition(value: unknown): number | null {
  if (!isRelationshipIntent(value)) return null;
  return RELATIONSHIP_INTENTS.indexOf(value);
}

/**
 * Agreement between two intents → `[0, 1]`. 1 = identical, 0 = opposite ends.
 *
 * Symmetric by construction (it reads a distance), which matters because
 * `scorePair` averages the two one-directional multipliers: an asymmetric
 * factor would have half its effect averaged away.
 */
export function intentCompatibilityScore(
  a: RelationshipIntent,
  b: RelationshipIntent,
): number {
  const distance = Math.abs(RELATIONSHIP_INTENTS.indexOf(a) - RELATIONSHIP_INTENTS.indexOf(b));
  return 1 - distance / INTENT_MAX_DISTANCE;
}

/**
 * Map two intents to the `V_intent` multiplier applied to the positive bracket
 * of the match score. Same shape as `typePreferenceMultiplier`, deliberately
 * weaker: at the launch floor of 0.85 the range is ×1.18, against `V_type`'s
 * ×1.43 and `V_league`'s ×20. It reorders neighbours inside a league; it can
 * never outrank a real difference in league or psychology.
 *
 * Returns exactly `1.0` — fully neutral, zero effect on ranking — whenever
 * there is nothing to act on, so the factor is safe to leave wired everywhere:
 *   - `floor >= 1` — shadow mode (`INTENT_FLOOR` default 1.0): no-op.
 *   - EITHER side has no intent on file (legacy row, a client with no such
 *     screen, someone who registered before this shipped). Penalising an
 *     absent answer would punish users for our own rollout.
 *
 * `floor` is clamped to [0, 1].
 */
export function intentMultiplier(
  a: unknown,
  b: unknown,
  floor: number,
): number {
  const f = floor < 0 ? 0 : floor > 1 ? 1 : floor;
  if (f >= 1) return 1;
  if (!isRelationshipIntent(a) || !isRelationshipIntent(b)) return 1;
  return f + (1 - f) * intentCompatibilityScore(a, b);
}
