import type { TranslationKey } from "@gennety/shared";
import { isVerificationGated, type VerificationGateState } from "./verification-gate.js";

/**
 * Who is allowed to talk to the post-onboarding LLM agent at all.
 *
 * The menu agent runs behind TWO doors — grammY (`handlers/router.ts`) and the
 * JWT API (`public/routes/assistant.ts`) — and until now each carried its own
 * partial idea of who may pass:
 *
 *  - the Telegram side enforced the verification gate but nothing else, so a
 *    `banned` / `suspended` / `pending_investigation` user (whose `status` is
 *    not `onboarding`, so the gate never saw them) walked straight into the
 *    agent and its profile-writing tools;
 *  - the API side checked only `onboardingStep === "completed"`, so a user the
 *    entire Telegram surface holds behind the verification card reached the
 *    same agent, with the same tools, by switching transport.
 *
 * Both are the same question, so it is answered once here and both doors ask
 * it. Anything that gates the agent belongs in this function rather than in a
 * middleware, precisely so a third entry point cannot be written without it.
 */

export interface AgentAccessState extends VerificationGateState {
  suspendedUntil?: Date | null;
}

export type AgentAccessDenial =
  | "not_onboarded"
  | "verification_required"
  | "banned"
  | "under_investigation"
  | "suspended";

export type AgentAccessDecision =
  | { allowed: true }
  | { allowed: false; reason: AgentAccessDenial; suspendedUntil?: Date | null };

/**
 * Moderation-owned states. A user in one of these is mid-enforcement: they are
 * not in the matching pool, and letting them keep an LLM conversation running
 * means burning tokens on an account we have already acted against — and, for
 * `suspended`, letting them keep tuning the profile they will return with.
 * `frozen` is deliberately absent: it is a self-service soft-delete that
 * `/start` silently reverses, not a penalty.
 */
const MODERATION_DENIALS: Record<string, AgentAccessDenial> = {
  banned: "banned",
  pending_investigation: "under_investigation",
  suspended: "suspended",
};

/**
 * Decide whether `user` may run an agent turn. Pure — callers own how a denial
 * is rendered (a Telegram card, an HTTP status), so the same rule can be
 * enforced on surfaces that look nothing alike.
 */
export function evaluateAgentAccess(
  user: AgentAccessState | null | undefined,
): AgentAccessDecision {
  if (!user || user.onboardingStep !== "completed") {
    return { allowed: false, reason: "not_onboarded" };
  }

  const moderation = MODERATION_DENIALS[user.status];
  if (moderation) {
    return {
      allowed: false,
      reason: moderation,
      suspendedUntil: user.suspendedUntil ?? null,
    };
  }

  // Checked last: a user can only be verification-gated while `status` is still
  // `onboarding`, so a moderation state above always wins and the more specific
  // message is the one the user gets.
  if (isVerificationGated(user)) {
    return { allowed: false, reason: "verification_required" };
  }

  return { allowed: true };
}

/** HTTP status for a denial on the JWT surface. */
export function agentAccessHttpStatus(reason: AgentAccessDenial): number {
  return reason === "not_onboarded" ? 409 : 403;
}

/**
 * What a denied user is told in chat. `not_onboarded` is absent on purpose: the
 * menu router only runs for completed users, so that branch is unreachable
 * there and the caller handles it as an ordinary "finish onboarding" case.
 */
export const AGENT_DENIAL_COPY: Record<
  Exclude<AgentAccessDenial, "not_onboarded">,
  TranslationKey
> = {
  verification_required: "agentBlockedVerification",
  banned: "agentBlockedBanned",
  under_investigation: "agentBlockedInvestigation",
  suspended: "agentBlockedSuspended",
};
