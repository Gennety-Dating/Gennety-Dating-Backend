import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIntervalPoller } from "./poller";

/** A tick whose request the test answers by hand. */
function manualTick() {
  const answers: Array<() => void> = [];
  const tick = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        answers.push(resolve);
      }),
  );
  return {
    tick,
    answerNext: async (): Promise<void> => {
      answers.shift()?.();
      // Let the poller's own `finally` run.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createIntervalPoller", () => {
  it("ticks at the given cadence, starting one interval after start()", async () => {
    const { tick, answerNext } = manualTick();
    const poller = createIntervalPoller(4000, tick);
    poller.start();

    vi.advanceTimersByTime(3999);
    expect(tick).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(tick).toHaveBeenCalledTimes(1);
    await answerNext();

    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("skips a tick while the previous request is still out — never two at once", async () => {
    const { tick, answerNext } = manualTick();
    const poller = createIntervalPoller(4000, tick);
    poller.start();

    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(1);
    // A 20 s request: four more ticks pass while it is out.
    vi.advanceTimersByTime(16_000);
    expect(tick).toHaveBeenCalledTimes(1);

    await answerNext();
    // The cadence is unchanged — the next request leaves on the next tick.
    vi.advanceTimersByTime(4000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("recovers after a failed request", async () => {
    let fail!: () => void;
    const tick = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => (fail = () => reject(new Error("x")))))
      .mockResolvedValue(undefined);
    const poller = createIntervalPoller(1000, async () => {
      try {
        await tick();
      } catch {
        /* the caller's tick owns its errors */
      }
    });
    poller.start();

    vi.advanceTimersByTime(1000);
    fail();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("stop() ends the ticks; start() is idempotent and resumes", async () => {
    const tick = vi.fn(async () => undefined);
    const poller = createIntervalPoller(1000, tick);

    poller.start();
    poller.start();
    expect(poller.running).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(1);

    poller.stop();
    expect(poller.running).toBe(false);
    await Promise.resolve();
    vi.advanceTimersByTime(5000);
    expect(tick).toHaveBeenCalledTimes(1);

    poller.start();
    vi.advanceTimersByTime(1000);
    expect(tick).toHaveBeenCalledTimes(2);
    poller.stop();
  });

  it("a tick that throws before returning does not wedge the poll", () => {
    let calls = 0;
    const poller = createIntervalPoller(1000, () => {
      calls += 1;
      if (calls === 1) throw new Error("sync");
      return Promise.resolve();
    });
    poller.start();

    expect(() => vi.advanceTimersByTime(1000)).toThrow("sync");
    vi.advanceTimersByTime(1000);
    expect(calls).toBe(2);
    poller.stop();
  });
});
