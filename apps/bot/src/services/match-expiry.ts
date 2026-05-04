import { prisma } from "@gennety/db";
import { applySilentIgnorePenalty } from "../utils/elo-calculator.js";
import { createMatchEvent } from "./match-events.js";

/**
 * 24-hour TTL expiration for dispatched match proposals.
 *
 * Marks `proposed` matches as `expired` once 24h elapsed since
 * `dispatchedAt` without both sides accepting, and classifies each side
 * for the notification layer:
 *
 *   - "silent": user never responded (`accepted{A|B} == null`).
 *   - "responder": user nailed an Accept or Decline within the window.
 *
 * Forgive-once mechanic per silent side:
 *   - First offense (`Profile.silentIgnoreCount` was `0`) → no Elo
 *     penalty, only a warning message will be sent.
 *   - Repeat offense (`silentIgnoreCount >= 1` BEFORE the increment) →
 *     flat `SILENT_IGNORE_ELO_PENALTY` is deducted from the silent user's
 *     `eloScore`. The peer's rating is intentionally NOT updated by the
 *     silent side: `updateEloScores`'s "decline = peer wins" math would
 *     reward the responder for getting ghosted, which is semantically
 *     wrong for a behavioral penalty. See `applySilentIgnorePenalty`.
 *
 * Atomicity:
 *   - The `proposed → expired` flip is a per-row `updateMany WHERE
 *     id=X AND status='proposed'` so a concurrent decision-handler
 *     transition (e.g. mutual accept arriving in the same tick) never
 *     gets clobbered. If the flip's `count === 0`, we silently skip the
 *     match — somebody else got there first.
 *   - `silentIgnoreCount` is incremented via Prisma's `{ increment: 1 }`
 *     so two parallel expiry ticks can't double-count.
 */

export const MATCH_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export type SideRole = "silent" | "responder";

export interface SideClassification {
  side: "A" | "B";
  userId: string;
  telegramId: bigint;
  language: string | null;
  pitchMessageId: number | null;
  role: SideRole;
  /** Only meaningful for `role === 'silent'`: post-increment count. */
  offenseCount?: number;
  /** Only meaningful for `role === 'silent'`: was Elo deducted? */
  penalised?: boolean;
  /**
   * Peer's prior decision (`acceptedByA/B`) at expiry time. `null` means
   * the peer was also silent. The notify layer uses this to surface a
   * "you missed an accepted date" line to a silent side whose peer had
   * actually agreed — without this, ghosting a willing match looks the
   * same as ghosting a no-show, which the product wants distinguished.
   */
  peerAccepted: boolean | null;
}

export interface MatchExpiry {
  matchId: string;
  sides: SideClassification[];
}

export interface ExpiryResult {
  expired: number;
  matches: MatchExpiry[];
}

interface CandidateMatch {
  id: string;
  userAId: string;
  userBId: string;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  pitchMessageIdA: number | null;
  pitchMessageIdB: number | null;
  userA: { telegramId: bigint; language: string | null };
  userB: { telegramId: bigint; language: string | null };
}

/**
 * Find and expire all proposed matches that have exceeded the TTL.
 *
 * Returns a structured record per expired match for the notify layer to
 * dispatch the right text per side and clear the Telegram pitch
 * keyboard. Failures during Elo updates / event writes are logged and
 * skipped — the match stays expired even if downstream side effects
 * fail, so a flaky DB write can't leave a row stuck in `proposed`.
 */
export async function expireStaleMatches(
  ttlMs: number = MATCH_TTL_MS,
): Promise<ExpiryResult> {
  const cutoff = new Date(Date.now() - ttlMs);

  const candidates: CandidateMatch[] = await prisma.match.findMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null, lt: cutoff },
      NOT: {
        AND: [{ acceptedByA: true }, { acceptedByB: true }],
      },
    },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      acceptedByA: true,
      acceptedByB: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  const matches: MatchExpiry[] = [];

  for (const candidate of candidates) {
    // Atomic flip — if a concurrent decision-handler already moved the
    // row to `cancelled` / `negotiating`, this updates 0 rows and we
    // skip the match entirely.
    const flip = await prisma.match.updateMany({
      where: { id: candidate.id, status: "proposed" },
      data: { status: "expired" },
    });
    if (flip.count === 0) continue;

    const sides = await classifyAndPenalise(candidate);
    matches.push({ matchId: candidate.id, sides });
  }

  if (matches.length > 0) {
    console.log(
      `[expiry] expired ${matches.length} stale match(es) (TTL=${ttlMs}ms)`,
    );
  }

  return { expired: matches.length, matches };
}

/**
 * Per-side classification + Elo penalty + match-event audit. Errors here
 * are logged but never thrown, so a flaky write on side A can't block
 * processing of side B (or the next match in the loop).
 */
async function classifyAndPenalise(
  match: CandidateMatch,
): Promise<SideClassification[]> {
  const sides: SideClassification[] = [];

  const meta = {
    A: {
      side: "A" as const,
      userId: match.userAId,
      telegramId: match.userA.telegramId,
      language: match.userA.language,
      pitchMessageId: match.pitchMessageIdA,
      accepted: match.acceptedByA,
    },
    B: {
      side: "B" as const,
      userId: match.userBId,
      telegramId: match.userB.telegramId,
      language: match.userB.language,
      pitchMessageId: match.pitchMessageIdB,
      accepted: match.acceptedByB,
    },
  };

  for (const key of ["A", "B"] as const) {
    const m = meta[key];
    const peer = key === "A" ? meta.B : meta.A;
    const role: SideRole = m.accepted === null ? "silent" : "responder";

    if (role === "responder") {
      sides.push({
        side: m.side,
        userId: m.userId,
        telegramId: m.telegramId,
        language: m.language,
        pitchMessageId: m.pitchMessageId,
        role,
        peerAccepted: peer.accepted,
      });
      continue;
    }

    // Silent side — increment counter, decide if this is a penalty round.
    let offenseCount = 1;
    let penalised = false;
    try {
      const updated = await prisma.profile.update({
        where: { userId: m.userId },
        data: { silentIgnoreCount: { increment: 1 } },
        select: { silentIgnoreCount: true },
      });
      offenseCount = updated.silentIgnoreCount;
      // First offense (post-increment count == 1) is the warning round.
      // Anything beyond that triggers the flat Elo penalty.
      if (offenseCount > 1) {
        const newElo = await applySilentIgnorePenalty(m.userId);
        penalised = newElo !== null;
      }
    } catch (err) {
      console.warn(
        `[expiry] silentIgnoreCount/penalty failed for userId=${m.userId}:`,
        (err as Error).message,
      );
    }

    sides.push({
      side: m.side,
      userId: m.userId,
      telegramId: m.telegramId,
      language: m.language,
      pitchMessageId: m.pitchMessageId,
      role,
      offenseCount,
      penalised,
      peerAccepted: peer.accepted,
    });
  }

  // Audit events: one per side, mirroring the ACCEPTED/DECLINED rows the
  // decision handler writes. The `actorId` for a silent side is the
  // silent user themselves (the action they took == none); for the
  // responder we record the peer (silent) as `actorId` so a downstream
  // "your match ignored you" query can find the row by responder=target.
  for (const s of sides) {
    const peer = s.side === "A" ? meta.B : meta.A;
    try {
      await createMatchEvent({
        matchId: match.id,
        actorId: s.role === "silent" ? s.userId : peer.userId,
        targetId: s.role === "silent" ? peer.userId : s.userId,
        actionType: s.role === "silent" ? "EXPIRED_SILENT" : "EXPIRED_PEER_IGNORED",
      });
    } catch (err) {
      console.warn(
        `[expiry] match-event write failed for matchId=${match.id} side=${s.side}:`,
        (err as Error).message,
      );
    }
  }

  return sides;
}
