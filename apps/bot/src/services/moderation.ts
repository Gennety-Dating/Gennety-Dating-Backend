import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";
import { cancelInFlightMatchesForUser } from "./cancel-in-flight-matches.js";
import { sendPushToUser } from "./push.js";

/**
 * Post-match moderation engine. Invoked after the LLM has classified a
 * report into a Tier. Encapsulates all strike accounting and status
 * transitions so the handler stays thin and the logic is unit-testable.
 *
 * Policy (PRODUCT_SPEC extension — Reporting & Moderation):
 *   - Tier 1 → append to reporter's negativeConstraints. No penalty on reported.
 *   - Tier 2 → strikes += 1 on reported user:
 *       strikes == 1 → warning DM
 *       strikes == 2 → status = suspended, suspendedUntil = now + 14d
 *       strikes >= 3 → status = banned; cancel in-flight matches
 *   - Tier 3 → status = pending_investigation immediately; cancel in-flight
 *     matches. Report row stays adminReviewed=false for the manual queue.
 */

export const SUSPENSION_DAYS = 14;

export type ReportTier = 1 | 2 | 3;

export interface ApplyReportActionInput {
  tier: ReportTier;
  reporterUserId: string;
  reportedUserId: string;
  reasonSummary: string;
  language: Language;
}

type ModerationDb = Pick<typeof prisma, "user" | "match">;

export type ModerationOutcome =
  | { kind: "tier1" }
  | { kind: "tier2_warning"; strikes: 1 }
  | { kind: "tier2_suspended"; strikes: 2; until: Date }
  | { kind: "tier2_banned"; strikes: number }
  | { kind: "tier3_frozen" };

export async function applyReportAction(
  input: ApplyReportActionInput,
  db: ModerationDb = prisma,
  api: Api<RawApi> | null = null,
): Promise<ModerationOutcome> {
  const { tier, reporterUserId, reportedUserId, reasonSummary, language } = input;

  if (tier === 1) {
    await appendNegativeConstraint(reporterUserId, reasonSummary, language);
    return { kind: "tier1" };
  }

  if (tier === 3) {
    await db.user.update({
      where: { id: reportedUserId },
      data: { status: "pending_investigation" },
    });
    await cancelInFlightMatchesForUser(reportedUserId, api);
    return { kind: "tier3_frozen" };
  }

  // Tier 2: atomic increment, then branch on the post-increment value so
  // concurrent reports can't race past a threshold.
  const updated = await db.user.update({
    where: { id: reportedUserId },
    data: { strikes: { increment: 1 } },
    select: { strikes: true },
  });

  const strikes = updated.strikes;
  if (strikes >= 3) {
    await db.user.update({
      where: { id: reportedUserId },
      data: { status: "banned" },
    });
    await cancelInFlightMatchesForUser(reportedUserId, api);
    return { kind: "tier2_banned", strikes };
  }
  if (strikes === 2) {
    const until = new Date(Date.now() + SUSPENSION_DAYS * 24 * 60 * 60 * 1000);
    await db.user.update({
      where: { id: reportedUserId },
      data: { status: "suspended", suspendedUntil: until },
    });
    await cancelInFlightMatchesForUser(reportedUserId, api);
    return { kind: "tier2_suspended", strikes: 2, until };
  }
  return { kind: "tier2_warning", strikes: 1 };
}

/**
 * DM the reported user about the moderation outcome. Best-effort — failures
 * are logged but don't surface to the reporter.
 */
export async function notifyReportedUser(
  api: Api<RawApi>,
  reportedUserId: string,
  outcome: ModerationOutcome,
): Promise<void> {
  if (outcome.kind === "tier1") return;

  const user = await prisma.user.findUnique({
    where: { id: reportedUserId },
    select: { telegramId: true, language: true },
  });
  if (!user) return;

  const lang: Language = user.language ?? "en";
  const key = messageKeyFor(outcome);
  if (!key) return;

  // M-17: mobile-only users (synthetic negative telegramId) can't be DM'd —
  // deliver the same moderation outcome via push instead. Best-effort:
  // `sendPushToUser` no-ops without a token and swallows its own errors.
  if (user.telegramId <= 0n) {
    await sendPushToUser(reportedUserId, {
      title: "Gennety",
      body: t(lang, key),
      data: { type: "moderation" },
    });
    return;
  }

  try {
    await api.sendMessage(Number(user.telegramId), t(lang, key));
  } catch (err) {
    console.warn("Failed to notify reported user of moderation outcome:", err);
  }
}

type ReportDmKey =
  | "reportWarningStrike1"
  | "reportSuspendedDM"
  | "reportBannedDM"
  | "reportPendingInvestigationDM";

function messageKeyFor(outcome: ModerationOutcome): ReportDmKey | null {
  switch (outcome.kind) {
    case "tier2_warning":
      return "reportWarningStrike1";
    case "tier2_suspended":
      return "reportSuspendedDM";
    case "tier2_banned":
      return "reportBannedDM";
    case "tier3_frozen":
      return "reportPendingInvestigationDM";
    default:
      return null;
  }
}
