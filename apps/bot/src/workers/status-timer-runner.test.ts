import { describe, expect, it, vi } from "vitest";
import { createStatusTimerRunner } from "./status-timer-runner.js";

const HEALTHY = {
  eligible: 0,
  tracked: 0,
  created: 0,
  edited: 0,
  repinned: 0,
  removedInactive: 0,
  unchanged: 0,
  transientFailures: 0,
  permanentFailures: 0,
};

describe("createStatusTimerRunner", () => {
  it("alerts once after three failures and announces recovery", async () => {
    const tick = vi
      .fn()
      .mockRejectedValueOnce(new Error("db"))
      .mockRejectedValueOnce(new Error("db"))
      .mockRejectedValueOnce(new Error("db"))
      .mockResolvedValueOnce(HEALTHY);
    const notifyHealth = vi.fn().mockResolvedValue(undefined);
    const runner = createStatusTimerRunner({ tick, notifyHealth, log: vi.fn() });

    await expect(runner()).rejects.toThrow("db");
    await expect(runner()).rejects.toThrow("db");
    await expect(runner()).rejects.toThrow("db");
    expect(notifyHealth).toHaveBeenCalledTimes(1);
    expect(notifyHealth).toHaveBeenLastCalledWith("degraded", 3);

    await expect(runner()).resolves.toBeUndefined();
    expect(notifyHealth).toHaveBeenLastCalledWith("recovered", 3);
  });

  it("emits a heartbeat even when no users are eligible", async () => {
    const log = vi.fn();
    const runner = createStatusTimerRunner({
      tick: vi.fn().mockResolvedValue(HEALTHY),
      notifyHealth: vi.fn(),
      log,
      now: () => new Date("2026-07-21T09:00:00.000Z"),
    });

    await runner();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('"eligible":0'));
  });
});
