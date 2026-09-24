import { MIN_PHOTOS } from "@gennety/shared";
import { env } from "../config.js";
import { hasTrackVerifiedContact } from "./contact-verification.js";



export type OnboardingStageId =
  // Entry Mini App (§1.1), in the order the client presents them.
  | "language"
  | "consent"
  | "signup_track"
  | "email_otp"
  | "phone_share"
  | "city"
  | "theme"
  | "profile_basics"
  | "handoff"
  // Conversational collector (§1.3), keyed off the deterministic next question.
  | "chat_basics"
  | "chat_hobbies"
  | "chat_partner_preferences"
  | "chat_vibe"
  | "chat_photos"
  | "chat_finalize";

export interface OnboardingStage {
  id: OnboardingStageId;
  /**
   * English sentence naming the concrete next action, injected into the
   * re-engagement prompt. Written for the model, never shown to the user.
   */
  description: string;
  /**
   * True while the user is still registering and has no profile yet — so a
   * message must not claim their "profile is almost done". False once the
   * profile screens are the thing that is unfinished.
   */
  registration: boolean;
}

/** Structural view of the columns the stage is derived from. */
export interface OnboardingStageState {
  onboardingStep: string | null;
  language: string | null;
  termsAccepted: boolean | null;
  registrationTrack: string | null;
  email: string | null;
  isEmailVerified: boolean | null;
  phoneVerifiedAt: Date | null;
  themeChosenAt: Date | null;
  firstName: string | null;
  age: number | null;
  gender: string | null;
  preference: string | null;
  profile: { homeCityKey: string | null; height: number | null } | null;
  onboardingProgress: { currentQuestion: string | null } | null;
}

export interface OnboardingStageFlags {
  phoneAuthEnabled: boolean;
}

const DEFAULT_FLAGS: OnboardingStageFlags = {
  phoneAuthEnabled: env.PHONE_AUTH_ENABLED,
};

export function resolveOnboardingStage(
  user: OnboardingStageState,
  flags: OnboardingStageFlags = DEFAULT_FLAGS,
): OnboardingStage {
  if (user.onboardingStep === "conversational" || user.onboardingStep === "completed") {
    return chatStage(user.onboardingProgress?.currentQuestion ?? null);
  }
  return miniAppStage(user, flags);
}

function miniAppStage(
  user: OnboardingStageState,
  flags: OnboardingStageFlags,
): OnboardingStage {
  if (!user.language) {
    return reg(
      "language",
      "They opened the app and are on the very first screen — the language picker. Nothing has been filled in yet.",
    );
  }
  if (!user.termsAccepted) {
    return reg(
      "consent",
      "They picked their language and stopped on the terms/privacy card without accepting it.",
    );
  }

  const contact = contactStage(user, flags);
  if (contact) return contact;

  if (!user.profile?.homeCityKey) {
    return reg(
      "city",
      "Their contact is confirmed. They stopped on the city step and haven't said which city they want to be matched in.",
    );
  }
  if (!user.themeChosenAt) {
    return reg(
      "theme",
      "Registration itself is done. They stopped on the last setup screen — picking the app's light/dark look.",
    );
  }

  const missingBasic = nextMissingBasic(user);
  if (missingBasic) {
    return profile(
      "profile_basics",
      `Registration is finished and they're on the short profile screens (name, age, gender, who they want to meet, height). The first one still unanswered is: ${missingBasic}.`,
    );
  }
  return profile(
    "handoff",
    "They answered everything the Mini App asks and just never tapped the final button that hands them back to the chat. Literally one tap from being through.",
  );
}

/**
 * Registration v2 contact resolution — the server twin of the client's
 * `unresolvedContactPhase`. Either verified rail satisfies the gate; with the
 * phone rail off this is exactly the legacy email-only resolution.
 */
function contactStage(
  user: OnboardingStageState,
  flags: OnboardingStageFlags,
): OnboardingStage | null {
  if (hasTrackVerifiedContact(user)) return null;

  if (flags.phoneAuthEnabled && user.registrationTrack == null) {
    return reg(
      "signup_track",
      "They accepted the terms and stopped on the sign-up fork: choosing between the student track (university email) and the general one (phone number).",
    );
  }
  if (flags.phoneAuthEnabled && user.registrationTrack === "general") {
    return reg(
      "phone_share",
      "They chose the phone track and stopped there — the number hasn't been shared/confirmed yet.",
    );
  }
  return reg(
    "email_otp",
    user.email
      ? "They chose the student track, entered a university email, and never entered the code that was sent to it."
      : "They chose the student track and stopped there — no university email entered yet.",
  );
}

function nextMissingBasic(user: OnboardingStageState): string | null {
  if (!user.firstName) return "their name";
  if (user.age == null) return "their age";
  if (!user.gender) return "their gender";
  if (!user.preference) return "who they want to meet";
  if (user.profile?.height == null) return "their height";
  return null;
}

function chatStage(currentQuestion: string | null): OnboardingStage {
  switch (currentQuestion) {
    case "first_name_age":
    case "gender":
    case "preference":
    case "height":
      return profile(
        "chat_basics",
        "They're back in the chat and still owe the basic profile facts (name, age, gender, who they want to meet, height).",
      );
    case "hobbies":
      return profile(
        "chat_hobbies",
        "They're in the chat with you and stopped at the question about what they enjoy doing.",
      );
    case "partner_preferences":
      return profile(
        "chat_partner_preferences",
        "They're in the chat and stopped at the question about what matters to them in a partner.",
      );
    case "friday_vibe":
    case "vibe_focus":
      return profile(
        "chat_vibe",
        "They're in the chat and stopped at the questions about their ideal Friday night / what matters more, the experience or the company.",
      );
    case "photos":
      return profile(
        "chat_photos",
        `They're at the last step — photos. The profile needs at least ${MIN_PHOTOS} and they haven't finished sending them.`,
      );
    case "complete":
      return profile(
        "chat_finalize",
        "Everything is answered — the profile just isn't finalized yet.",
      );
    default:
      return profile(
        "chat_basics",
        "They're partway through the profile questions in the chat and dropped off.",
      );
  }
}

function reg(id: OnboardingStageId, description: string): OnboardingStage {
  return { id, description, registration: true };
}

function profile(id: OnboardingStageId, description: string): OnboardingStage {
  return { id, description, registration: false };
}
