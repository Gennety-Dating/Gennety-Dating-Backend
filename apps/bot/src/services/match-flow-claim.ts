import type { MatchFlowState, SessionData } from "@gennety/shared";

/**
 * Ownership of the chat's free text by a match-flow question.
 *
 * Three flows ask the user to TYPE something and then read the next plain
 * message as the answer: the report details step, the emergency cancellation
 * reason, and the post-date feedback voice/text path. Each set
 * `session.matchFlow` and left it there. Nothing released it — not `/menu`, not
 * a menu tap, not time — so the claim outlived the moment it was made:
 *
 *   - `awaiting_emergency_reason` is the dangerous one. A user who confirmed
 *     "yes, cancel", then thought better of it and just closed the chat, had
 *     their NEXT message — on any topic, days later — quoted verbatim to their
 *     partner as the reason a `scheduled` date was cancelled. Irreversible, and
 *     the step offered no way back.
 *   - `awaiting_report_details` filed a real moderation report (LLM-triaged,
 *     up to a strike or a suspension on the partner) out of an unrelated line.
 *   - `awaiting_feedback` recorded an unrelated line as post-date feedback and
 *     fed it into the user's own `negativeConstraints`.
 *
 * The product already states the correct rule for exactly this shape, in
 * PRODUCT_SPEC §Phase 1b: "An active question is NOT a standing claim on
 * everything the user types" — it owns the conversation only while its window
 * is open AND the user hasn't done anything else since. This module is that
 * rule for the match flows.
 *
 * `coordination_chat` is deliberately NOT governed here: it is entered by an
 * explicit tap, relays media as well as text, and is already bounded by the
 * proxy window (T-30m → T+2h) with its own Leave button.
 */

/** The states that consume a plain message as their answer. */
const CLAIMABLE: readonly MatchFlowState[] = [
  "awaiting_report_details",
  "awaiting_emergency_reason",
  "awaiting_feedback",
  "awaiting_attendance",
];

/**
 * How long each question owns the chat.
 *
 * Sized by what the answer costs to get wrong, not by how long it takes to
 * write. The emergency reason destroys a scheduled date, so it gets the
 * shortest window; feedback is invited a full day after the date and only ever
 * writes to the answerer's own profile, so it gets the longest.
 */
export const MATCH_FLOW_CLAIM_TTL_MS: Record<string, number> = {
  awaiting_emergency_reason: 30 * 60 * 1000,
  awaiting_report_details: 60 * 60 * 1000,
  awaiting_feedback: 24 * 60 * 60 * 1000,
  // Same window as feedback, and for the same reason: it is asked a day after
  // the date and writes only the answerer's own side of one match row. It is
  // also the question most likely to be answered late — people open the chat
  // the following evening, not the moment the DM lands.
  awaiting_attendance: 24 * 60 * 60 * 1000,
};

/**
 * Callback prefixes that belong to each claim's OWN buttons.
 *
 * Anything else the user taps is "they did something else", which closes the
 * window — the same rule the Freeze/Delete confirmation already follows in
 * `bot.ts`. A claim's own buttons must be exempt or the Skip / cancel actions
 * would invalidate the state they are trying to resolve.
 */
const OWN_CALLBACK_PREFIXES: Record<string, readonly string[]> = {
  awaiting_report_details: ["rc:", "rs:", "rb:", "report:category:", "report:skip:"],
  awaiting_emergency_reason: ["emerg:"],
  awaiting_feedback: ["feedback:"],
  // `attend:` is the question's own yes/no and its outcome buttons; `feedback:`
  // is exempt too because answering "yes" hands straight over to the feedback
  // invitation, and that handover must not close the claim it arrived through.
  awaiting_attendance: ["attend:", "feedback:"],
};

function isClaimable(state: MatchFlowState): boolean {
  return CLAIMABLE.includes(state);
}

/**
 * Start (or restart) a claim: the flow state, the match it belongs to, and the
 * deadline past which a plain message is no longer read as its answer.
 */
export function claimMatchFlow(
  session: SessionData,
  state: MatchFlowState,
  matchId: string,
  now: Date = new Date(),
): void {
  session.matchFlow = state;
  session.activeMatchId = matchId;
  session.matchFlowClaimUntil = isClaimable(state)
    ? now.getTime() + (MATCH_FLOW_CLAIM_TTL_MS[state] ?? 0)
    : null;
}

/**
 * Is the current claim still entitled to consume a plain message?
 *
 * A session written before `matchFlowClaimUntil` existed reads `null` (the
 * storage adapter merges defaults), so it fails closed — the one in-flight
 * answer that spans a deploy falls through to the agent rather than a stale
 * state being trusted indefinitely.
 */
export function matchFlowClaimIsLive(
  session: SessionData,
  state: MatchFlowState,
  now: Date = new Date(),
): boolean {
  if (session.matchFlow !== state) return false;
  const until = session.matchFlowClaimUntil;
  return until != null && until > now.getTime();
}

/** Drop the claim and everything scoped to it. */
export function releaseMatchFlowClaim(session: SessionData): void {
  session.matchFlow = "idle";
  session.matchFlowClaimUntil = null;
  session.activeMatchId = null;
  session.pendingReportCategory = null;
}

/**
 * Should this update close an open claim before any router sees it?
 *
 * True for a callback tap that isn't one of the claim's own buttons, and for a
 * slash command — both mean the user moved on. Plain text is never a release:
 * that is the answer itself, and the deadline is what bounds it.
 */
export function updateReleasesMatchFlowClaim(
  session: SessionData,
  update: { callbackData?: string | undefined; text?: string | undefined },
): boolean {
  if (!isClaimable(session.matchFlow)) return false;

  if (update.callbackData != null) {
    const own = OWN_CALLBACK_PREFIXES[session.matchFlow] ?? [];
    return !own.some((prefix) => update.callbackData!.startsWith(prefix));
  }
  return update.text?.startsWith("/") === true;
}
