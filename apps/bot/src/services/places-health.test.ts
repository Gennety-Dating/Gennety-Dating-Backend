import { beforeEach, describe, expect, it, vi } from "vitest";

const notifyFounderPlacesOutage = vi.hoisted(() => vi.fn());
vi.mock("./founder-notify.js", () => ({ notifyFounderPlacesOutage }));

import { __resetPlacesHealthForTests, reportPlacesHealth } from "./places-health.js";

const night = (failed: number, extra: { scanned?: number; deactivated?: number; lastFailure?: string } = {}) => {
  const scanned = extra.scanned ?? 30;
  const deactivated = extra.deactivated ?? 0;
  return { scanned, deactivated, refreshed: scanned - deactivated - failed, failed, lastFailure: extra.lastFailure };
};

beforeEach(() => {
  notifyFounderPlacesOutage.mockReset().mockResolvedValue(undefined);
  __resetPlacesHealthForTests();
});

describe("reportPlacesHealth", () => {
  it("reports a night in which every place failed, with Google's reason", async () => {
    await reportPlacesHealth(night(30, { lastFailure: "403 PERMISSION_DENIED" }));
    expect(notifyFounderPlacesOutage).toHaveBeenCalledWith("down", { failed: 30, reason: "403 PERMISSION_DENIED" });
  });

  it("repeats on every failed night", async () => {
    await reportPlacesHealth(night(30));
    await reportPlacesHealth(night(30));
    expect(notifyFounderPlacesOutage).toHaveBeenCalledTimes(2);
  });

  it("stays silent on a healthy night, a partial one and one that scanned nothing", async () => {
    await reportPlacesHealth(night(0));
    await reportPlacesHealth(night(29));
    await reportPlacesHealth(night(0, { scanned: 0 }));
    expect(notifyFounderPlacesOutage).not.toHaveBeenCalled();
  });

  it("does not take NOT_FOUND answers for an outage", async () => {
    await reportPlacesHealth(night(0, { deactivated: 30 }));
    expect(notifyFounderPlacesOutage).not.toHaveBeenCalled();
  });

  it("says once that it answers again, and not after a partial night", async () => {
    await reportPlacesHealth(night(30));
    await reportPlacesHealth(night(3));
    await reportPlacesHealth(night(0));
    await reportPlacesHealth(night(0));
    expect(notifyFounderPlacesOutage.mock.calls.map((c) => c[0])).toEqual(["down", "recovered"]);
  });
});
