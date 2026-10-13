import { describe, expect, it, vi } from "vitest";
import { runVenueFinalizationOnce } from "./venue-finalization-flight.js";

describe("runVenueFinalizationOnce", () => {
  it("runs once more after the active run when a request lands mid-run", async () => {
    // Both partners confirm in the same second: A's run has already read the
    // row when B's request arrives, so B must get a fresh read of its own.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = vi.fn(async () => gate);

    const first = runVenueFinalizationOnce("match-1", finalize);
    const second = runVenueFinalizationOnce("match-1", finalize);
    release();
    await Promise.all([first, second]);

    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("collapses any number of mid-run requests into ONE trailing run", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = vi.fn(async () => gate);

    const calls = [
      runVenueFinalizationOnce("match-3", finalize),
      runVenueFinalizationOnce("match-3", finalize),
      runVenueFinalizationOnce("match-3", finalize),
      runVenueFinalizationOnce("match-3", finalize),
    ];
    release();
    await Promise.all(calls);

    expect(finalize).toHaveBeenCalledTimes(2);
  });

  it("the trailing run uses the newest request and still runs after a failure", async () => {
    let fail!: (err: Error) => void;
    const first = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          fail = reject;
        }),
    );
    const latest = vi.fn().mockResolvedValue(undefined);

    const a = runVenueFinalizationOnce("match-4", first);
    const b = runVenueFinalizationOnce("match-4", latest);
    fail(new Error("selector down"));
    await Promise.all([a, b]);

    expect(first).toHaveBeenCalledOnce();
    expect(latest).toHaveBeenCalledOnce();
  });

  it("a failure with nothing queued still reaches the caller", async () => {
    const finalize = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(runVenueFinalizationOnce("match-5", finalize)).rejects.toThrow("boom");
  });

  it("allows a later retry after the active run settles", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);

    await runVenueFinalizationOnce("match-2", finalize);
    await runVenueFinalizationOnce("match-2", finalize);

    expect(finalize).toHaveBeenCalledTimes(2);
  });
});
