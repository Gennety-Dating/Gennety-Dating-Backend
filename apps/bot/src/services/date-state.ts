/**
 * Which Living Canvas state a given side of a given match is in
 * (PRODUCT_SPEC §Living Canvas).
 *
 * ── Why this is a function and not a column ──────────────────────────────
 *
 * The obvious implementation is `Match.lifecycleState`, written by the match
 * engine and the crons. It is wrong for the reason this repo has already been
 * bitten by twice: two status columns on one row drift, and the drift is
 * silent. `ticketStatus` survives as a sub-state only because it answers a
 * question `status` cannot; a lifecycle column would answer the SAME question
 * as `status` plus the clock, so every writer of `status` would owe it an
 * update and one of them would eventually forget. The failure mode is a canvas
 * telling a user something their own chat contradicts.
 *
 * So `MatchStatus` stays the single writable truth and this file is a pure
 * projection of it. Nothing here writes.
 *
 * ── The one state the spec's own list was missing ────────────────────────
 *
 * `DATE_SCHEDULED` is not in the seven states the brief named, and it is where
 * a user spends most of the days between agreeing a date and going on it. The
 * two candidates for reusing an existing name are both lies:
 * `LOGISTICS_SCHEDULING` says something is still being agreed when nothing is,
 * and `IDLE_EXPLORING` says there is no date when there is one. §2.1's pinned
 * banner already draws exactly this distinction — its "planning" mode and its
 * "date" mode are separate for the same reason — so the eighth state is the
 * product catching up with itself rather than an invention.
 *
 * ── The blind-decision invariant, stated where it is enforced ────────────
 *
 * `deriveDateState` reads the CALLER's own `acceptedBy*` and never the peer's.
 * A side that has answered a pitch cannot learn from this function whether the
 * other side has, because both "peer still deciding" and "peer accepted, we are
 * arranging it" resolve to `LOGISTICS_SCHEDULING` — the same collapse §2.1 mode
 * 4 makes, and for the same reason: at that moment the product does not know
 * the outcome and the user is not entitled to it.
 */

import {
  DATE_BUMP_GRACE_HOURS,
  DATE_BUMP_OPENS_MINUTES,
  DATE_RADAR_LEAD_MINUTES,
  type DateLifecycleState,
} from "@gennety/shared";

/** Which participant is asking. Follows `Match.userAId`/`userBId`, not arrival order. */
export type MatchSide = "A" | "B";

/**
 * The narrow structural row the derivation needs.
 *
 * Deliberately a hand-written shape rather than Prisma's `Match`: it documents
 * the entire read surface in one place, so a future field cannot start
 * influencing the canvas without appearing here first. Same idiom
 * `workers/peer-wait-shimmer.ts` uses for the venue board.
 */
export interface DateStateMatch {
  status: string;
  /** NULL = pending, true = accepted, false = declined. */
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  agreedTime: Date | null;
  /** Set once the T+24h prompt has actually been sent. */
  feedbackPromptedAt: Date | null;
  feedbackByA: string | null;
  feedbackByB: string | null;
}

/** The bump half, or null when nobody has shaken yet. */
export interface DateStateBump {
  isVerified: boolean;
}

export interface DeriveDateStateInput {
  /** The caller's live match, or null when they have none. */
  match: DateStateMatch | null;
  side: MatchSide;
  bump: DateStateBump | null;
  now: Date;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

function ownDecision(match: DateStateMatch, side: MatchSide): boolean | null {
  return side === "A" ? match.acceptedByA : match.acceptedByB;
}

function ownFeedback(match: DateStateMatch, side: MatchSide): string | null {
  return side === "A" ? match.feedbackByA : match.feedbackByB;
}

/**
 * The ladder runs from the most specific state backwards, because several of
 * the windows overlap by construction: a verified bump is inside the bump
 * window, which is inside the radar window, which is inside `scheduled`. Asking
 * the broad questions first would answer with the outer state every time.
 */
export function deriveDateState(input: DeriveDateStateInput): DateLifecycleState {
  const { match, side, bump, now } = input;

  if (!match) return "IDLE_EXPLORING";

  // A closed match still owes a question, and only until this side answers it.
  // Gated on `feedbackPromptedAt` rather than on the status alone: `completed`
  // is stamped by the T+24h tick, and asking on the canvas before the DM asks
  // would pre-empt the §Phase 4 attendance question that has to come first.
  if (match.status === "completed") {
    const owes = match.feedbackPromptedAt !== null && ownFeedback(match, side) === null;
    return owes ? "POST_DATE_FEEDBACK" : "IDLE_EXPLORING";
  }

  // Terminal and not worth a screen. A decliner in particular must never be
  // shown anything about the pair again (§3.4 — a pass is irreversible).
  if (match.status === "cancelled" || match.status === "expired") {
    return "IDLE_EXPLORING";
  }

  if (match.status === "proposed") {
    // Only this side's own column. NULL is the only thing that means "you owe
    // an answer"; both `true` and `false` mean it has been given, and which of
    // the two it was is none of the canvas's business here.
    return ownDecision(match, side) === null
      ? "DROP_PENDING_DECISION"
      : "LOGISTICS_SCHEDULING";
  }

  if (match.status === "negotiating" || match.status === "negotiating_venue") {
    return "LOGISTICS_SCHEDULING";
  }

  if (match.status === "scheduled") {
    // A scheduled row with no time is corrupt rather than early — treat it as
    // still being arranged instead of doing clock arithmetic on null.
    if (!match.agreedTime) return "LOGISTICS_SCHEDULING";

    const t = match.agreedTime.getTime();
    const graceEnds = t + DATE_BUMP_GRACE_HOURS * HOUR_MS;
    const bumpOpens = t - DATE_BUMP_OPENS_MINUTES * MINUTE_MS;
    const radarOpens = t - DATE_RADAR_LEAD_MINUTES * MINUTE_MS;
    const ms = now.getTime();

    if (ms >= graceEnds) {
      // The evening is over and the row lingers until the T+24h tick closes it.
      // §2.1 mode 5 makes exactly this call for the pinned banner — a date that
      // has already happened falls back to the ordinary drop countdown — so the
      // canvas goes back to the map rather than inventing a limbo screen.
      const owes = match.feedbackPromptedAt !== null && ownFeedback(match, side) === null;
      return owes ? "POST_DATE_FEEDBACK" : "IDLE_EXPLORING";
    }

    if (bump?.isVerified) return "DATE_IN_PROGRESS";
    if (ms >= bumpOpens) return "DATE_BUMP_PENDING";
    if (ms >= radarOpens) return "DATE_RADAR_ACTIVE";
    return "DATE_SCHEDULED";
  }

  return "IDLE_EXPLORING";
}

/** Which side of a match a user id is on, or null if they are on neither. */
export function sideOf(
  match: { userAId: string; userBId: string },
  userId: string,
): MatchSide | null {
  if (match.userAId === userId) return "A";
  if (match.userBId === userId) return "B";
  return null;
}
