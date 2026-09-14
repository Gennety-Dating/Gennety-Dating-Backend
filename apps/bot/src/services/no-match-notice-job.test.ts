import { describe, it, expect, vi, beforeEach } from "vitest";

// The job's defaults reach the database and the real notifier; every test here
// injects its own, so these mocks only keep the imports inert.
vi.mock("@gennety/db", () => ({ prisma: { match: { count: vi.fn() } } }));
vi.mock("./no-match-notifier.js", () => ({ sendNoMatchNotices: vi.fn() }));
vi.mock("./pool-exhaustion.js", () => ({ autoResumeStarvedUsers: vi.fn() }));

import { prisma } from "@gennety/db";
import { createNoMatchNoticeJob, type NoMatchNoticeJobDeps } from "./no-match-notice-job.js";
import type { NoMatchNotifyResult } from "./no-match-notifier.js";

const NOW = new Date("2026-05-07T15:30:00Z"); // Thursday 18:30 Kyiv, after the 18:00 drop

function notifyResult(overrides: Partial<NoMatchNotifyResult> = {}): NoMatchNotifyResult {
  return {
    notified: 0,
    skipped: 0,
    failed: 0,
    tier1: 0,
    tier2: 0,
    tier3plus: 0,
    paused: 0,
    heldForQuietHours: false,
    errors: [],
    ...overrides,
  };
}

function setup(overrides: Partial<NoMatchNoticeJobDeps> = {}) {
  let dropRunning = false;
  const notify = vi.fn(async (_at: Date) => notifyResult());
  const afterNotify = vi.fn(async () => undefined);
  const countUndispatchedDropProposals = vi.fn(async (_since: Date) => 0);
  const job = createNoMatchNoticeJob({} as never, {
    dropInProgress: () => dropRunning,
    now: () => NOW,
    notify,
    afterNotify,
    countUndispatchedDropProposals,
    ...overrides,
  });
  return {
    job,
    notify,
    afterNotify,
    countUndispatchedDropProposals,
    setDropRunning: (v: boolean) => {
      dropRunning = v;
    },
  };
}

describe("no-match notice job (A13-H10 / A13-M22)", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("the fallback schedule does not send while this process's drop is still dispatching", async () => {
    const { job, notify, setDropRunning } = setup();
    setDropRunning(true);

    await expect(job.run("schedule")).resolves.toBe("deferred-drop-in-progress");
    expect(notify).not.toHaveBeenCalled();
    expect(job.isPending()).toBe(true);
  });

  it("the drop job's own call runs even though the drop is the thing in progress", async () => {
    const { job, notify, afterNotify, setDropRunning } = setup();
    setDropRunning(true);

    await expect(job.run("after-drop")).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledWith(NOW);
    expect(afterNotify).toHaveBeenCalledTimes(1);
    expect(job.isPending()).toBe(false);
  });

  it("defers while this drop still has proposals with no pitch sent (a dispatch that died)", async () => {
    const { job, notify, countUndispatchedDropProposals } = setup();
    countUndispatchedDropProposals.mockResolvedValueOnce(3);

    await expect(job.run("schedule")).resolves.toBe("deferred-undispatched-proposals");
    expect(notify).not.toHaveBeenCalled();
    // Counted from the drop this notice is about: Thursday 18:00 Kyiv.
    const since = countUndispatchedDropProposals.mock.calls[0]![0];
    expect(since.toISOString()).toBe("2026-05-07T15:00:00.000Z");

    // Once the stranded rows are resumed, the retry tick sends.
    await expect(job.run("retry")).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(1);
    expect(job.isPending()).toBe(false);
  });

  it("the retry tick is a no-op when nothing is pending", async () => {
    const { job, notify, countUndispatchedDropProposals } = setup();

    await expect(job.run("retry")).resolves.toBe("nothing-pending");
    expect(countUndispatchedDropProposals).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });

  it("a run stopped by quiet hours stays pending so the retry tick resumes it", async () => {
    const { job, notify } = setup();
    notify.mockResolvedValueOnce(notifyResult({ notified: 40, heldForQuietHours: true }));

    await expect(job.run("after-drop")).resolves.toBe("held-for-quiet-hours");
    expect(job.isPending()).toBe(true);

    await expect(job.run("retry")).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(2);
    expect(job.isPending()).toBe(false);
  });

  it("never runs two notice passes at once", async () => {
    let finish: () => void = () => {};
    const { job, notify } = setup();
    notify.mockImplementationOnce(
      () =>
        new Promise<NoMatchNotifyResult>((resolve) => {
          finish = () => resolve(notifyResult());
        }),
    );

    const first = job.run("after-drop");
    await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
    await expect(job.run("schedule")).resolves.toBe("already-running");

    finish();
    await expect(first).resolves.toBe("sent");
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("rethrows a failed run for the health alert and leaves it pending for the retry", async () => {
    const { job, notify } = setup();
    notify.mockRejectedValueOnce(new Error("db down"));

    await expect(job.run("schedule")).rejects.toThrow("db down");
    expect(job.isPending()).toBe(true);
  });

  it("drops a pending run once the drop it was about is over a day old", async () => {
    let at = NOW;
    const { job, notify, countUndispatchedDropProposals } = setup({ now: () => at });
    countUndispatchedDropProposals.mockResolvedValueOnce(2);
    await job.run("schedule");
    expect(job.isPending()).toBe(true);

    at = new Date(NOW.getTime() + 26 * 60 * 60 * 1000); // Friday 20:30 Kyiv
    await expect(job.run("retry")).resolves.toBe("expired");
    expect(job.isPending()).toBe(false);
    expect(notify).not.toHaveBeenCalled();
  });

  // A restart forgets `pending` — and a restart (a deploy mid-dispatch, or
  // overnight while quiet hours hold the tail) is exactly what strands a notice.
  it("re-arms after a restart inside the drop's notice window, and not outside it", async () => {
    const soon = setup({ now: () => new Date("2026-05-08T06:30:00Z") }); // Friday 09:30 Kyiv
    soon.job.armAfterRestart();
    expect(soon.job.isPending()).toBe(true);
    await expect(soon.job.run("retry")).resolves.toBe("sent");

    const late = setup({ now: () => new Date("2026-05-10T09:00:00Z") }); // Sunday
    late.job.armAfterRestart();
    expect(late.job.isPending()).toBe(false);
  });

  it("counts only the drop batch's own undispatched rows by default", async () => {
    const count = prisma.match.count as unknown as ReturnType<typeof vi.fn>;
    count.mockResolvedValueOnce(0);
    const job = createNoMatchNoticeJob({} as never, {
      dropInProgress: () => false,
      now: () => NOW,
      notify: vi.fn(async () => notifyResult()),
      afterNotify: vi.fn(async () => undefined),
    });

    await job.run("schedule");

    expect(count).toHaveBeenCalledWith({
      where: {
        status: "proposed",
        dispatchedAt: null,
        source: { in: ["weekly", "synthetic"] },
        createdAt: { gte: new Date("2026-05-07T15:00:00.000Z") },
      },
    });
  });
});
