import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The tick and the orchestration in `services/pulse/rollup.ts`: which window
 * is loaded, that the window is rewritten whole, and that detectors run over
 * exactly the rows that were written. Sources are mocked; the arithmetic has
 * its own fixtures in `services/pulse/*.test.ts`.
 */

const h = vi.hoisted(() => ({
  loadExcludedUserIds: vi.fn(),
  loadClientEvents: vi.fn(),
  loadStepEvents: vi.fn(),
  loadActivityDays: vi.fn(),
  loadSignups: vi.fn(),
  loadFunnelMatches: vi.fn(),
  loadOptInUsers: vi.fn(),
  loadStuckPeople: vi.fn(),
  replaceMetricDays: vi.fn(),
  writeInsights: vi.fn(),
}));

vi.mock("../services/pulse/source.js", () => h);
// The collector drags the whole onboarding stack (OpenAI, config) along; the
// rollup only needs its question list.
vi.mock("../services/onboarding-collector.js", () => ({
  ONBOARDING_QUESTIONS: ["first_name_age", "gender", "photos", "complete"],
}));

const { pulseRollupTick, formatPulseRollupLog } = await import("./pulse-rollup.js");

const NOW = new Date("2026-10-15T01:10:00.000Z");

function view(installId: string, screen: string, at: string, extra: Record<string, unknown> = {}) {
  return {
    id: `${installId}-${screen}-${at}`,
    userId: null,
    installId,
    type: "screen_view",
    props: { screen, ...extra },
    occurredAt: new Date(at),
    platform: "ios",
    screen,
    appVersion: "1.0",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadExcludedUserIds.mockResolvedValue(new Set());
  h.loadClientEvents.mockResolvedValue({ rows: [], truncated: false });
  h.loadStepEvents.mockResolvedValue([]);
  h.loadActivityDays.mockResolvedValue([]);
  h.loadSignups.mockResolvedValue([]);
  h.loadFunnelMatches.mockResolvedValue([]);
  h.loadOptInUsers.mockResolvedValue([]);
  h.loadStuckPeople.mockResolvedValue([]);
  h.replaceMetricDays.mockImplementation((_f: string, _t: string, rows: unknown[]) =>
    Promise.resolve(rows.length),
  );
  h.writeInsights.mockImplementation((drafts: unknown[]) =>
    Promise.resolve({ upserted: drafts.length, resolved: 0 }),
  );
});

describe("pulseRollupTick", () => {
  it("does nothing when disabled", async () => {
    const r = await pulseRollupTick(NOW, { enabled: false });
    expect(r).toEqual({ skipped: true });
    expect(h.loadClientEvents).not.toHaveBeenCalled();
    expect(formatPulseRollupLog(r)).toContain("skipped");
  });

  it("loads and rewrites the trailing 35 UTC days including today, judges yesterday", async () => {
    const r = await pulseRollupTick(NOW);
    expect(r).toMatchObject({ from: "2026-09-11", to: "2026-10-15", asOf: "2026-10-14" });
    const [from, to] = h.loadClientEvents.mock.calls[0]!;
    expect((from as Date).toISOString()).toBe("2026-09-11T00:00:00.000Z");
    // Exclusive upper bound: the end of today.
    expect((to as Date).toISOString()).toBe("2026-10-16T00:00:00.000Z");
    expect(h.replaceMetricDays).toHaveBeenCalledWith("2026-09-11", "2026-10-15", [], expect.any(Date));
  });

  it("writes metric rows and passes stuck people to the detectors", async () => {
    h.loadClientEvents.mockResolvedValue({
      rows: [view("i1", "city", "2026-10-14T10:00:00Z"), view("i2", "city", "2026-10-14T11:00:00Z")],
      truncated: false,
    });
    h.loadStuckPeople.mockResolvedValue([
      { userId: "u1", phase: "onboarding", where: "city", lastMovementAt: new Date("2026-10-10T00:00:00Z") },
    ]);

    const r = await pulseRollupTick(NOW);
    if ("skipped" in r && r.skipped) throw new Error("unexpected skip");

    const rows = h.replaceMetricDays.mock.calls[0]![2] as Array<{ metric: string; dim: string; value: number }>;
    expect(rows).toContainEqual(expect.objectContaining({ metric: "screen_views", dim: "city", value: 2 }));
    const drafts = h.writeInsights.mock.calls[0]![0] as Array<{ key: string; title: string }>;
    expect(drafts.map((d) => d.key)).toContain("stuck_people:city");
    expect(r.stuck).toBe(1);
    expect(formatPulseRollupLog(r)).toMatch(/events=2 .*insights=/);
  });

  it("surfaces a truncated event load in the log", async () => {
    h.loadClientEvents.mockResolvedValue({ rows: [], truncated: true });
    const r = await pulseRollupTick(NOW);
    expect(formatPulseRollupLog(r)).toContain("TRUNCATED");
  });
});
