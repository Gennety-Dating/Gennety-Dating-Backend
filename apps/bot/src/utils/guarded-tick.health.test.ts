import { describe, it, expect, vi } from "vitest";
import { guardedTick } from "./guarded-tick.js";

/**
 * Before this, exactly one worker in the product told anyone when it broke.
 * Twenty-five others — matching, payment sweeps, verification, refunds,
 * retention — failed into `console.error` on a droplet nobody watches, so a
 * subsystem could be down for days and the first signal would be a person
 * asking why nothing happened.
 */

/** Let the tick's own promise chain settle. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("guardedTick health", () => {
  it("stays quiet about a single bad tick", async () => {
    const notifyHealth = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tick = guardedTick("payments", async () => {
      throw new Error("blip");
    }, { notifyHealth });

    tick();
    await settle();

    // One failure is an entry in the log, not an outage.
    expect(notifyHealth).not.toHaveBeenCalled();
  });

  it("says a job is broken after three failures in a row", async () => {
    const notifyHealth = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const tick = guardedTick("payments", async () => {
      throw new Error("still broken");
    }, { notifyHealth });

    for (let i = 0; i < 4; i += 1) {
      tick();
      await settle();
    }

    // Announced once — the fourth failure is the same outage, not a new one.
    expect(notifyHealth).toHaveBeenCalledTimes(1);
    expect(notifyHealth).toHaveBeenCalledWith("payments", "degraded", 3);
  });

  it("says when it comes back", async () => {
    const notifyHealth = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    const tick = guardedTick("matching", async () => {
      if (broken) throw new Error("down");
    }, { notifyHealth });

    for (let i = 0; i < 3; i += 1) {
      tick();
      await settle();
    }
    broken = false;
    tick();
    await settle();

    expect(notifyHealth).toHaveBeenNthCalledWith(2, "matching", "recovered", 3);
  });

  it("does not announce a recovery nobody was told to worry about", async () => {
    const notifyHealth = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(console, "error").mockImplementation(() => {});
    let broken = true;
    const tick = guardedTick("retention", async () => {
      if (broken) throw new Error("down");
    }, { notifyHealth });

    tick();
    await settle();
    broken = false;
    tick();
    await settle();

    expect(notifyHealth).not.toHaveBeenCalled();
  });

  it("never lets a broken notifier become the failure it was reporting", async () => {
    const notifyHealth = vi.fn().mockRejectedValue(new Error("telegram down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const tick = guardedTick("verification", async () => {
      throw new Error("down");
    }, { notifyHealth });

    for (let i = 0; i < 3; i += 1) {
      tick();
      await settle();
    }

    // Reached, and swallowed: a broken notifier must not mask every broken job.
    expect(notifyHealth).toHaveBeenCalled();
  });
});
