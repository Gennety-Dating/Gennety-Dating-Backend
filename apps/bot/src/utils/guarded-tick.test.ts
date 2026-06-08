import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { guardedTick } from "./guarded-tick.js";

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
    await Promise.resolve();
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
    await Promise.resolve();
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('"test" tick failed:'),
      expect.any(Error),
    );

    cb(); // flag must have been cleared in finally
    expect(task).toHaveBeenCalledTimes(2);
  });
});
