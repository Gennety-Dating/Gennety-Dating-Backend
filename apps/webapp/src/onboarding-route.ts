import type { TelegramOnboardingState } from "./api.js";

type RemoteUser = TelegramOnboardingState["user"];

/** Final visual scene index (Intro=0, Stats=1, Cost=2, Profile=3, Pivot=4, Matchmaker=5, HowItWorks=6). */
export const VISUAL_LAST_INDEX = 6;
/**
 * Sentinel persisted once the user has clicked past the last visual scene.
 * On the next launch it means "skip the animation, resume the post-visual
 * phase (AI-memory export / handoff loading)".
 */
export const VISUAL_DONE = VISUAL_LAST_INDEX + 1;

/**
 * Final screen index of the optional "Подробнее" date-flow walkthrough
 * (6 screens, 0..5) reachable only from the last visual scene. It is never
 * auto-routed or resumed — leaving it returns straight to the post-visual phase.
 */
export const DATEFLOW_LAST_INDEX = 5;

export type OnboardingPhase =
  | { kind: "visual"; index: number }
  | { kind: "detail"; index: number }
  | { kind: "syncing" }
  | { kind: "consent" }
  | { kind: "language" }
  | { kind: "email" }
  | {
      kind: "otp";
      email: string;
      expiresAt: string | null;
      resendAvailableAt: string | null;
    }
  | { kind: "city" }
  | { kind: "aiMemoryExport" }
  | { kind: "loading" }
  | { kind: "done" };

export function preVisualPhaseFromRemote(user: RemoteUser | null): OnboardingPhase {
  if (!user) return { kind: "syncing" };
  if (!user.language) return { kind: "language" };
  if (!user.termsAccepted) return { kind: "consent" };
  const emailPhase = unresolvedEmailPhase(user);
  if (emailPhase) return emailPhase;
  if (!user.homeLocation?.homeCityKey) return { kind: "city" };
  return { kind: "visual", index: 0 };
}

export function postVisualPhaseFromRemote(user: RemoteUser | null): OnboardingPhase {
  if (!user) return { kind: "syncing" };
  if (!user.language) return { kind: "language" };
  if (!user.termsAccepted) return { kind: "consent" };
  const emailPhase = unresolvedEmailPhase(user);
  if (emailPhase) return emailPhase;
  if (!user.homeLocation?.homeCityKey) return { kind: "city" };
  if (user.aiMemoryExportPreference === "undecided") return { kind: "aiMemoryExport" };
  return { kind: "loading" };
}

/**
 * Boot-time phase resolution that resumes the client-only visual animation
 * where the user last left off.
 *
 * The server is authoritative for everything up to (and including) the city
 * gate — those phases are re-derived from `user`. The position *within* the
 * visual animation is purely client-side and is the only thing not encoded in
 * server state, so it is read from `storedProgress` (DeviceStorage).
 *
 * - If the server says the user hasn't reached the visual stage yet, the
 *   stored progress is ignored entirely (self-heals a stale value left over
 *   from a previous, now-reset onboarding run).
 * - `null` progress → start at scene 0 (first launch into the animation).
 * - `>= VISUAL_DONE` → the animation was already completed; jump to the
 *   post-visual phase.
 * - otherwise → resume at the clamped stored scene index.
 */
export function bootPhaseFromRemote(
  user: RemoteUser | null,
  storedProgress: number | null,
): OnboardingPhase {
  const base = preVisualPhaseFromRemote(user);
  if (base.kind !== "visual") return base;
  if (storedProgress === null) return base;
  if (storedProgress >= VISUAL_DONE) return postVisualPhaseFromRemote(user);
  const index = Math.max(0, Math.min(VISUAL_LAST_INDEX, Math.floor(storedProgress)));
  return { kind: "visual", index };
}

function unresolvedEmailPhase(user: RemoteUser): OnboardingPhase | null {
  if (user.isEmailVerified) return null;
  if (user.email && user.emailVerification.status === "pending") {
    return {
      kind: "otp",
      email: user.email,
      expiresAt: user.emailVerification.expiresAt,
      resendAvailableAt: user.emailVerification.resendAvailableAt,
    };
  }
  return { kind: "email" };
}
