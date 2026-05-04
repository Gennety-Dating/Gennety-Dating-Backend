export type MatchmakingStatus =
  | "onboarding"
  | "active"
  | "paused"
  | "suspended"
  | "pending_investigation"
  | "banned";

export type MenuToggleState = "active" | "paused" | "locked";

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
