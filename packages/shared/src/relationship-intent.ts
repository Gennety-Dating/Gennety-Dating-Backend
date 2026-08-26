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
 * ## The answer is a SET, not a point (founder decision 2026-08-26)
 *
 * People genuinely hold more than one of these at once — "a bright story, no
 * idea where it goes, and I'd be glad if it lasted" is one honest person, not
 * three. So the stored answer is a set, and the distance between two people is
 * the SMALLEST gap between their sets (overlap = 0).
 *
 * The property that makes this safe rather than a loophole: a broad selection
 * means "do not filter me on this", and it honestly scores 1.0 against
 * everyone. The factor therefore fires ONLY where both sides are specific and
 * opposed — which is exactly where it is wanted, and exactly the pair the
 * single-point version was built for. Selecting all four is identical to not
 * answering (1.0 either way), so it is self-neutralising and needs no cap; a
 * "choose at most N" rule would be a constraint the user cannot see the reason
 * for, protecting against something already harmless.
 *
 * What it costs, stated so it is measured rather than discovered: if most
 * people select three or four, the axis goes quiet. That is not a failure of
 * the maths — it is the population saying the question does not divide them —
 * but it means the launch measurement is TWO numbers, not one: which options
 * are chosen, and HOW MANY. A median of four means the wording is too safe and
 * belongs back in the copy, not in the scorer.
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
 * Coerce anything into a clean answer set.
 *
 * Deliberately total rather than throwing: it is the one place three rails
 * converge — the Mini App posts an array, the chat and the native client each
 * answer with ONE option (a set of size one is a perfectly valid answer, which
 * is why neither needs a multi-select control of its own), and a legacy row may
 * still hold a bare string.
 *
 * The result is deduplicated and sorted BY AXIS POSITION, so the stored value
 * is canonical: two people who tapped the same options in a different order
 * hold byte-identical rows, and a human reading the column sees the span rather
 * than a tap log.
 */
export function normalizeIntents(value: unknown): RelationshipIntent[] {
  const raw = Array.isArray(value) ? value : [value];
  const seen = new Set<RelationshipIntent>();
  for (const item of raw) if (isRelationshipIntent(item)) seen.add(item);
  return RELATIONSHIP_INTENTS.filter((intent) => seen.has(intent));
}

/**
 * Agreement between two answer SETS → `[0, 1]`. 1 = they overlap (or one is
 * adjacent to nothing else), 0 = opposite ends with nothing in between.
 *
 * Symmetric by construction (it reads a distance), which matters because
 * `scorePair` averages the two one-directional multipliers: an asymmetric
 * factor would have half its effect averaged away.
 *
 * An empty set on either side is "no answer" and is handled by the caller —
 * this function is only reached with two non-empty sets.
 */
export function intentCompatibilityScore(
  a: readonly RelationshipIntent[],
  b: readonly RelationshipIntent[],
): number {
  let best = INTENT_MAX_DISTANCE;
  for (const x of a) {
    for (const y of b) {
      const distance = Math.abs(
        RELATIONSHIP_INTENTS.indexOf(x) - RELATIONSHIP_INTENTS.indexOf(y),
      );
      if (distance < best) best = distance;
      if (best === 0) return 1;
    }
  }
  return 1 - best / INTENT_MAX_DISTANCE;
}

/**
 * Map two answers to the `V_intent` multiplier applied to the positive bracket
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
 * `floor` is clamped to [0, 1]. Both sides are normalised here rather than at
 * the call sites, so a raw column value is safe to pass straight in.
 */
export function intentMultiplier(
  a: unknown,
  b: unknown,
  floor: number,
): number {
  const f = floor < 0 ? 0 : floor > 1 ? 1 : floor;
  if (f >= 1) return 1;
  const left = normalizeIntents(a);
  const right = normalizeIntents(b);
  if (left.length === 0 || right.length === 0) return 1;
  return f + (1 - f) * intentCompatibilityScore(left, right);
}
