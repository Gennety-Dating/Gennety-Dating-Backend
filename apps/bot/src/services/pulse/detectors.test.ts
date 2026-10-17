import { describe, expect, it } from "vitest";
import {
  checkAnomaly,
  detectAnomalies,
  detectFunnelDrops,
  detectScreenFriction,
  detectSlowDecisions,
  detectStuckPeople,
  detectUnseen,
  frictionScore,
  funnelTransitions,
  plural,
  runDetectors,
  shareText,
  shiftDay,
  weightedMedian,
} from "./detectors.js";
import type { MetricRow } from "./rollup-math.js";
import type { PulseMetricName } from "./metrics-catalog.js";

const AS_OF = "2026-10-14"; // a Wednesday
const r = (day: string, metric: PulseMetricName, dim: string, value: number, n = value): MetricRow => ({
  day,
  metric,
  dim,
  value,
  n,
});
/** `count` consecutive days ending `endOffset` days before AS_OF. */
const days = (count: number, endOffset = 0) =>
  Array.from({ length: count }, (_, i) => shiftDay(AS_OF, -(endOffset + i)));

describe("templates and small-sample rule", () => {
  it("Russian plurals", () => {
    expect([1, 2, 5, 11, 21, 22, 25].map((n) => plural(n, "человек", "человека", "человек"))).toEqual([
      "человек",
      "человека",
      "человек",
      "человек",
      "человек",
      "человека",
      "человек",
    ]);
  });

  it("under 30 a share is absolute numbers, never a percentage", () => {
    expect(shareText(6, 11)).toBe("6 из 11");
    expect(shareText(15, 30)).toBe("50% (15 из 30)");
  });

  it("weighted median ignores empty days", () => {
    expect(weightedMedian([{ value: 100, n: 1 }, { value: 5000, n: 10 }, { value: 9, n: 0 }])).toBe(5000);
    expect(weightedMedian([])).toBeNull();
  });
});

describe("stuck_people", () => {
  it("groups by where they stopped, with ids and a code hint", () => {
    const since = new Date("2026-10-10T00:00:00Z");
    const drafts = detectStuckPeople([
      { userId: "u1", phase: "onboarding", where: "city", lastMovementAt: since },
      { userId: "u2", phase: "onboarding", where: "city", lastMovementAt: new Date("2026-10-09T00:00:00Z") },
      { userId: "u3", phase: "date", where: "match:negotiating", lastMovementAt: since },
    ]);
    const city = drafts.find((d) => d.key === "stuck_people:city")!;
    expect(city.title).toBe("2 человека без движения больше 48 ч: «Город»");
    expect(city.smallSample).toBe(true);
    expect(city.severity).toBe(2);
    expect(city.codeHint).toContain("CityView.swift");
    expect(city.evidence["userIds"]).toEqual(["u2", "u1"]);
    expect(drafts.find((d) => d.key === "stuck_people:match:negotiating")!.codeHint).toBeNull();
  });
});

describe("funnel_drop", () => {
  it("bypassable stage (free-opened ticket gate) is compared through, not reported as 100% loss", () => {
    const t = funnelTransitions([
      { step: "mutual", count: 10 },
      { step: "ticket_paid", count: 0 },
      { step: "time_agreed", count: 8 },
    ]);
    expect(t).toEqual([{ from: "mutual", to: "time_agreed", entered: 10, passed: 8, loss: 0.2 }]);
  });

  it("reports the worst step of the week in absolute numbers under n=30, with the baseline", () => {
    const rows: MetricRow[] = [];
    // this week: city 11 → interview_basics 6 (loss 5/11); consent 12 → city 11
    for (const [step, count] of [
      ["consent", 12],
      ["city", 11],
      ["interview_basics", 6],
      ["interview_chat", 6],
      ["photos", 6],
      ["verification", 6],
      ["push_prompt", 6],
    ] as const) {
      rows.push(r(AS_OF, "onboarding_step_reached", `ios:${step}`, count));
    }
    // baseline: city 20 → basics 18
    rows.push(r(shiftDay(AS_OF, -10), "onboarding_step_reached", "ios:city", 20));
    rows.push(r(shiftDay(AS_OF, -10), "onboarding_step_reached", "ios:interview_basics", 18));
    rows.push(r(shiftDay(AS_OF, -10), "onboarding_step_reached", "ios:consent", 21));

    const d = detectFunnelDrops(rows, AS_OF, ["first_name_age"]).find((x) => x.scope.startsWith("onboarding_ios"))!;
    expect(d.key).toBe("funnel_drop:onboarding_ios:city");
    expect(d.title).toBe(
      "Онбординг iOS: после «Город» до «Анкета: основное» дошли 6 из 11 за 7 дней; за 4 недели до этого — 18 из 20",
    );
    expect(d.title).not.toContain("%");
    expect(d.smallSample).toBe(true);
    expect(d.severity).toBe(3); // 0.45 vs 0.10 baseline
    expect(d.codeHint).toContain("CityView.swift");
  });

  it("date funnel blames the screen of the stage not reached", () => {
    const rows = [
      r(AS_OF, "date_funnel", "shown", 10, 10),
      r(AS_OF, "date_funnel", "accepted", 3, 10),
    ];
    const d = detectFunnelDrops(rows, AS_OF, []).find((x) => x.scope.startsWith("date"))!;
    expect(d.scope).toBe("date:shown");
    expect(d.codeHint).toContain("PitchView.swift");
  });

  it("stays silent below the minimum entering the step", () => {
    const rows = [r(AS_OF, "date_funnel", "shown", 3, 3), r(AS_OF, "date_funnel", "accepted", 0, 3)];
    expect(detectFunnelDrops(rows, AS_OF, [])).toHaveLength(0);
  });
});

describe("screen_friction", () => {
  it("formula: weights × per-100-views", () => {
    // rage 2, dead 4, qb 2, exit 2 on 20 views → 0.35·10 + 0.25·20 + 0.2·10 + 0.2·10 = 12.5
    expect(frictionScore({ views: 20, rageTaps: 2, deadTaps: 4, quickBack: 2, background: 2 })).toBe(12.5);
    expect(frictionScore({ views: 0, rageTaps: 1, deadTaps: 0, quickBack: 0, background: 0 })).toBeNull();
  });

  it("flags screens over the threshold, titles in counts under n=30", () => {
    const rows = [
      r(AS_OF, "screen_views", "paywall", 20),
      r(AS_OF, "screen_rage_taps", "paywall", 2, 20),
      r(AS_OF, "screen_dead_taps", "paywall", 4, 20),
      r(AS_OF, "screen_exit_back_fast", "paywall", 2, 20),
      r(AS_OF, "screen_exit_background", "paywall", 2, 20),
      r(AS_OF, "screen_views", "map", 40),
    ];
    const drafts = detectScreenFriction(rows, AS_OF);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.key).toBe("screen_friction:paywall");
    expect(drafts[0]!.value).toBe(12.5);
    expect(drafts[0]!.title).toBe(
      "«Пейвол»: 2 вспышки ярости, 4 касания мимо, 2 быстрых ухода назад, 2 сворачивания на 20 показов за 7 дней",
    );
  });
});

describe("slow_decision", () => {
  it("compares the week's median with the screen's own previous 4 weeks", () => {
    const rows = [
      r(AS_OF, "screen_first_action_p50", "today_pitch", 9000, 6),
      ...days(5, 10).map((d) => r(d, "screen_first_action_p50", "today_pitch", 3000, 2)),
    ];
    const [d] = detectSlowDecisions(rows, AS_OF);
    expect(d).toBeDefined();
    expect(d!.baseline).toBe(3000);
    expect(d!.title).toContain("в 3,0 раза дольше обычного для этого экрана");
  });

  it("no finding under the factor", () => {
    const rows = [
      r(AS_OF, "screen_first_action_p50", "today_pitch", 5000, 6),
      ...days(5, 10).map((d) => r(d, "screen_first_action_p50", "today_pitch", 3000, 2)),
    ];
    expect(detectSlowDecisions(rows, AS_OF)).toHaveLength(0);
  });
});

describe("anomaly", () => {
  it("median ± 3·MAD with a floor of one unit", () => {
    const base = days(14, 1).map((day) => ({ day, value: 2 }));
    expect(checkAnomaly(4, base, AS_OF)!.outside).toBe(false); // 2 ± 3
    expect(checkAnomaly(6, base, AS_OF)!.outside).toBe(true);
    expect(checkAnomaly(6, base.slice(0, 5), AS_OF)).toBeNull(); // too few points
  });

  it("prefers the same weekday when there are enough of them", () => {
    // Wednesdays are busy (20), other days quiet (2).
    const base = days(28, 1).map((day) => ({
      day,
      value: new Date(`${day}T00:00:00Z`).getUTCDay() === 3 ? 20 : 2,
    }));
    const c = checkAnomaly(20, base, AS_OF)!;
    expect(c.sameWeekday).toBe(true);
    expect(c.outside).toBe(false);
  });

  it("flags a watched daily metric and leaves unwatched ones alone", () => {
    const rows = [
      ...days(14, 1).map((d) => r(d, "signups", "telegram", 3)),
      r(AS_OF, "signups", "telegram", 30),
      ...days(14, 1).map((d) => r(d, "screen_dwell_p50", "city", 1000)),
      r(AS_OF, "screen_dwell_p50", "city", 90_000),
    ];
    const drafts = detectAnomalies(rows, AS_OF);
    expect(drafts.map((d) => d.key)).toEqual(["anomaly:signups:telegram"]);
    expect(drafts[0]!.severity).toBe(3);
    expect(drafts[0]!.title).toBe("Регистрации (telegram): 30 за 2026-10-14 при обычных 0–6");
  });

  it("a series younger than the baseline window is not compared against its own absence", () => {
    const rows = [r(AS_OF, "signups", "mobile", 5)];
    expect(detectAnomalies(rows, AS_OF)).toHaveLength(0);
  });
});

describe("unseen", () => {
  it("flags a block seen ≥1 s by at most 30% of viewers", () => {
    const rows = [r(AS_OF, "item_seen", "today_pitch:synergy", 2, 10), r(AS_OF, "item_seen", "today_pitch:photo", 8, 10)];
    const drafts = detectUnseen(rows, AS_OF);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]!.title).toBe(
      "Блок «synergy» на «Питч пары» дольше секунды увидели 2 из 10 открывших экран за 7 дней",
    );
  });
});

describe("runDetectors", () => {
  it("keys are unique and every draft has a title", () => {
    const drafts = runDetectors({
      rows: [r(AS_OF, "date_funnel", "shown", 10, 10), r(AS_OF, "date_funnel", "accepted", 2, 10)],
      asOf: AS_OF,
      stuck: [{ userId: "u", phase: "date", where: "today_pitch", lastMovementAt: new Date() }],
      serverSteps: [],
    });
    expect(new Set(drafts.map((d) => d.key)).size).toBe(drafts.length);
    expect(drafts.every((d) => d.title.length > 0)).toBe(true);
  });
});
