import { describe, it, expect, vi } from "vitest";

vi.mock("../services/campus-radar.js", () => ({ campusRadarTick: vi.fn() }));

import { campusRadarTick } from "../services/campus-radar.js";
import { campusDropTick } from "./campus-drop.js";

const radar = campusRadarTick as unknown as ReturnType<typeof vi.fn>;

describe("campusDropTick", () => {
  // A13-M24: the tick used to log and swallow, so `guardedTick` counted every
  // failure as a success and its alert could never fire for this job.
  it("rethrows after logging, so guardedTick can see the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    radar.mockRejectedValueOnce(new Error("allocator down"));

    await expect(campusDropTick()).rejects.toThrow("allocator down");
    expect(error).toHaveBeenCalledWith("[campus-drop] tick failed:", expect.any(Error));
    error.mockRestore();
  });

  it("stays quiet on an ordinary tick", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    radar.mockResolvedValueOnce({ scanned: 3, dropped: [], matchIds: [] });

    await expect(campusDropTick()).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
  });
});
