import { prisma } from "@gennety/db";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";
import { attachDeclineReasonToMatchEvent } from "./match-events.js";

type MatchSide = "A" | "B";

export interface RecordRejectionFeedbackInput {
  telegramId: bigint;
  matchId: string;
  reason: string;
  requireConcreteReason?: boolean;
  updateNegativeConstraints?: boolean;
}

export type RecordRejectionFeedbackResult =
  | {
      success: true;
      status: "saved" | "already_recorded";
      rejectionReason?: string;
      negativeConstraintsUpdated: boolean;
    }
  | {
      success: false;
      code:
        | "reason_too_vague"
        | "user_not_found"
        | "match_not_found"
        | "not_match_participant"
        | "match_not_declined"
        | "user_did_not_decline";
      error: string;
    };

const MAX_REJECTION_REASON_LENGTH = 1000;
const SELF_DECLINED_STATUSES = new Set(["proposed", "cancelled", "expired"]);

/**
 * Persist feedback from a user who personally declined a proposal.
 *
 * Accepts `proposed` so first decliners can explain immediately while the
 * peer's keyboard stays live under the blind-decision invariant.
 */
export async function recordRejectionFeedback(
  input: RecordRejectionFeedbackInput,
): Promise<RecordRejectionFeedbackResult> {
  const reason = input.reason.trim();
  if ((input.requireConcreteReason ?? true) && reason.length < 10) {
    return {
      success: false,
      code: "reason_too_vague",
      error:
        "Reason is too vague. Ask the user for a concrete specific reason (looks, vibe, interests, lifestyle) before calling the tool again.",
    };
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: input.telegramId },
    select: { id: true, language: true },
  });
  if (!user) {
    return { success: false, code: "user_not_found", error: "User not found." };
  }

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: {
      userAId: true,
      userBId: true,
      status: true,
      acceptedByA: true,
      acceptedByB: true,
      rejectionReasonA: true,
      rejectionReasonB: true,
    },
  });
  if (!match) {
    return {
      success: false,
      code: "match_not_found",
      error: "Match not found. Do not record feedback unless a pending rejection is listed for this user.",
    };
  }

  const side: MatchSide | null =
    match.userAId === user.id ? "A" : match.userBId === user.id ? "B" : null;
  if (!side) {
    return {
      success: false,
      code: "not_match_participant",
      error: "This match does not belong to the user.",
    };
  }

  if (!SELF_DECLINED_STATUSES.has(match.status)) {
    return {
      success: false,
      code: "match_not_declined",
      error: "Match was not declined - cannot record a rejection reason.",
    };
  }

  const declined = side === "A" ? match.acceptedByA === false : match.acceptedByB === false;
  if (!declined) {
    return {
      success: false,
      code: "user_did_not_decline",
      error: "The user did not decline this match; the peer did. Do not record a reason on their behalf.",
    };
  }

  const existingReason = side === "A" ? match.rejectionReasonA : match.rejectionReasonB;
  if (existingReason && existingReason.trim().length > 0) {
    return {
      success: true,
      status: "already_recorded",
      negativeConstraintsUpdated: false,
    };
  }

  const truncated = reason.slice(0, MAX_REJECTION_REASON_LENGTH);
  await prisma.match.update({
    where: { id: input.matchId },
    data: side === "A" ? { rejectionReasonA: truncated } : { rejectionReasonB: truncated },
  });
  await attachDeclineReasonToMatchEvent({
    matchId: input.matchId,
    actorId: user.id,
    targetId: side === "A" ? match.userBId : match.userAId,
    rejectionReason: truncated,
  });

  let negativeConstraintsUpdated = false;
  if (input.updateNegativeConstraints ?? true) {
    try {
      await appendNegativeConstraint(user.id, truncated, user.language ?? "en");
      negativeConstraintsUpdated = true;
    } catch (err) {
      console.warn("appendNegativeConstraint failed during rejection feedback:", err);
    }
  }

  return {
    success: true,
    status: "saved",
    rejectionReason: truncated,
    negativeConstraintsUpdated,
  };
}
