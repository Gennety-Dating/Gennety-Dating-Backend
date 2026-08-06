import type { TelegramProfileBasics } from "./api.js";

/**
 * The Mini App's own profile screens (PRODUCT_SPEC §1.3).
 *
 * These five facts each have ONE correct answer out of a finite set, which is
 * exactly what a native control captures better than a sentence typed into a
 * chat. Everything after `height` — hobbies, partner preferences, the vibe
 * answers — is open prose and stays chat-owned.
 *
 * The order matches the collector's canonical question order
 * (`nextOnboardingQuestion`), so whatever the Mini App does NOT deliver is
 * picked up by the chat at exactly the point it left off.
 */
export const BASICS_STEPS = ["name", "age", "gender", "preference", "height"] as const;

export type BasicsStep = (typeof BASICS_STEPS)[number];

export const BASICS_LAST_INDEX = BASICS_STEPS.length - 1;

/**
 * The first screen this user still owes an answer to, or `null` when the set
 * is complete.
 *
 * Server state is the source of truth here, not DeviceStorage: it is what makes
 * a reopened session resume in place, and what makes a user who answered these
 * in chat (a legacy mid-flight account, or one adopted by the phone login) skip
 * the screens entirely instead of being asked twice.
 *
 * An absent `profileBasics` means the server predates these screens, so there
 * is nothing to collect and nothing to resume — route past them.
 */
export function nextBasicsStep(
  basics: TelegramProfileBasics | null | undefined,
): BasicsStep | null {
  if (!basics) return null;
  if (!basics.firstName) return "name";
  if (basics.age === null || basics.age === undefined) return "age";
  if (!basics.gender) return "gender";
  if (!basics.preference) return "preference";
  if (basics.height === null || basics.height === undefined) return "height";
  return null;
}

/** Index of a step in the canonical order (used for back-navigation). */
export function basicsStepIndex(step: BasicsStep): number {
  return BASICS_STEPS.indexOf(step);
}

/** The step before `step`, or `null` when it is the first one. */
export function previousBasicsStep(step: BasicsStep): BasicsStep | null {
  return BASICS_STEPS[basicsStepIndex(step) - 1] ?? null;
}
