/**
 * The meeting ceremony's server half — a HOLD that waits for the partner, and
 * the common start both phones play the scene from (living-canvas.md §6.2,
 * decision journal 2026-09-29).
 *
 * The server does not draw anything. It hands each phone three facts: the
 * instant the scene starts on the SERVER's clock (`startAt`), which part this
 * phone plays (`role`), and the server's own clock at the moment of answering
 * (`serverNow`) so a phone whose clock drifts can still land on the same frame.
 *
 * ── No realtime channel, on purpose ─────────────────────────────────────
 *
 * The only moment in the date that needs speed is the one where two people
 * hold their phones together, so that one moment is a long-poll: the first
 * hold waits (up to `BUMP_HOLD_WAIT_MS`) and the second one wakes it. The bot
 * runs as ONE process (pm2 `gennety-bot`), so an in-process emitter is the
 * wake-up; a poll of the `DateBumpSession` row every 250 ms is the fallback
 * that keeps a second process — or a missed event — from turning into a hang.
 *
 * ── No schema change ─────────────────────────────────────────────────────
 *
 * Both facts come from columns the Bump already writes. `startAt` is
 * `verifiedAt + BUMP_CEREMONY_LEAD_MS`; `role` is read off which side's shake
 * timestamp equals `verifiedAt` (`ceremonyRole`).
 */

import { EventEmitter } from "node:events";

import { prisma } from "@gennety/db";
import { BUMP_CEREMONY_LEAD_MS, BUMP_CEREMONY_REPLAY_MS } from "@gennety/shared";

/**
 * `A` waited, `B` completed the pair — the mascot leaves A's phone and lands on
 * B's. Not the match's side: a match's `userA` may play either part.
 */
export type CeremonyRole = "A" | "B";

export interface BumpCeremony {
  /** When the scene starts, on the server's clock. ISO 8601. */
  startAt: string;
  role: CeremonyRole;
  /** The server's clock when this answer was written. ISO 8601. */
  serverNow: string;
}

/** The columns the ceremony is derived from. */
export interface CeremonySnapshot {
  isVerified: boolean;
  verifiedAt: Date | null;
  userAShakeAt: Date | null;
  userBShakeAt: Date | null;
}

export const CEREMONY_SNAPSHOT_SELECT = {
  isVerified: true,
  verifiedAt: true,
  userAShakeAt: true,
  userBShakeAt: true,
} as const;

// ---------------------------------------------------------------------------
// Pure half
// ---------------------------------------------------------------------------

/**
 * Which part this phone plays, from existing columns only.
 *
 * `verifyBump` writes `verifiedAt = at` of the call that completed the pair,
 * and that call had just written the same `at` into its own side's column — so
 * the side whose stamp equals `verifiedAt` is B, the other is A.
 *
 * Two edge cases, both resolved so the two phones can never disagree:
 *
 * - **Both stamps equal `verifiedAt`** (two holds in the same millisecond).
 *   The match's own sides break the tie: userA plays A, userB plays B. Each
 *   phone computes this independently and they still come out different.
 * - **Neither does.** Only a later write can cause it — an old shake client
 *   shaking again after the pair verified overwrites its own column (a hold
 *   never does: it does not write to a verified pair). The caller did not
 *   provably complete the pair, so it plays A; the old client that did has no
 *   ceremony to disagree with.
 *
 * A mixed pair — a hold waiting, an old shake completing with its device clock
 * as `verifiedAt` — gives the holder A, which is what happened.
 */
export function ceremonyRole(snapshot: CeremonySnapshot, side: "A" | "B"): CeremonyRole {
  const verifiedMs = snapshot.verifiedAt?.getTime();
  if (verifiedMs === undefined) return "A";
  const mine = side === "A" ? snapshot.userAShakeAt : snapshot.userBShakeAt;
  const peer = side === "A" ? snapshot.userBShakeAt : snapshot.userAShakeAt;
  const mineCompleted = mine?.getTime() === verifiedMs;
  const peerCompleted = peer?.getTime() === verifiedMs;
  if (mineCompleted && peerCompleted) return side;
  return mineCompleted ? "B" : "A";
}

/**
 * The ceremony for this phone, or null when there is none to play.
 *
 * None before verification, and none once the scene is over
 * (`now ≥ startAt + BUMP_CEREMONY_REPLAY_MS`): a retry after a dropped
 * long-poll still gets it, a hold minutes later does not — the ceremony is a
 * moment, not a replay button.
 *
 * `startAt` is never put further ahead than one lead from now. For a pair of
 * holds this changes nothing — `verifiedAt` is the server's own clock and is
 * already in the past. It only matters for a mixed pair, where `verifiedAt` is
 * an old shake client's DEVICE clock (trusted up to a minute of skew): a
 * device running 40 s fast must not leave the holder staring at an empty
 * screen for 40 s. That old client plays no scene, so nobody else's start
 * moves with it.
 */
export function ceremonyFor(
  snapshot: CeremonySnapshot,
  side: "A" | "B",
  now: Date,
): BumpCeremony | null {
  if (!snapshot.isVerified || !snapshot.verifiedAt) return null;
  const nowMs = now.getTime();
  const startAtMs = Math.min(
    snapshot.verifiedAt.getTime() + BUMP_CEREMONY_LEAD_MS,
    nowMs + BUMP_CEREMONY_LEAD_MS,
  );
  if (nowMs >= startAtMs + BUMP_CEREMONY_REPLAY_MS) return null;
  return {
    startAt: new Date(startAtMs).toISOString(),
    role: ceremonyRole(snapshot, side),
    serverNow: now.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The wake-up
// ---------------------------------------------------------------------------

const verifiedEvents = new EventEmitter();
// One listener per waiting hold, keyed by match id. The rate limiter bounds how
// many a person can open; the default warning at 10 would only be noise.
verifiedEvents.setMaxListeners(0);

/**
 * Wake every hold waiting on this match. Called by `verifyBump` right after
 * its compare-and-set commits — for a hold or an old shake alike.
 */
export function notifyBumpVerified(matchId: string): void {
  verifiedEvents.emit(matchId);
}

/** Test/diagnostic: how many holds are waiting on this match right now. */
export function waitingHoldCount(matchId: string): number {
  return verifiedEvents.listenerCount(matchId);
}

/** The fallback poll interval while a hold waits. */
export const HOLD_POLL_MS = 250;

export interface WaitForVerificationOptions {
  /** Epoch ms to give up at. */
  until: number;
  /** Aborted when the client goes away; the wait resolves null at once. */
  signal: AbortSignal;
  pollMs?: number;
  now?: () => number;
}

/**
 * Wait until the pair is verified, the deadline passes, or the client leaves.
 *
 * Resolves the row when verified, null otherwise. Holds nothing open while it
 * waits — no transaction, no connection: each check is one short read, and
 * between checks there is only a timer and a listener, both removed on every
 * way out.
 *
 * At the deadline it reads once more before saying no, so a verification
 * committed in the last few milliseconds is not answered "not verified" only
 * because the read it woke was still in flight.
 */
export function waitForBumpVerification(
  matchId: string,
  options: WaitForVerificationOptions,
): Promise<CeremonySnapshot | null> {
  const pollMs = options.pollMs ?? HOLD_POLL_MS;
  const now = options.now ?? Date.now;
  const { signal } = options;

  return new Promise((resolve) => {
    let settled = false;
    let expired = false;
    let inFlight = false;
    let again = false;
    let pollTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (row: CeremonySnapshot | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(pollTimer);
      clearTimeout(deadlineTimer);
      verifiedEvents.off(matchId, onVerified);
      signal.removeEventListener("abort", onAbort);
      resolve(row);
    };

    const read = async (): Promise<CeremonySnapshot | null> => {
      try {
        return await prisma.dateBumpSession.findUnique({
          where: { matchId },
          select: CEREMONY_SNAPSHOT_SELECT,
        });
      } catch (err) {
        console.error("[bump-ceremony] hold poll failed:", err);
        return null;
      }
    };

    const check = async (): Promise<void> => {
      if (settled) return;
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = true;
      clearTimeout(pollTimer);
      const row = await read();
      inFlight = false;
      if (row?.isVerified) finish(row);
      // Past the deadline the deadline's own read decides; no new polls.
      if (settled || expired) return;
      if (again) {
        again = false;
        void check();
        return;
      }
      pollTimer = setTimeout(() => void check(), pollMs);
    };

    const onVerified = (): void => void check();
    const onAbort = (): void => finish(null);

    const deadlineTimer = setTimeout(
      () => {
        if (settled) return;
        expired = true;
        clearTimeout(pollTimer);
        verifiedEvents.off(matchId, onVerified);
        void read().then((row) => finish(row?.isVerified ? row : null));
      },
      Math.max(0, options.until - now()),
    );

    if (signal.aborted) {
      finish(null);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    verifiedEvents.on(matchId, onVerified);
    // The partner may have verified between our own write and this listener.
    void check();
  });
}
