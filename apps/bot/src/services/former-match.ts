import type { Api, RawApi } from "grammy";
import { prisma, type Prisma, type UserStatus } from "@gennety/db";
import { FORMER_MATCH_REPORT_WINDOW_DAYS, type Language } from "@gennety/shared";
import {
  applyReportAction,
  moderationOutcomeRequiresCancellation,
  notifyReportedUser,
  SUSPENSION_DAYS,
  type ReportTier,
} from "./moderation.js";
import {
  claimInFlightMatchCancellations,
  deliverCancelledPartnerEffects,
  type CancelledPartner,
} from "./cancel-in-flight-matches.js";
import { STATUS_RANK, strictestTombstone } from "./safety-tombstone.js";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";

/**
 * Reporting a partner who deleted their account (decision 2026-10-13).
 *
 * Deleting an account cascades its matches. The person who stayed kept every
 * Report button that names the match — on the pitch, the date card, the
 * coordination message — but each one led nowhere: the match row was gone, so
 * the report was refused as if they had never been paired. Someone who behaved
 * badly on a date could delete the account the same evening and leave no
 * trace for moderation, and no record that would follow them if they came
 * back.
 *
 * Two halves close that:
 *
 *  - **`recordFormerMatches`** runs inside the deletion transaction, right after
 *    the safety tombstones are written, and keeps a `former_matches` row per
 *    match the account touched within `FORMER_MATCH_REPORT_WINDOW_DAYS`: the
 *    old match id, the survivor, the deleted account's id. Only when a
 *    tombstone was written — that is what the report attaches to, and without
 *    one (no provable identity, the demo) a report could never reach anyone.
 *  - **`fileFormerPartnerReport`** is the fallback every report entry point
 *    takes when the match row is gone. The report is stored against the former
 *    account (`reports.reported_former_id`), exactly as reports filed BEFORE a
 *    deletion are, and its Tier is applied to the tombstones — a strike, a
 *    suspension, a ban, a freeze — so `restoreSafetyHistory` puts it on the
 *    person if they return. When the person has ALREADY returned (the
 *    tombstones were restored onto a new account), the report goes to that
 *    account through the ordinary moderation engine instead, with the same
 *    session revocation and match cancellation a live report would cause.
 *
 * One report per survivor per match, as before: `former_matches.reported_at`
 * takes over the guard the `(reporter_id, match_id)` unique can no longer give
 * once `match_id` is null.
 *
 * Not in the demo: the demo writes no tombstones, so it writes no traces
 * either, and a report on a deleted demo partner behaves as it always did.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

type RecordDb = Pick<Prisma.TransactionClient, "match" | "report" | "formerMatch">;

/**
 * Keep a trace of every recent match of the account being deleted, for the
 * person on the other side. Call INSIDE the deletion transaction, after
 * `writeSafetyTombstones` reported at least one tombstone and before the user
 * row (and with it the matches) is deleted.
 *
 * "Recent" is any match created, moved or dated within the window — so a date
 * three weeks ago counts, an expired proposal from last spring does not. A
 * match the survivor already reported is kept with `reportedAt` set, so the
 * button answers "already reported" instead of opening a second report.
 */
export async function recordFormerMatches(
  db: RecordDb,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const since = new Date(now.getTime() - FORMER_MATCH_REPORT_WINDOW_DAYS * DAY_MS);
  const matches = await db.match.findMany({
    where: {
      AND: [
        { OR: [{ userAId: userId }, { userBId: userId }] },
        { OR: [{ updatedAt: { gte: since } }, { agreedTime: { gte: since } }] },
      ],
    },
    select: { id: true, userAId: true, userBId: true },
  });
  const rows = matches
    .map((match) => ({
      matchId: match.id,
      survivorId: match.userAId === userId ? match.userBId : match.userAId,
    }))
    .filter((row) => row.survivorId !== userId);
  if (rows.length === 0) return 0;

  const alreadyReported = await db.report.findMany({
    where: { OR: rows.map((row) => ({ reporterId: row.survivorId, matchId: row.matchId })) },
    select: { reporterId: true, matchId: true },
  });
  const reported = new Set(alreadyReported.map((row) => `${row.matchId}:${row.reporterId}`));

  const created = await db.formerMatch.createMany({
    data: rows.map((row) => ({
      matchId: row.matchId,
      survivorId: row.survivorId,
      formerUserId: userId,
      reportedAt: reported.has(`${row.matchId}:${row.survivorId}`) ? now : null,
    })),
    skipDuplicates: true,
  });
  return created.count;
}

/** The trace of `matchId` for `survivorId`, when one exists. */
export async function findFormerMatch(
  matchId: string,
  survivorId: string,
): Promise<{ formerUserId: string; reportedAt: Date | null } | null> {
  return prisma.formerMatch.findUnique({
    where: { matchId_survivorId: { matchId, survivorId } },
    select: { formerUserId: true, reportedAt: true },
  });
}

/**
 * The survivor's most recent former match that can still be reported — what
 * the menu agent offers when the person asks to report someone and has no
 * live match left.
 */
export async function latestReportableFormerMatch(
  survivorId: string,
): Promise<{ matchId: string } | null> {
  return prisma.formerMatch.findFirst({
    where: { survivorId, reportedAt: null },
    orderBy: { createdAt: "desc" },
    select: { matchId: true },
  });
}

export interface FormerPartnerReportInput {
  matchId: string;
  reporterId: string;
  tier: ReportTier;
  rawText: string;
  reasonSummary: string;
  /**
   * False stores the report for a moderator and applies nothing — the
   * Telegram flow's "manual review required" path.
   */
  enforce: boolean;
  /** `reports.admin_reviewed` for the stored row. */
  adminReviewed: boolean;
  language: Language;
  api: Api<RawApi> | null;
  now?: Date;
}

export type FormerPartnerReportResult = "filed" | "duplicate" | "not_found";

/**
 * File a report against the partner of `matchId` after that partner deleted
 * their account. `"not_found"` means there is no trace for this reporter and
 * match (never paired, outside the window, or nothing left to attach to) and
 * the caller answers as it does for an unknown match; `"duplicate"` means this
 * match was already reported by them.
 */
export async function fileFormerPartnerReport(
  input: FormerPartnerReportInput,
): Promise<FormerPartnerReportResult> {
  const now = input.now ?? new Date();
  const trace = await findFormerMatch(input.matchId, input.reporterId);
  if (!trace) return "not_found";
  if (trace.reportedAt) return "duplicate";
  const formerUserId = trace.formerUserId;

  const result = await prisma.$transaction(async (tx) => {
    // Serialise with a second report on the same former account and with
    // `restoreSafetyHistory`, which rewrites these rows when the person
    // returns: a report must land either before the relink (and travel with
    // it) or after it (and go to the returned account), never in between.
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM safety_tombstones WHERE former_user_id = ${formerUserId}::uuid FOR UPDATE
    `;
    if (locked.length === 0) return { kind: "not_found" as const };

    const claimed = await tx.formerMatch.updateMany({
      where: { matchId: input.matchId, survivorId: input.reporterId, reportedAt: null },
      data: { reportedAt: now },
    });
    if (claimed.count === 0) return { kind: "duplicate" as const };

    const restored = await tx.safetyTombstone.findFirst({
      where: { formerUserId, restoredToUserId: { not: null } },
      select: { restoredToUserId: true },
    });
    const liveUserId = restored?.restoredToUserId
      ? (
          await tx.user.findUnique({
            where: { id: restored.restoredToUserId },
            select: { id: true },
          })
        )?.id ?? null
      : null;

    await tx.report.create({
      data: {
        reporterId: input.reporterId,
        reportedId: liveUserId,
        reportedFormerId: liveUserId ? null : formerUserId,
        matchId: null,
        rawText: input.rawText,
        tier: input.tier,
        reasonSummary: input.reasonSummary,
        adminReviewed: input.adminReviewed,
      },
    });

    if (!input.enforce || input.tier === 1) {
      return { kind: "filed" as const, liveUserId, outcome: null, cancellations: [] };
    }
    if (!liveUserId) {
      await applyReportToTombstones(tx, formerUserId, input.tier, now);
      return { kind: "filed" as const, liveUserId, outcome: null, cancellations: [] };
    }
    const outcome = await applyReportAction(
      {
        tier: input.tier,
        reporterUserId: input.reporterId,
        reportedUserId: liveUserId,
        reasonSummary: input.reasonSummary,
        language: input.language,
      },
      tx,
    );
    const cancellations: CancelledPartner[] = moderationOutcomeRequiresCancellation(outcome)
      ? await claimInFlightMatchCancellations(liveUserId, tx, { strict: true })
      : [];
    return { kind: "filed" as const, liveUserId, outcome, cancellations };
  });

  if (result.kind !== "filed") return result.kind;

  console.info(
    `[former-match] report filed match=${input.matchId} tier=${input.tier} ` +
      `target=${result.liveUserId ? "returned_account" : "tombstone"} enforce=${input.enforce}`,
  );
  if (input.enforce && input.tier === 1) {
    // The one effect that is the reporter's own: never pair them with this
    // kind of person again. Same as a live Tier 1, after commit.
    await appendNegativeConstraint(input.reporterId, input.reasonSummary, input.language);
  }
  await deliverCancelledPartnerEffects(result.cancellations, input.api);
  if (result.liveUserId && result.outcome) {
    await notifyReportedUser(input.api, result.liveUserId, result.outcome);
  }
  return "filed";
}

/**
 * Apply a report filed against a deleted account to that account's tombstones.
 * Call INSIDE the report transaction, after locking the tombstone rows.
 *
 * Mirrors `applyReportAction` on the stored record, since there is no live
 * account to act on: Tier 2 adds a strike (2 → suspended for
 * `SUSPENSION_DAYS`, 3 or more → banned), Tier 3 marks the record
 * `pending_investigation`, Tier 1 changes nothing here. Unlike the live engine
 * it never makes a record milder — a stored ban is not turned into a freeze, a
 * freeze not into a suspension — because nobody is around to appeal the
 * difference. Every tombstone of the former account is written together, so
 * they stay identical; `restoreSafetyHistory` applies the result if the same
 * person comes back.
 */
export async function applyReportToTombstones(
  db: Pick<Prisma.TransactionClient, "safetyTombstone">,
  formerUserId: string,
  tier: ReportTier,
  now: Date = new Date(),
): Promise<{ status: UserStatus | null; strikes: number } | null> {
  if (tier === 1) return null;
  const rows = await db.safetyTombstone.findMany({
    where: { formerUserId },
    select: { status: true, suspendedUntil: true, strikes: true },
  });
  if (rows.length === 0) return null;

  const strictest = strictestTombstone(rows, now);
  const rank = strictest?.rank ?? 0;
  let status: UserStatus | null = strictest?.status ?? null;
  let suspendedUntil: Date | null = strictest?.suspendedUntil ?? null;
  let strikes = Math.max(...rows.map((row) => row.strikes));

  if (tier === 3) {
    if (rank < (STATUS_RANK.pending_investigation ?? 0)) {
      status = "pending_investigation";
      suspendedUntil = null;
    }
  } else {
    strikes += 1;
    if (strikes >= 3) {
      status = "banned";
      suspendedUntil = null;
    } else if (strikes === 2 && rank < (STATUS_RANK.suspended ?? 0)) {
      status = "suspended";
      suspendedUntil = new Date(now.getTime() + SUSPENSION_DAYS * DAY_MS);
    }
  }

  await db.safetyTombstone.updateMany({
    where: { formerUserId },
    data: { status, suspendedUntil: status === "suspended" ? suspendedUntil : null, strikes },
  });
  return { status, strikes };
}
