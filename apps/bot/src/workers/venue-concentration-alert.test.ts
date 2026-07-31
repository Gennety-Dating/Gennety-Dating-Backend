import { beforeEach, describe, expect, it, vi } from "vitest";

const venueSelectionLog = { findMany: vi.fn() };
vi.mock("@gennety/db", () => ({ prisma: { venueSelectionLog } }));

const notifyFounderVenueConcentration = vi.fn();
vi.mock("../services/founder-notify.js", () => ({ notifyFounderVenueConcentration }));

const envMock = {
  VENUE_CONCENTRATION_ALERT_ENABLED: true,
  FOUNDER_NOTIFY_ENABLED: true,
  VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT: 15,
  VENUE_CONCENTRATION_ALERT_WINDOW_DAYS: 7,
};
vi.mock("../config.js", () => ({ env: envMock }));

const { venueConcentrationAlertTick } = await import("./venue-concentration-alert.js");
const { CONCENTRATION_ROW_LIMIT } = await import("../admin/utils/venue-concentration.js");

function logRow(placeId: string | null, cityKey = "ua:kyiv") {
  return { cityKey, selectedPlaceId: placeId, failureReason: placeId ? null : "provider_unavailable", topCandidates: [] };
}

beforeEach(() => {
  venueSelectionLog.findMany.mockReset().mockResolvedValue([]);
  notifyFounderVenueConcentration.mockReset().mockResolvedValue(undefined);
  envMock.VENUE_CONCENTRATION_ALERT_ENABLED = true;
  envMock.FOUNDER_NOTIFY_ENABLED = true;
  envMock.VENUE_CONCENTRATION_ALERT_THRESHOLD_PCT = 15;
});

describe("venueConcentrationAlertTick", () => {
  it("does nothing when the alert is off", async () => {
    envMock.VENUE_CONCENTRATION_ALERT_ENABLED = false;
    const result = await venueConcentrationAlertTick();
    expect(result.skipped).toBe(true);
    expect(venueSelectionLog.findMany).not.toHaveBeenCalled();
  });

  it("does nothing when the founder feed is off, since that is the only channel", async () => {
    envMock.FOUNDER_NOTIFY_ENABLED = false;
    const result = await venueConcentrationAlertTick();
    expect(result.skipped).toBe(true);
    // The aggregation is not even computed: an alert nobody can receive is
    // pure database load.
    expect(venueSelectionLog.findMany).not.toHaveBeenCalled();
  });

  it("stays silent when the top venue is under the threshold", async () => {
    // 10 venues, one date each → top share 10%, below the 15% threshold.
    venueSelectionLog.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => logRow(`place-${i}`)),
    );
    const result = await venueConcentrationAlertTick();
    expect(result.alerts).toBe(0);
    expect(notifyFounderVenueConcentration).toHaveBeenCalledWith([], 7);
  });

  it("alerts when one venue crosses the threshold", async () => {
    venueSelectionLog.findMany.mockResolvedValue([
      ...Array.from({ length: 5 }, () => logRow("hot-place")),
      ...Array.from({ length: 5 }, (_, i) => logRow(`place-${i}`)),
    ]);
    const result = await venueConcentrationAlertTick();
    expect(result.alerts).toBe(1);
    const [alerts, days] = notifyFounderVenueConcentration.mock.calls[0]!;
    expect(days).toBe(7);
    expect(alerts[0]).toMatchObject({
      cityKey: "ua:kyiv",
      placeId: "hot-place",
      count: 5,
      assignments: 10,
      sharePct: 50,
      uniqueVenues: 6,
    });
  });

  it("carries the sample size so a thin city can be recognised as noise", async () => {
    // Two of three dates in one place is 66%, which crosses every threshold —
    // but at n=3 it is arithmetic, not a defect. The alert must expose the
    // denominator rather than suppress the city (which would blind us exactly
    // when a new market launches).
    venueSelectionLog.findMany.mockResolvedValue([
      logRow("a"), logRow("a"), logRow("b"),
    ]);
    await venueConcentrationAlertTick();
    const [alerts] = notifyFounderVenueConcentration.mock.calls[0]!;
    expect(alerts[0]).toMatchObject({ count: 2, assignments: 3 });
  });

  it("ignores failed runs when computing the share", async () => {
    // 1 assignment + 9 failures must read as 100% of ONE date, not 10%.
    venueSelectionLog.findMany.mockResolvedValue([
      logRow("only-one"),
      ...Array.from({ length: 9 }, () => logRow(null)),
    ]);
    const result = await venueConcentrationAlertTick();
    expect(result.alerts).toBe(1);
    const [alerts] = notifyFounderVenueConcentration.mock.calls[0]!;
    expect(alerts[0]).toMatchObject({ sharePct: 100, assignments: 1 });
  });

  it("reads only live-mode rows inside the window", async () => {
    const now = new Date("2026-08-08T10:00:00.000Z");
    await venueConcentrationAlertTick(now);
    const where = venueSelectionLog.findMany.mock.calls[0]![0].where;
    expect(where.mode).toBe("live");
    expect(where.createdAt.gte).toEqual(new Date("2026-08-01T10:00:00.000Z"));
  });

  it("flags a truncated scan instead of reporting a partial window as complete", async () => {
    // Rows arrive newest-first across every city, so hitting the bound can drop
    // a quiet city entirely and leave the shares computed off a partial
    // denominator. An alarm that can be quietly wrong is worse than none.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    venueSelectionLog.findMany.mockResolvedValue(
      Array.from({ length: CONCENTRATION_ROW_LIMIT }, (_, i) => logRow(`p-${i % 50}`)),
    );
    const result = await venueConcentrationAlertTick();
    expect(result.truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reports an untruncated scan as complete", async () => {
    venueSelectionLog.findMany.mockResolvedValue([logRow("a")]);
    const result = await venueConcentrationAlertTick();
    expect(result.truncated).toBe(false);
  });

  it("alerts per city independently", async () => {
    venueSelectionLog.findMany.mockResolvedValue([
      ...Array.from({ length: 4 }, () => logRow("kyiv-hot", "ua:kyiv")),
      ...Array.from({ length: 10 }, (_, i) => logRow(`lviv-${i}`, "ua:lviv")),
    ]);
    const result = await venueConcentrationAlertTick();
    // Kyiv is a monopoly, Lviv is evenly spread — only Kyiv should fire.
    expect(result.citiesScanned).toBe(2);
    expect(result.alerts).toBe(1);
    const [alerts] = notifyFounderVenueConcentration.mock.calls[0]!;
    expect(alerts[0].cityKey).toBe("ua:kyiv");
  });
});
