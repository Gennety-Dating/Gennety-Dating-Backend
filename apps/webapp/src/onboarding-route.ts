import type { TelegramOnboardingState } from "./api.js";
import { nextBasicsStep, type BasicsStep } from "./onboarding-basics-route.js";

type RemoteUser = TelegramOnboardingState["user"];

/**
 * Final visual scene index. Play order:
 * 0 Pivot (typewriter + rising Gennety icon), 1 Matchmaker (typewriter),
 * 2 HowItWorks.
 *
 * Six scenes used to precede these — the competitor-icon rise, the crumble, the
 * cost question, the statistics drum, the "only 3%" line and the swipe
 * simulator — and were removed on 2026-08-20 (founder decision, DECISIONS.md).
 * They argued that the old apps are bad, which is advertising's job and is over
 * by the time someone presses Start; what stays is what the product IS.
 */
export const VISUAL_LAST_INDEX = 2;
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
  // Registration v2 sign-up fork: choose the student (university email) or
  // general (phone) track. Rendered only when the server says the phone rail
  // is live (`phoneAuthEnabled`); otherwise the email gate follows consent
  // directly, exactly as before the fork existed.
  | { kind: "path" }
  | { kind: "email" }
  | {
      kind: "otp";
      email: string;
      expiresAt: string | null;
      resendAvailableAt: string | null;
    }
  | { kind: "phone" }
  | { kind: "city" }
  // App color theme picker — shown once, right after the city gate (before the
  // visual animation, so the animation itself plays in the chosen theme).
  | { kind: "theme" }
  // Promo welcome gift (PROMO_CODES_PRODUCT_SPEC.md): the richer wow screen for
  // a promo-code user (ticket + N months + special status), shown once as the
  // second-to-last screen. Takes precedence over the referral screen.
  | { kind: "promoGift" }
  // Referral welcome gift (§Referral): a wow screen for an invited user,
  // shown once as the second-to-last screen (right before the AI-memory
  // choice). Skipped entirely for non-referred users.
  | { kind: "referralGift" }
  // The Mini App's own profile screens — name / age / gender / preference /
  // height (PRODUCT_SPEC §1.3). Placed after the welcome-gift screen so the
  // gift stays the arrival reward, and before the AI-memory choice, which is
  // the last thing the Mini App asks.
  | { kind: "basics"; step: BasicsStep }
  | { kind: "aiMemoryExport" }
  | { kind: "loading" }
  | { kind: "done" };

/**
 * The bot already owns this user — the Mini App has nothing left to collect.
 *
 * Reachable in two ways: re-opening a stale Mini App link after onboarding, and
 * (the reason this exists) the phone-based account login — sharing a contact
 * that belongs to an existing account swaps the server-side user underneath a
 * live Mini App session, and the returning state can be a fully onboarded one.
 * Without this guard the phone gate would route that user back through city /
 * theme / the visual intro they finished long ago.
 */
function isOnboarded(user: RemoteUser): boolean {
  return user.onboardingStep === "completed";
}

export function preVisualPhaseFromRemote(user: RemoteUser | null): OnboardingPhase {
  if (!user) return { kind: "syncing" };
  if (isOnboarded(user)) return { kind: "done" };
  if (!user.language) return { kind: "language" };
  if (!user.termsAccepted) return { kind: "consent" };
  const contactPhase = unresolvedContactPhase(user);
  if (contactPhase) return contactPhase;
  if (!user.homeLocation?.homeCityKey) return { kind: "city" };
  if (!user.themeChosen) return { kind: "theme" };
  return { kind: "visual", index: 0 };
}

export function postVisualPhaseFromRemote(user: RemoteUser | null): OnboardingPhase {
  if (!user) return { kind: "syncing" };
  if (isOnboarded(user)) return { kind: "done" };
  if (!user.language) return { kind: "language" };
  if (!user.termsAccepted) return { kind: "consent" };
  const contactPhase = unresolvedContactPhase(user);
  if (contactPhase) return contactPhase;
  if (!user.homeLocation?.homeCityKey) return { kind: "city" };
  if (!user.themeChosen) return { kind: "theme" };
  if (user.invitedByPromo && !user.promoGiftSeen) return { kind: "promoGift" };
  if (user.invitedByReferral && !user.referralGiftSeen) return { kind: "referralGift" };
  // First profile screen still unanswered. Derived from server state, so a
  // reopened session resumes in place and an already-answered set is skipped.
  const basicsStep = nextBasicsStep(user.profileBasics);
  if (basicsStep) return { kind: "basics", step: basicsStep };
  // `aiMemoryExportEnabled === false` is the server kill switch: skip the
  // choice screen entirely (an older server omits the field → treat as on).
  if (
    user.aiMemoryExportEnabled !== false &&
    user.aiMemoryExportPreference === "undecided"
  ) {
    return { kind: "aiMemoryExport" };
  }
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
 *
 * A value stored before the 2026-08-20 cut is on the old nine-scene scale and
 * is read on this one, which is deliberately NOT migrated. The two scales are
 * indistinguishable in storage (an old `3` was the statistics drum, a new `3`
 * is the done sentinel), so telling them apart would mean a versioned key —
 * and the failure it would buy back is bounded and rare: an old value ≥ 3 skips
 * the intro rather than replaying a scene that no longer exists, and 0–2 lands
 * on the three scenes that survived. Nobody in production is in that state (the
 * eight accounts past the contact gate all finished the Mini App), and the cost
 * of being wrong is one 13-second explainer not shown, never a broken screen.
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

/**
 * Registration v2 contact resolution. Either verified rail satisfies the
 * contact stage (an email-verified handoff user never sees the fork). With
 * the phone rail off (`phoneAuthEnabled=false`) this is exactly the legacy
 * email resolution. Otherwise the chosen track picks the gate, and no track
 * yet → the fork screen.
 */
function unresolvedContactPhase(user: RemoteUser): OnboardingPhase | null {
  if (user.isEmailVerified || user.isPhoneVerified) return null;
  if (!user.phoneAuthEnabled) return unresolvedEmailPhase(user);
  if (user.registrationTrack === "student") return unresolvedEmailPhase(user);
  if (user.registrationTrack === "general") return { kind: "phone" };
  return { kind: "path" };
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

/**
 * Whether the welcome mascot's full greeting should play on this launch
 * (PRODUCT_SPEC §1.1). The mascot's card-shuffling loop is the loading
 * indicator regardless — this gate only decides whether the loop resolves into
 * the turn-around, the wink and the curtain, or simply fades.
 *
 * Three conditions, and the third is the one that is easy to omit:
 *
 * - The user has not been greeted before (a DeviceStorage marker, so it is
 *   per-device and a storage reset replays it once — accepted, same fate as the
 *   visual-scene progress above).
 * - Motion is allowed. Under `prefers-reduced-motion` there is no reduced
 *   variant of a 3.7s character performance; the product falls back to the
 *   ordinary loading screen instead.
 * - **The boot phase is the very start of registration.** An account resuming
 *   mid-flow — at the city gate, at a profile screen — has met the product
 *   already, and a first-meeting greeting there reads as the app having
 *   forgotten them. The marker alone cannot express this: a user who reinstalls
 *   halfway through has no marker and is not a new user.
 */
export function shouldPlayWelcome(
  bootPhase: OnboardingPhase,
  welcomed: boolean,
  reducedMotion: boolean,
): boolean {
  if (welcomed || reducedMotion) return false;
  return bootPhase.kind === "language" || bootPhase.kind === "consent";
}
