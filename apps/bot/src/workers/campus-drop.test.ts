import { describe, it, expect, vi } from "vitest";
import type { Api, RawApi } from "grammy";

vi.mock("../services/campus-radar.js", () => ({ campusRadarTick: vi.fn() }));
vi.mock("../services/dispatch-queue.js", () => ({ dispatchMatches: vi.fn() }));

import { campusRadarTick } from "../services/campus-radar.js";
import { dispatchMatches } from "../services/dispatch-queue.js";
import { campusDropTick } from "./campus-drop.js";

const radar = campusRadarTick as unknown as ReturnType<typeof vi.fn>;
const dispatch = dispatchMatches as unknown as ReturnType<typeof vi.fn>;
const api = {} as Api<RawApi>;

describe("campusDropTick", () => {
  // A13-M24: the tick used to log and swallow, so `guardedTick` counted every
  // failure as a success and its alert could never fire for this job.
  it("rethrows after logging, so guardedTick can see the failure", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    radar.mockRejectedValueOnce(new Error("allocator down"));

    await expect(campusDropTick(api)).rejects.toThrow("allocator down");
    expect(error).toHaveBeenCalledWith("[campus-drop] tick failed:", expect.any(Error));
    error.mockRestore();
  });

  it("stays quiet on an ordinary tick", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    radar.mockResolvedValueOnce({ scanned: 3, dropped: [], matchIds: [] });

    await expect(campusDropTick(api)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    log.mockRestore();
  });

  // B-15: the drop created `proposed` rows and nothing sent their pitches
  // until the stranded sweep took them for a dead dispatch.
  it("dispatches the pitches of the matches it created", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    radar.mockResolvedValueOnce({ scanned: 1, dropped: ["kpi.ua"], matchIds: ["m1", "m2"] });
    dispatch.mockResolvedValueOnce({ dispatched: 2, failed: 0, errors: [], undelivered: [] });

    await campusDropTick(api);

    expect(dispatch).toHaveBeenCalledWith(api, ["m1", "m2"]);
    log.mockRestore();
  });
});
