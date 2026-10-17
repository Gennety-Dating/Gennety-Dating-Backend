import { describe, expect, it } from "vitest";
import {
  computeDateFunnelRows,
  computeMoneyRows,
  computeOnboardingRows,
  computeOptInRows,
  computeScreenRows,
  dateFunnelStages,
  detectRageClusters,
  isQuickBack,
  percentile,
  type FunnelMatchRow,
  type MetricRow,
  type PulseEventRow,
} from "./rollup-math.js";

const DAY = "2026-10-14";
const DAYS = new Set([DAY, "2026-10-13"]);
let seq = 0;

function ev(
  type: string,
  props: Record<string, unknown>,
  at: string,
  installId = "i1",
  platform = "ios",
): PulseEventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: null,
    installId,
    type,
    props,
    occurredAt: new Date(at),
    platform,
    screen: typeof props["screen"] === "string" ? (props["screen"] as string) : null,
    appVersion: "1.0",
  };
}

function row(rows: MetricRow[], metric: string, dim: string, day = DAY): MetricRow | undefined {
  return rows.find((r) => r.metric === metric && r.dim === dim && r.day === day);
}

describe("percentile", () => {
  it("interpolates like percentile_cont", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([10], 0.9)).toBe(10);
    expect(percentile([], 0.5)).toBeNull();
  });
});

describe("quick back", () => {
  it("is exit=back under 2 s only", () => {
    expect(isQuickBack("back", 1999)).toBe(true);
    expect(isQuickBack("back", 2000)).toBe(false);
    expect(isQuickBack("next", 500)).toBe(false);
    expect(isQuickBack("back", null)).toBe(false);
  });
});

describe("rage clusters", () => {
  const t = (ms: number, x: number, y: number, installId = "i1", screen = "city") => ({
    installId,
    screen,
    at: new Date(Date.UTC(2026, 9, 14, 10, 0, 0, ms)),
    x,
    y,
  });

  it("three close taps within a second are one rage", () => {
    expect(detectRageClusters([t(0, 0.5, 0.5), t(300, 0.52, 0.5), t(700, 0.5, 0.53)])).toHaveLength(1);
  });

  it("a five-tap burst is still ONE rage, not overlapping ones", () => {
    const burst = [0, 100, 200, 300, 400].map((ms) => t(ms, 0.5, 0.5));
    const clusters = detectRageClusters(burst);
    expect(clusters).toHaveLength(1);
    expect(clusters[0]!.points).toHaveLength(5);
  });

  it("spread-out, slow, or different-install taps are not rage", () => {
    expect(detectRageClusters([t(0, 0.1, 0.1), t(200, 0.5, 0.5), t(400, 0.9, 0.9)])).toHaveLength(0);
    expect(detectRageClusters([t(0, 0.5, 0.5), t(600, 0.5, 0.5), t(1200, 0.5, 0.5)])).toHaveLength(0);
    expect(
      detectRageClusters([t(0, 0.5, 0.5, "a"), t(100, 0.5, 0.5, "b"), t(200, 0.5, 0.5, "c")]),
    ).toHaveLength(0);
  });
});

describe("screen rows", () => {
  it("counts views, viewers, dwell percentiles, quick backs, exits, dead and rage taps", () => {
    const events = [
      ev("screen_view", { screen: "city" }, `${DAY}T10:00:00Z`, "i1"),
      ev("screen_view", { screen: "city" }, `${DAY}T10:05:00Z`, "i1"),
      ev("screen_view", { screen: "city" }, `${DAY}T11:00:00Z`, "i2"),
      ev("screen_left", { screen: "city", exit: "back", dwell_ms: 1200, first_action_ms: 800 }, `${DAY}T10:00:01Z`, "i1"),
      ev("screen_left", { screen: "city", exit: "next", dwell_ms: 5000, first_action_ms: 2000 }, `${DAY}T10:05:05Z`, "i1"),
      ev("screen_left", { screen: "city", exit: "background", dwell_ms: 9000 }, `${DAY}T11:00:09Z`, "i2"),
      ev("dead_tap", { screen: "city", x: 0.5, y: 0.5 }, `${DAY}T11:00:01.000Z`, "i2"),
      ev("dead_tap", { screen: "city", x: 0.51, y: 0.5 }, `${DAY}T11:00:01.300Z`, "i2"),
      ev("tap", { screen: "city", element: "next", x: 0.5, y: 0.52 }, `${DAY}T11:00:01.600Z`, "i2"),
    ];
    const rows = computeScreenRows(events, DAYS);
    expect(row(rows, "screen_views", "city")).toMatchObject({ value: 3, n: 3 });
    expect(row(rows, "screen_viewers", "city")?.value).toBe(2);
    expect(row(rows, "screen_left", "city")?.value).toBe(3);
    expect(row(rows, "screen_dwell_p50", "city")).toMatchObject({ value: 5000, n: 3 });
    expect(row(rows, "screen_dwell_p90", "city")?.value).toBe(8200);
    expect(row(rows, "screen_exit_back_fast", "city")).toMatchObject({ value: 1, n: 3 });
    expect(row(rows, "screen_exit_background", "city")?.value).toBe(1);
    expect(row(rows, "screen_dead_taps", "city")?.value).toBe(2);
    expect(row(rows, "screen_taps", "city")?.value).toBe(1);
    expect(row(rows, "screen_rage_taps", "city")?.value).toBe(1);
    expect(row(rows, "screen_first_action_p50", "city")).toMatchObject({ value: 1400, n: 2 });
  });

  it("ignores days outside the window", () => {
    const rows = computeScreenRows([ev("screen_view", { screen: "city" }, "2026-09-01T10:00:00Z")], DAYS);
    expect(rows).toHaveLength(0);
  });

  it("item_seen counts installs that saw ≥1 s over installs that opened the screen", () => {
    const events = [
      ev("screen_view", { screen: "today_pitch" }, `${DAY}T10:00:00Z`, "a"),
      ev("screen_view", { screen: "today_pitch" }, `${DAY}T10:00:00Z`, "b"),
      ev("screen_view", { screen: "today_pitch" }, `${DAY}T10:00:00Z`, "c"),
      ev("seen", { screen: "today_pitch", item: "synergy", visible_ms: 1500 }, `${DAY}T10:00:05Z`, "a"),
      ev("seen", { screen: "today_pitch", item: "synergy", visible_ms: 400 }, `${DAY}T10:00:05Z`, "b"),
    ];
    expect(row(computeScreenRows(events, DAYS), "item_seen", "today_pitch:synergy")).toMatchObject({ value: 1, n: 3 });
  });
});

describe("onboarding rows", () => {
  it("counts a person once per step, on the day they FIRST reached it", () => {
    const events = [
      ev("screen_view", { screen: "city" }, "2026-10-13T10:00:00Z", "i1"),
      ev("screen_view", { screen: "city" }, "2026-10-14T10:00:00Z", "i1"),
      ev("screen_view", { screen: "city" }, "2026-10-14T10:00:00Z", "i2"),
      ev("screen_view", { screen: "push_prompt" }, "2026-10-14T11:00:00Z", "i2"),
      // a Mini App screen key coming from iOS is not the iOS funnel
      ev("screen_view", { screen: "mini_onb_city" }, "2026-10-14T11:00:00Z", "i3", "ios"),
    ];
    const rows = computeOnboardingRows(events, [], ["first_name_age", "photos"], DAYS);
    expect(row(rows, "onboarding_step_reached", "ios:city", "2026-10-13")?.value).toBe(1);
    expect(row(rows, "onboarding_step_reached", "ios:city", "2026-10-14")?.value).toBe(1);
    expect(row(rows, "onboarding_completed", "ios")?.value).toBe(1);
    expect(rows.some((r) => r.dim.startsWith("miniapp:"))).toBe(false);
  });

  it("server tracks: bot vs ios_server, completion = resolving the last step", () => {
    const steps = [
      { userId: "u1", step: "first_name_age", kind: "asked", platform: "telegram", createdAt: new Date(`${DAY}T09:00:00Z`) },
      { userId: "u1", step: "photos", kind: "asked", platform: "telegram", createdAt: new Date(`${DAY}T09:10:00Z`) },
      { userId: "u1", step: "photos", kind: "skipped", platform: "telegram", createdAt: new Date(`${DAY}T09:11:00Z`) },
      { userId: "u2", step: "first_name_age", kind: "asked", platform: "mobile", createdAt: new Date(`${DAY}T09:00:00Z`) },
    ];
    const rows = computeOnboardingRows([], steps, ["first_name_age", "photos"], DAYS);
    expect(row(rows, "onboarding_step_reached", "bot:photos")?.value).toBe(1);
    expect(row(rows, "onboarding_step_reached", "ios_server:first_name_age")?.value).toBe(1);
    expect(row(rows, "onboarding_completed", "bot")?.value).toBe(1);
    expect(row(rows, "onboarding_completed", "ios_server")).toBeUndefined();
  });
});

describe("date funnel", () => {
  const base: FunnelMatchRow = {
    id: "m",
    createdAt: new Date(`${DAY}T18:00:00Z`),
    status: "proposed",
    dispatchedAt: new Date(`${DAY}T18:01:00Z`),
    acceptedByA: null,
    acceptedByB: null,
    ticketStatus: "pending",
    agreedTime: null,
    venueName: null,
    feedbackByA: null,
    feedbackByB: null,
    eventTypes: [],
  };

  it("stages read stored columns", () => {
    expect([...dateFunnelStages(base)]).toEqual(["shown"]);
    const full = dateFunnelStages({
      ...base,
      status: "completed",
      acceptedByA: true,
      acceptedByB: true,
      ticketStatus: "completed",
      agreedTime: new Date(),
      venueName: "X",
      feedbackByA: "great",
    });
    expect(full.size).toBe(8);
    // free-opened gate: no ticket_paid, still time agreed
    const free = dateFunnelStages({ ...base, acceptedByA: true, acceptedByB: true, ticketStatus: "expired", agreedTime: new Date() });
    expect(free.has("ticket_paid")).toBe(false);
    expect(free.has("time_agreed")).toBe(true);
  });

  it("cohorts by creation day with n = pairs that day", () => {
    const rows = computeDateFunnelRows(
      [base, { ...base, id: "m2", acceptedByA: true }, { ...base, id: "m3", dispatchedAt: null }],
      DAYS,
    );
    expect(row(rows, "date_funnel", "shown")).toMatchObject({ value: 2, n: 3 });
    expect(row(rows, "date_funnel", "accepted")).toMatchObject({ value: 1, n: 3 });
    expect(row(rows, "date_funnel", "feedback")).toMatchObject({ value: 0, n: 3 });
  });
});

describe("money and consent", () => {
  it("money rows per kind:surface with dismissed over shown", () => {
    const rows = computeMoneyRows(
      [
        ev("paywall_shown", { surface: "today" }, `${DAY}T10:00:00Z`),
        ev("paywall_shown", { surface: "today" }, `${DAY}T11:00:00Z`),
        ev("paywall_dismissed", { surface: "today" }, `${DAY}T11:00:05Z`),
        ev("ticket_gate_shown", {}, `${DAY}T12:00:00Z`),
      ],
      DAYS,
    );
    expect(row(rows, "money_shown", "paywall:today")?.value).toBe(2);
    expect(row(rows, "money_dismissed", "paywall:today")).toMatchObject({ value: 1, n: 2 });
    expect(row(rows, "money_shown", "ticket_gate:unknown")?.value).toBe(1);
  });

  it("opt-in share per end of day", () => {
    const rows = computeOptInRows(
      [
        { createdAt: new Date("2026-10-01T00:00:00Z"), analyticsOptIn: true, analyticsOptInAt: new Date("2026-10-14T10:00:00Z") },
        { createdAt: new Date("2026-10-01T00:00:00Z"), analyticsOptIn: false, analyticsOptInAt: null },
        { createdAt: new Date("2026-10-14T05:00:00Z"), analyticsOptIn: true, analyticsOptInAt: new Date("2026-10-14T05:00:00Z") },
      ],
      ["2026-10-13", "2026-10-14"],
    );
    expect(rows.find((r) => r.day === "2026-10-13")).toMatchObject({ value: 0, n: 2 });
    expect(rows.find((r) => r.day === "2026-10-14")).toMatchObject({ value: 0.6667, n: 3 });
  });
});
