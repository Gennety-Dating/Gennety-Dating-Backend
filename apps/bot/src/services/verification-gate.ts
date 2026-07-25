import type { BotContext } from "../session.js";

/**
 * The state a user sits in between finishing the onboarding collector and
 * clearing Persona liveness: `onboardingStep = completed`, but `status` still
 * `onboarding`.
 *
 * `finalize_onboarding` is the only thing that produces it — a verified outcome
 * flips the user to `active`, so anyone still here has NOT passed verification
 * and the matchmaker has not started for them.
 */
export interface VerificationGateState {
  status: string;
  onboardingStep: string;
}

/**
 * True while the app must stay locked. Registration v2 made verification
 * mandatory, so this is not "an optional step the user postponed" — it is the
 * one thing standing between them and every other surface. Until it clears, the
 * only reachable actions are re-uploading photos and running/retrying Persona.
 */
export function isVerificationGated(user: VerificationGateState | null | undefined): boolean {
  return user?.status === "onboarding" && user.onboardingStep === "completed";
}

/**
 * The allowlist punched through the lock. Deliberately narrow:
 *
 *  - `verify:*` — the verification CTA, its retry/check buttons, and the
 *    "Upload different photos" entry point.
 *  - the photo manager, but ONLY while it is already open
 *    (`menuState === "edit_photos"`): its own callbacks plus the raw photo
 *    messages it consumes. Without this the redo flow would lock itself out.
 *
 * Everything else — `menu:*`, free text to the menu agent, contacts, commands
 * routed through this composer — is blocked and answered with the gate card.
 */
export function isVerificationGateAllowed(ctx: BotContext): boolean {
  const data = ctx.callbackQuery?.data;
  if (data?.startsWith("verify:")) return true;

  if (ctx.session.menuState === "edit_photos") {
    // A raw message (photo / album frame / stray text) belongs to the open
    // manager; a callback only if it is one of the manager's own buttons.
    if (!data) return true;
    if (data.startsWith("menu:edit:photos")) return true;
  }

  return false;
}
