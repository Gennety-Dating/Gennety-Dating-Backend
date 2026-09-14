import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  guardedTick,
  runningGuardedTicks,
  waitForGuardedTicksIdle,
} from "./guarded-tick.js";

/**
 * Let the tick's own promise chain settle.
 *
 * Counting microtasks by hand used to work and stopped the moment the chain
 * grew a health step — which is exactly the kind of coupling a test should not
 * have to a private implementation detail. A macrotask boundary is true
 * whatever the chain looks like.
 */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("guardedTick", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips a tick while the previous run is still in flight", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const task = vi.fn().mockReturnValue(gate);

    const cb = guardedTick("test", task);
    cb(); // starts the (pending) first run
    cb(); // should be skipped — first run not done yet

    expect(task).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('"test" still in flight'),
    );

    // Let the first run finish; a subsequent tick runs again.
    resolve();
    await gate;
    await settle();
    cb();
    expect(task).toHaveBeenCalledTimes(2);
  });

  it("clears the in-flight flag even when the task rejects", async () => {
    const task = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    const cb = guardedTick("test", task);
    cb();
    await settle();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"test" tick failed:'),
      expect.any(Error),
    );

    cb(); // flag must have been cleared in finally
    expect(task).toHaveBeenCalledTimes(2);
  });

  // A13-M21: shutdown waits for running ticks instead of killing a drop or a
  // payment sweep mid-row, so the registry has to know what is still running.
  it("lets a shutdown wait for the ticks still in flight", async () => {
    let resolve!: () => void;
    const gate = new Promise<void>((r) => {
      resolve = r;
    });
    const cb = guardedTick("drain-probe", () => gate);

    cb();
    expect(runningGuardedTicks()).toContain("drain-probe");
    await expect(waitForGuardedTicksIdle(10)).resolves.toBe(false);

    const idle = waitForGuardedTicksIdle(1000);
    resolve();
    await expect(idle).resolves.toBe(true);
    expect(runningGuardedTicks()).not.toContain("drain-probe");
  });
});
