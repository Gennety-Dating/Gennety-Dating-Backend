import { describe, expect, it, vi } from "vitest";
import { runVenueFinalizationOnce } from "./venue-finalization-flight.js";

describe("runVenueFinalizationOnce", () => {
  it("coalesces concurrent work for the same match", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finalize = vi.fn(async () => gate);

    const first = runVenueFinalizationOnce("match-1", finalize);
    const second = runVenueFinalizationOnce("match-1", finalize);
    release();
    await Promise.all([first, second]);

    expect(finalize).toHaveBeenCalledOnce();
  });

  it("allows a later retry after the active run settles", async () => {
    const finalize = vi.fn().mockResolvedValue(undefined);

    await runVenueFinalizationOnce("match-2", finalize);
    await runVenueFinalizationOnce("match-2", finalize);

    expect(finalize).toHaveBeenCalledTimes(2);
  });
});
