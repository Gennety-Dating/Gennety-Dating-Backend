export type MatchmakingStatus =
  | "onboarding"
  | "active"
  | "paused"
  | "frozen"
  | "suspended"
  | "pending_investigation"
  | "banned";

export type MenuToggleState = "active" | "paused" | "locked";

/**
 * Statuses moderation imposes (`services/moderation.ts`). An account in one of
 * them must not keep a live API session: moderation revokes every refresh
 * session when it sets one, and the refresh endpoint refuses to rotate while
 * one holds. `frozen` is deliberately absent — it is the user's own soft
 * delete, and the app needs its session to reactivate from it.
 */
const MODERATION_LOCKED_STATUSES: ReadonlySet<MatchmakingStatus> = new Set<MatchmakingStatus>([
  "suspended",
  "pending_investigation",
  "banned",
]);

export function isModerationLockedStatus(
  status: MatchmakingStatus | null | undefined,
): boolean {
  return status != null && MODERATION_LOCKED_STATUSES.has(status);
}

export function canResumeMatching(status: MatchmakingStatus | null | undefined): boolean {
  return status === "paused";
}

export function menuToggleStateFor(
  status: MatchmakingStatus | null | undefined,
): MenuToggleState {
  if (status === "paused") return "paused";
  if (status === "active") return "active";
  return "locked";
}
