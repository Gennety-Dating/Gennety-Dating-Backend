/**
 * First-drop calibration window (founder decision 2026-10-11).
 *
 * A freshly onboarded account does not enter the very next evening batch.
 * For `FIRST_DROP_CALIBRATION_HOURS` (24 by default) after onboarding the agent
 * studies the profile and the city pool — the Profiler's first questions land,
 * the embedding settles — and only then does the person become eligible. With
 * the daily 18:00 batch that reads as "skip the nearest evening": the first
 * introduction comes on the second evening (~24–47h after onboarding).
 *
 * This is a real hold, not a scripted spinner (F2 "only real work spins"): the
 * profile is genuinely outside the eligibility scan, so the "searching" status
 * the clients show during the window is true. Because the profile never enters
 * the batch, it is never counted as missed — no famine state, no famine notice.
 *
 * The window is armed once, at onboarding finalize, and only for a profile that
 * has never been matched. Legacy accounts keep `calibrationUntil = null`.
 */

import { prisma, type Prisma } from "@gennety/db";
import { env } from "../config.js";
import { getNextBatchDate } from "./next-batch.js";

const HOUR_MS = 60 * 60 * 1000;

/** The window end for an account finishing onboarding at `now`, or null when off. */
export function calibrationUntilFrom(
  now: Date,
  hours: number = env.FIRST_DROP_CALIBRATION_HOURS,
): Date | null {
  if (!(hours > 0)) return null;
  return new Date(now.getTime() + hours * HOUR_MS);
}

/**
 * Arm the window at onboarding finalize. Idempotent: a re-finalize never moves
 * an existing window, and a profile that has ever been matched is never held.
 */
export async function armFirstDropCalibration(
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const until = calibrationUntilFrom(now);
  if (!until) return;
  await prisma.profile.updateMany({
    where: { userId, calibrationUntil: null, lastMatchedAt: null },
    data: { calibrationUntil: until },
  });
}

/**
 * Profile filter: the window is over (or was never armed) at `at`. A batch
 * firing at `at` includes the profile iff `calibrationUntil <= at`.
 */
export function calibrationOverWhere(at: Date): Prisma.ProfileWhereInput {
  return { OR: [{ calibrationUntil: null }, { calibrationUntil: { lte: at } }] };
}

export interface CalibrationState {
  /** True while the profile is held out of matching. */
  calibrating: boolean;
  /** The first batch the profile can take part in; null when not calibrating. */
  firstDropAt: Date | null;
}

export function resolveCalibration(
  calibrationUntil: Date | null | undefined,
  now: Date = new Date(),
): CalibrationState {
  if (!calibrationUntil || calibrationUntil.getTime() <= now.getTime()) {
    return { calibrating: false, firstDropAt: null };
  }
  // First batch at or after the window end (a slot exactly on the end counts).
  const firstDropAt = getNextBatchDate(new Date(calibrationUntil.getTime() - 1));
  return { calibrating: true, firstDropAt };
}

export async function loadCalibration(
  userId: string,
  now: Date = new Date(),
): Promise<CalibrationState> {
  const profile = await prisma.profile.findUnique({
    where: { userId },
    select: { calibrationUntil: true },
  });
  return resolveCalibration(profile?.calibrationUntil, now);
}
