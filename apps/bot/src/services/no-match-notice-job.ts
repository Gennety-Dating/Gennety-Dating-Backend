import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { NO_MATCH_NOTICE_RESUME_WINDOW_MS } from "@gennety/shared";
import { sendNoMatchNotices, type NoMatchNotifyResult } from "./no-match-notifier.js";
import { autoResumeStarvedUsers } from "./pool-exhaustion.js";
import { getPreviousBatchDate } from "./next-batch.js";

/**
 * When the "no match this drop" notice runs, and what makes it run again.
 *
 * It used to be a cron at 18:15 that fired whatever the drop was doing (A13-H10).
 * The drop's pitches are paced out in-process and can take far longer than
 * fifteen minutes, so the notice regularly went out while pitches were still
 * queued — and anyone whose pitch had not been sent yet was told nobody had been
 * found, minutes before their match arrived.
 *
 * Now the drop job runs the notice itself once its dispatch has finished
 * (`after-drop`). The cron stays as a fallback (`schedule`) for a drop that did
 * not run in this process, and it defers instead of racing: while a drop is in
 * progress here, or while rows from the current drop are still `proposed` with
 * no pitch sent (a dispatch that died — the stranded-proposal sweep resumes
 * those). A deferral, a quiet-hours hold (A13-M22) and a failed run all leave
 * the job pending, and the `retry` tick re-runs a pending job until it goes out.
 *
 * Re-running is always safe: `NoMatchNotice` is claimed per user per drop day
 * before anything is sent, and the candidate query excludes whoever holds one.
 *
 * "Pending" lives in memory, and a restart is exactly what strands a notice: a
 * deploy mid-dispatch (the fallback had deferred), or overnight (quiet hours had
 * held the tail). So a process that boots within
 * `NO_MATCH_NOTICE_RESUME_WINDOW_MS` of the latest drop re-arms the job
 * (`armAfterRestart`); a notice that already went out re-runs as a no-op over
 * people who all hold a claim. Past that window a pending run is dropped rather
 * than sent — it would no longer be news about this drop.
 */

export type NoMatchNoticeTrigger = "after-drop" | "schedule" | "retry";

export type NoMatchNoticeOutcome =
  | "sent"
  | "held-for-quiet-hours"
  | "deferred-drop-in-progress"
  | "deferred-undispatched-proposals"
  | "already-running"
  | "nothing-pending"
  | "expired";

export interface NoMatchNoticeJobDeps {
  /** True while this process's drop job is still creating or dispatching pairs. */
  dropInProgress: () => boolean;
  now?: () => Date;
  notify?: (now: Date) => Promise<NoMatchNotifyResult>;
  /** The D10 pool-exhaustion auto-resume sweep that has always shared this tick. */
  afterNotify?: () => Promise<unknown>;
  /** Drop-batch proposals created since `since` that still have no pitch sent. */
  countUndispatchedDropProposals?: (since: Date) => Promise<number>;
}

export interface NoMatchNoticeJob {
  run(trigger: NoMatchNoticeTrigger): Promise<NoMatchNoticeOutcome>;
  isPending(): boolean;
  /** Boot: re-arm a notice a restart may have lost, if the latest drop is recent. */
  armAfterRestart(): void;
}

/** `Match.source` values the drop batch writes (its own pairs and synthetic fill). */
const DROP_BATCH_SOURCES = ["weekly", "synthetic"];

function countUndispatchedDropProposals(since: Date): Promise<number> {
  return prisma.match.count({
    where: {
      status: "proposed",
      dispatchedAt: null,
      source: { in: DROP_BATCH_SOURCES },
      createdAt: { gte: since },
    },
  });
}

export function createNoMatchNoticeJob(
  api: Api<RawApi>,
  deps: NoMatchNoticeJobDeps,
): NoMatchNoticeJob {
  const now = deps.now ?? (() => new Date());
  const notify = deps.notify ?? ((at: Date) => sendNoMatchNotices(api, at));
  const afterNotify = deps.afterNotify ?? (() => autoResumeStarvedUsers(api));
  const countUndispatched = deps.countUndispatchedDropProposals ?? countUndispatchedDropProposals;

  let pending = false;
  let running = false;

  const withinResumeWindow = (at: Date): boolean =>
    at.getTime() - getPreviousBatchDate(at).getTime() < NO_MATCH_NOTICE_RESUME_WINDOW_MS;

  async function run(trigger: NoMatchNoticeTrigger): Promise<NoMatchNoticeOutcome> {
    if (trigger === "retry") {
      if (!pending) return "nothing-pending";
      if (!withinResumeWindow(now())) {
        pending = false;
        console.warn("[no-match-notice] pending run dropped — the drop it was about is over a day old");
        return "expired";
      }
    }
    if (running) return "already-running";

    // The drop job's own call is the one running INSIDE the drop, so only the
    // fallback and the retry wait for it.
    if (trigger !== "after-drop" && deps.dropInProgress()) {
      pending = true;
      return "deferred-drop-in-progress";
    }

    running = true;
    try {
      const at = now();
      const undispatched = await countUndispatched(getPreviousBatchDate(at));
      if (undispatched > 0) {
        pending = true;
        console.log(
          `[no-match-notice] deferred (${trigger}): ${undispatched} proposal(s) from this drop ` +
            "still have no pitch sent",
        );
        return "deferred-undispatched-proposals";
      }

      pending = false;
      const r = await notify(at);
      if (r.notified > 0 || r.failed > 0 || r.heldForQuietHours) {
        console.log(
          `[no-match-notice] (${trigger}) notified=${r.notified} tier1=${r.tier1} tier2=${r.tier2} ` +
            `tier3plus=${r.tier3plus} paused=${r.paused} skipped=${r.skipped} failed=${r.failed}` +
            (r.heldForQuietHours ? " heldForQuietHours" : ""),
        );
      }
      if (r.heldForQuietHours) pending = true;
      await afterNotify();
      return r.heldForQuietHours ? "held-for-quiet-hours" : "sent";
    } catch (err) {
      // Rethrown for `guardedTick`'s alert; pending so the retry tick tries again.
      pending = true;
      throw err;
    } finally {
      running = false;
    }
  }

  function armAfterRestart(): void {
    if (withinResumeWindow(now())) pending = true;
  }

  return { run, isPending: () => pending, armAfterRestart };
}
