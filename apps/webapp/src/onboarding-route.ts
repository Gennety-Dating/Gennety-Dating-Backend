import type { TelegramOnboardingState } from "./api.js";

type RemoteUser = TelegramOnboardingState["user"];

export type OnboardingPhase =
  | { kind: "visual"; index: number }
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
