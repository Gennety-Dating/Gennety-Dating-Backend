import { prisma } from "@gennety/db";
import { notifyFounderSubsystemHealth } from "./founder-notify.js";

/**
 * People parked in `pending_review` for too long.
 *
 * `pending_review` means the liveness check passed and the face-match score
 * came back inconclusive. Neither eligibility scan admits that status, so the
 * person is outside matching entirely — and they got there through OUR
 * infrastructure, not through anything they did. The notification they receive
 * carries no button, no timer runs, and the admin view that lists them is a
 * pull endpoint nobody polls. That is a person locked out of the product for an
 * indefinite period, invisibly.
 *
 * **This reports; it does not auto-reject.** Flipping them to `rejected` would
 * unlock the retry buttons, and it would also tell someone they failed an
 * identity check that our own pipeline could not decide — an accusation the
 * product would be making on the strength of a timeout. Who to clear and who to
 * refuse is a judgement about a person, and it belongs to a human. What was
 * missing was not the judgement but the summons.
 */

/** Days in `pending_review` past which a person is stuck, not pending. */
export const STUCK_PENDING_REVIEW_DAYS = 7;

export interface VerificationStuckResult {
  stuck: number;
  longestDays: number;
}

export async function verificationStuckSweep(
  now: Date = new Date(),
): Promise<VerificationStuckResult> {
  const threshold = new Date(now.getTime() - STUCK_PENDING_REVIEW_DAYS * 86_400_000);

  const stuck = await prisma.user.findMany({
    where: { verificationStatus: "pending_review", updatedAt: { lt: threshold } },
    select: { id: true, updatedAt: true },
    orderBy: { updatedAt: "asc" },
    take: 200,
  });
  if (stuck.length === 0) return { stuck: 0, longestDays: 0 };

  const oldest = stuck[0]!.updatedAt;
  const longestDays = Math.floor((now.getTime() - oldest.getTime()) / 86_400_000);

  console.warn(
    `[verification] ${stuck.length} account(s) stuck in pending_review — ` +
      `longest ${longestDays} days; they are outside matching until a human clears them`,
  );
  await notifyFounderSubsystemHealth(
    `верификация: ${stuck.length} аккаунт(ов) заперты в pending_review (до ${longestDays} дней)`,
    "degraded",
    stuck.length,
  );

  return { stuck: stuck.length, longestDays };
}
