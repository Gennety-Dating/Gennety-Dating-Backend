import { prisma } from "@gennety/db";
import { isAttendanceOutcome, type AttendanceOutcome } from "./attendance.js";

/**
 * Writing the «did you meet?» answer — one place for both rails.
 *
 * Telegram asks it with buttons (`handlers/date/attendance.ts`); the app asks
 * it as the first step of the feedback screen (2026-11-15). Both write the
 * same two columns per side and nothing else: the answer of a live person is
 * the only thing that writes `dateAttended*` (see `services/attendance.ts`),
 * and the other side's answer is never touched — a disagreement is the real
 * `disputed` state, not an error to collapse.
 */
export async function writeAttendanceSide(
  matchId: string,
  isA: boolean,
  attended: boolean,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: isA ? { dateAttendedA: attended } : { dateAttendedB: attended },
  });
}

export async function writeAttendanceOutcomeSide(
  matchId: string,
  isA: boolean,
  outcome: AttendanceOutcome,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: isA ? { attendanceOutcomeA: outcome } : { attendanceOutcomeB: outcome },
  });
}

export type AttendanceRefusal = "match-not-found" | "not-participant" | "wrong-state" | "bad-outcome";

/**
 * The app's answer. Same gate as the Telegram buttons: only a `completed`
 * match (the question is asked exactly at that transition), only a
 * participant. `outcome` is the "what happened?" follow-up to a no and is
 * refused with a yes — "we met, the partner didn't come" is not an answer.
 */
export async function recordDateAttendance(input: {
  matchId: string;
  userId: string;
  attended: boolean;
  outcome?: unknown;
}): Promise<{ ok: true } | { ok: false; error: AttendanceRefusal }> {
  const outcome = input.outcome ?? null;
  if (outcome !== null && (input.attended || !isAttendanceOutcome(outcome))) {
    return { ok: false, error: "bad-outcome" };
  }

  const match = await prisma.match.findUnique({
    where: { id: input.matchId },
    select: { status: true, userAId: true, userBId: true },
  });
  if (!match) return { ok: false, error: "match-not-found" };
  const isA = match.userAId === input.userId;
  if (!isA && match.userBId !== input.userId) return { ok: false, error: "not-participant" };
  if (match.status !== "completed") return { ok: false, error: "wrong-state" };

  await writeAttendanceSide(input.matchId, isA, input.attended);
  if (outcome !== null) {
    await writeAttendanceOutcomeSide(input.matchId, isA, outcome as AttendanceOutcome);
  }
  return { ok: true };
}
