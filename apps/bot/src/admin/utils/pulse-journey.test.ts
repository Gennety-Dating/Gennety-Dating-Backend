import { describe, expect, it } from "vitest";
import { buildJourneyItems } from "./pulse-journey.js";
import type { PulseEventRow } from "../../services/pulse/rollup-math.js";

let seq = 0;
function ev(type: string, props: Record<string, unknown>, at: string): PulseEventRow {
  seq += 1;
  return {
    id: `e${seq}`,
    userId: "u1",
    installId: "i1",
    type,
    props,
    occurredAt: new Date(at),
    platform: "ios",
    screen: typeof props["screen"] === "string" ? (props["screen"] as string) : null,
    appVersion: "1.0",
  };
}

const T = (s: string) => `2026-10-14T10:${s}Z`;

describe("buildJourneyItems", () => {
  const src = {
    events: [
      ev("screen_view", { screen: "city" }, T("00:00")),
      ev("tap", { screen: "city", element: "kyiv", x: 0.5, y: 0.5 }, T("00:01.000")),
      ev("dead_tap", { screen: "city", x: 0.51, y: 0.5 }, T("00:01.200")),
      ev("dead_tap", { screen: "city", x: 0.5, y: 0.51 }, T("00:01.400")),
      ev("screen_left", { screen: "city", exit: "back", dwell_ms: 95_000 }, T("01:35")),
      ev("seen", { screen: "today_pitch", item: "synergy", visible_ms: 1200 }, T("02:00")),
      ev("paywall_shown", { surface: "today" }, T("03:00")),
    ],
    steps: [
      { step: "gender", kind: "asked", createdAt: new Date(T("00:30")) },
      { step: "gender", kind: "answered", createdAt: new Date(T("00:40")) },
    ],
    matchEvents: [{ actionType: "PROPOSAL_SHOWN", createdAt: new Date(T("05:00")) }],
    signupAt: new Date("2026-10-14T09:00:00Z"),
    verifiedAt: null,
  };

  it("one item per screen visit with dwell, one per tap run, milestones in order", () => {
    const { items, truncated } = buildJourneyItems(src);
    expect(truncated).toBe(false);
    expect(items.map((i) => i.kind)).toEqual([
      "server_milestone", // signup
      "screen",
      "tap_cluster",
      "server_milestone", // gender answered
      "server_milestone", // paywall shown
      "server_milestone", // pair shown
    ]);
    const visit = items[1]!;
    expect(visit).toMatchObject({ screen: "city", dwellMs: 95_000 });
    expect(visit.label).toBe("Город — 2 мин, выход: back");
    expect(items[2]!.label).toBe("3 касания, по kyiv, мимо: 2, ярость: 1");
    expect(items[3]!.label).toBe("Анкета: gender — ответ");
    expect(items[4]!.label).toBe("Показан пейвол (today)");
    expect(items[5]!.label).toBe("Показана пара");
  });

  it("keeps the LATEST items when capped", () => {
    const { items, truncated } = buildJourneyItems(src, 2);
    expect(truncated).toBe(true);
    expect(items.map((i) => i.label)).toEqual(["Показан пейвол (today)", "Показана пара"]);
  });

  it("never carries anything but templates over keys", () => {
    const json = JSON.stringify(buildJourneyItems(src).items);
    expect(json).not.toMatch(/firstName|telegram|phone|@/);
  });
});
