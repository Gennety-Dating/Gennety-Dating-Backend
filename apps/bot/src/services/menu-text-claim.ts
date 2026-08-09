import type { MenuState, SessionData } from "@gennety/shared";

/**
 * Ownership of the chat's free text by a menu sub-flow — the menu twin of
 * `services/match-flow-claim.ts`.
 *
 * That module bounded the three MATCH flows that read the next plain message as
 * their answer. The same shape existed one router over and was left unbounded:
 * five `menuState` values consume plain text, and nothing ever released them
 * except the user happening to tap a button. The state lives in `bot_sessions`,
 * so it survives restarts, deploys and weeks of silence.
 *
 * What that cost, worst first:
 *
 *   - `edit_bio` is the destructive one. It writes the message verbatim into
 *     `Profile.psychologicalSummary` — not a caption but the profile's
 *     accumulated psychological signal and the dominant embedding input
 *     (`V_explicit`, 0.65, PRODUCT_SPEC §3.2). A user who tapped "About me",
 *     got distracted and closed Telegram had their next message — on any topic,
 *     any number of days later — replace that analysis outright, with no
 *     snapshot to restore from. The agent's own `update_bio` tool refuses
 *     exactly this collapse; the menu path performed it silently.
 *   - `edit_partner_preferences` is the same trade one step down: it also feeds
 *     the embedding, so a stray line quietly re-aims who the user is matched
 *     with.
 *   - `edit_major` / `edit_age_range` overwrite an ordinary field, which is
 *     cheap to notice and re-edit.
 *   - `awaiting_premium_cancel_reason` writes a churn reason onto a
 *     `subscription_ledger` row. Nothing user-facing breaks, but the founder
 *     reads that column to understand why people leave, and an unrelated
 *     sentence recorded as a cancellation reason is worse than a blank.
 *
 * In every case the user ALSO lost the reply they came for: their question was
 * swallowed as an answer to a question they had forgotten asking. That is the
 * same "the bot listened worse the longer you waited" symptom PRODUCT_SPEC §1.3
 * already fixed for the photo stage, and §Phase 1b states the rule this module
 * enforces: an open question is not a standing claim on everything the user
 * types.
 *
 * Deliberately NOT covered: `edit_photos` and `edit_video`. They consume media
 * rather than text, and a stray photo sent months later is added to a gallery
 * the user can see and delete — not silently written over their profile.
 */

/** The `menuState` values that consume a plain text message as their answer. */
const CLAIMABLE: readonly MenuState[] = [
  "edit_bio",
  "edit_major",
  "edit_partner_preferences",
  "edit_age_range",
  "awaiting_premium_cancel_reason",
];

/**
 * How long each question owns the chat.
 *
 * Sized by what the answer costs to get wrong, the same rule
 * `MATCH_FLOW_CLAIM_TTL_MS` follows — not by how long it takes to write. The
 * two states that feed the matching embedding get the shortest window, because
 * a wrong write there is unrecoverable and invisible; the ordinary fields get
 * longer, because a wrong write is on screen and one tap from being fixed.
 *
 * Expiring is a SOFT failure by construction: the message falls through to the
 * concierge agent, which can see the profile and offer the editor straight
 * back. So an over-short window costs one extra tap, while an over-long one
 * costs the profile.
 */
export const MENU_CLAIM_TTL_MS: Record<string, number> = {
  edit_bio: 30 * 60 * 1000,
  edit_partner_preferences: 30 * 60 * 1000,
  edit_major: 60 * 60 * 1000,
  edit_age_range: 60 * 60 * 1000,
  awaiting_premium_cancel_reason: 60 * 60 * 1000,
};

/**
 * Callback prefixes that belong to each claim's OWN buttons.
 *
 * Anything else the user taps means they moved on, which closes the window.
 * A claim's own buttons must be exempt or the Skip / Back actions would
 * invalidate the state they exist to resolve.
 */
const OWN_CALLBACK_PREFIXES: Record<string, readonly string[]> = {
  // `PREM_CANCEL_REASON_SKIP`. The four edit states have no buttons of their
  // own — any tap is the user moving on, which is what the router already did.
  awaiting_premium_cancel_reason: ["prem:cancel:reason:"],
};

export function isClaimableMenuState(state: MenuState): boolean {
  return CLAIMABLE.includes(state);
}

/**
 * Start (or restart) a claim: the menu state and the deadline past which a
 * plain message is no longer read as its answer.
 */
export function claimMenuText(
  session: SessionData,
  state: MenuState,
  now: Date = new Date(),
): void {
  session.menuState = state;
  session.menuClaimUntil = isClaimableMenuState(state)
    ? now.getTime() + (MENU_CLAIM_TTL_MS[state] ?? 0)
    : null;
}

/**
 * Is the current claim still entitled to consume a plain message?
 *
 * A session written before `menuClaimUntil` existed reads `null` (the storage
 * adapter merges defaults), so it fails closed — the one in-flight edit that
 * spans a deploy falls through to the agent rather than a stale state being
 * trusted forever. That is the safe direction: the agent can hand the editor
 * back, whereas a trusted stale state overwrites a profile.
 */
export function menuClaimIsLive(
  session: SessionData,
  state: MenuState,
  now: Date = new Date(),
): boolean {
  if (session.menuState !== state) return false;
  const until = session.menuClaimUntil;
  return until != null && until > now.getTime();
}

/** Drop the claim and everything scoped to it. */
export function releaseMenuClaim(session: SessionData): void {
  session.menuState = "idle";
  session.menuClaimUntil = null;
  session.premiumCancelLedgerId = null;
}

/**
 * Should this update close an open claim before the sub-flow sees it?
 *
 * True for a callback tap that isn't one of the claim's own buttons, and for a
 * slash command — both mean the user moved on. Plain text is never a release:
 * that is the answer itself, and the deadline is what bounds it.
 */
export function updateReleasesMenuClaim(
  session: SessionData,
  update: { callbackData?: string | undefined; text?: string | undefined },
): boolean {
  if (!isClaimableMenuState(session.menuState)) return false;

  if (update.callbackData != null) {
    const own = OWN_CALLBACK_PREFIXES[session.menuState] ?? [];
    return !own.some((prefix) => update.callbackData!.startsWith(prefix));
  }
  return update.text?.startsWith("/") === true;
}
