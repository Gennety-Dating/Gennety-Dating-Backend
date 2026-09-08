import { describe, it, expect } from "vitest";
import {
  BASELINE_WINDOW_DAYS,
  GLOBAL_SCOPE,
  aggregateCohorts,
  aggregateDays,
  calibrateWom,
  cityScope,
  classifySignup,
  computeCohort,
  detectCycleTimeAnomalies,
  detectOrganicAnomalies,
  funnelRate,
  groupActivations,
  median,
  parseScope,
  periodWom,
  ratio,
  scopesOf,
  stats,
  summarizeHdyhau,
  universityScope,
  withOrganicBaseline,
  type ActivationRow,
  type CohortMetrics,
  type DayCounts,
  type FunnelEventRow,
  type HdyhauRow,
  type SignupRow,
} from "./virality.js";
import { dayRange } from "./activity.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");

type SignupInput = Omit<Partial<SignupRow>, "createdAt"> & {
  userId: string;
  /** ISO-строка — читаемее, чем `new Date(...)` в каждом вызове. */
  createdAt: string;
};

function signup(partial: SignupInput): SignupRow {
  return {
    userId: partial.userId,
    createdAt: new Date(partial.createdAt),
    channel: partial.channel ?? "organic",
    referrerId: partial.referrerId ?? null,
    activatedAt: partial.activatedAt ?? null,
    cityKey: partial.cityKey ?? null,
    universityDomain: partial.universityDomain ?? null,
  };
}

/** `n` дней подряд с заданным числом органики и семени. */
function series(organicPerDay: readonly number[], seedPerDay?: readonly number[]): DayCounts[] {
  return organicPerDay.map((organic, i) => {
    const seed = seedPerDay?.[i] ?? 0;
    return {
      day: `2026-05-${String(i + 1).padStart(2, "0")}`,
      signups: organic + seed,
      organicSignups: organic,
      referralSignups: 0,
      seedSignups: seed,
    };
  });
}

// ---------------------------------------------------------------------------

describe("мелкая арифметика", () => {
  it("делит на ноль в null, а не в ноль или Infinity", () => {
    expect(ratio(3, 0)).toBeNull();
    expect(ratio(0, 0)).toBeNull();
    expect(ratio(1, 4)).toBe(0.25);
  });

  it("доля шага воронки не бывает больше единицы — это недосчёт, а не конверсия", () => {
    // Активации восстанавливаются из `referralCountedAt` (существовал всегда),
    // клики — только с появления `referral_events`. У старой когорты
    // знаменатель заведомо неполон, и 2/1 значит «клик не записали», а не
    // «конверсия 200%».
    expect(funnelRate(2, 1)).toBeNull();
    expect(funnelRate(1, 1)).toBe(1);
    expect(funnelRate(1, 4)).toBe(0.25);
    expect(funnelRate(0, 0)).toBeNull();
  });

  it("у пустого ряда нет медианы, а не медиана ноль", () => {
    expect(median([])).toBeNull();
    expect(median([5])).toBe(5);
    expect(median([1, 3])).toBe(2);
    expect(median([9, 1, 5])).toBe(5);
  });

  it("не отдаёт СКО, пока точек меньше трёх", () => {
    expect(stats([]).stdDev).toBeNull();
    expect(stats([4, 6]).stdDev).toBeNull();
    const s = stats([2, 4, 6]);
    expect(s.mean).toBe(4);
    // Выборочное (n−1): sqrt(((−2)²+0+2²)/2) = 2.
    expect(s.stdDev).toBeCloseTo(2, 10);
  });
});

describe("классификация притока", () => {
  it("разводит органику, реферал и размеченное семя", () => {
    expect(classifySignup("organic")).toBe("organic");
    expect(classifySignup("referral")).toBe("referral");
    expect(classifySignup("tg:ig_story")).toBe("seed");
    expect(classifySignup("mobile")).toBe("seed");
    expect(classifySignup("web:landing")).toBe("seed");
  });
});

describe("срезы", () => {
  it("всегда включает глобальный и добавляет доступные кластеры", () => {
    expect(scopesOf(signup({ userId: "u", createdAt: "2026-05-01T00:00:00Z" }))).toEqual([
      GLOBAL_SCOPE,
    ]);
    expect(
      scopesOf(
        signup({
          userId: "u",
          createdAt: "2026-05-01T00:00:00Z",
          cityKey: "kyiv",
          universityDomain: "kpi.ua",
        }),
      ),
    ).toEqual([GLOBAL_SCOPE, "city:kyiv", "university:kpi.ua"]);
  });

  it("разбирает срез обратно и не ломается о мусор", () => {
    expect(parseScope(cityScope("lviv"))).toEqual({ dimension: "city", key: "lviv" });
    expect(parseScope(universityScope("KPI.UA"))).toEqual({
      dimension: "university",
      key: "kpi.ua",
    });
    expect(parseScope("nonsense")).toEqual({ dimension: "global", key: null });
    expect(parseScope(":leading")).toEqual({ dimension: "global", key: null });
  });
});

describe("дневной ряд", () => {
  it("оставляет нулевые дни на месте — иначе окно базы растянется", () => {
    const days = dayRange(new Date("2026-05-01T00:00:00Z"), new Date("2026-05-05T00:00:00Z"));
    const rows = aggregateDays(
      [
        signup({ userId: "a", createdAt: "2026-05-01T10:00:00Z" }),
        signup({ userId: "b", createdAt: "2026-05-05T10:00:00Z", channel: "referral" }),
      ],
      days,
    );
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.signups)).toEqual([1, 0, 0, 0, 1]);
    expect(rows[0].organicSignups).toBe(1);
    expect(rows[4].referralSignups).toBe(1);
  });

  it("игнорирует регистрации за пределами запрошенного окна", () => {
    const days = dayRange(new Date("2026-05-02T00:00:00Z"), new Date("2026-05-03T00:00:00Z"));
    const rows = aggregateDays(
      [signup({ userId: "a", createdAt: "2026-04-30T10:00:00Z" })],
      days,
    );
    expect(rows.map((r) => r.signups)).toEqual([0, 0]);
  });
});

describe("базовая линия органики", () => {
  it("не отдаёт базу, пока окно не набрано полностью", () => {
    const rows = withOrganicBaseline(series(Array(BASELINE_WINDOW_DAYS).fill(4)));
    for (const row of rows) {
      expect(row.baselineOrganic).toBeNull();
      expect(row.womStatus).toBe("immature");
      expect(row.kWom).toBeNull();
    }
  });

  it("считает базу по ПРЕДЫДУЩИМ дням, не включая измеряемый", () => {
    // 14 дней по 2, затем всплеск 20. База 15-го дня обязана остаться 2.
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(2), 20]));
    const spike = rows[BASELINE_WINDOW_DAYS];
    expect(spike.baselineOrganic).toBe(2);
    expect(spike.organicUplift).toBe(18);
  });

  it("прирост никогда не отрицательный", () => {
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(10), 1]));
    expect(rows[BASELINE_WINDOW_DAYS].organicUplift).toBe(0);
  });

  it("без семени `K_wom` — null со статусом no-seed, а не ноль", () => {
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(2), 20]));
    expect(rows[BASELINE_WINDOW_DAYS].kWom).toBeNull();
    expect(rows[BASELINE_WINDOW_DAYS].womStatus).toBe("no-seed");
  });

  it("делит прирост на семя того же дня", () => {
    const organic = [...Array(BASELINE_WINDOW_DAYS).fill(2), 12];
    const seed = [...Array(BASELINE_WINDOW_DAYS).fill(0), 5];
    const rows = withOrganicBaseline(series(organic, seed));
    const day = rows[BASELINE_WINDOW_DAYS];
    expect(day.organicUplift).toBe(10);
    expect(day.kWom).toBe(2);
    expect(day.womStatus).toBe("ok");
  });
});

describe("K_wom за период", () => {
  it("это отношение сумм, а не среднее подневных отношений", () => {
    // День A: прирост 1 на 1 семя → K = 1.
    // День B: база уже помнит день A (1/14 ≈ 0.07), прирост 0.93 на 9 семян → K ≈ 0.10.
    // Среднее отношений дало бы 0.55 — величину, которой не наблюдал ни один день.
    // Отношение сумм: (1 + 0.93) / (1 + 9) = 0.193.
    const organic = [...Array(BASELINE_WINDOW_DAYS).fill(0), 1, 1];
    const seed = [...Array(BASELINE_WINDOW_DAYS).fill(0), 1, 9];
    const rows = withOrganicBaseline(series(organic, seed));
    const measured = rows.slice(BASELINE_WINDOW_DAYS);
    expect(measured.map((d) => d.kWom)).toEqual([1, 0.1033]);
    expect(periodWom(measured).kWom).toBe(0.193);
  });

  it("день без базы не участвует ни в числителе, ни в знаменателе", () => {
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(1), 5]));
    const period = periodWom(rows);
    expect(period.measurableDays).toBe(1);
    expect(period.organic).toBe(5);
  });

  it("на пустом ряде не выдумывает ноль", () => {
    expect(periodWom([]).kWom).toBeNull();
    expect(periodWom([]).uplift).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const COHORT_DAY = new Date("2026-05-01T00:00:00.000Z");

function funnel(
  kind: FunnelEventRow["kind"],
  referrerId: string | null,
  occurredAt: string,
): FunnelEventRow {
  return { kind, referrerId, occurredAt: new Date(occurredAt) };
}

function activation(referrerId: string, activatedAt: string): ActivationRow {
  return { referrerId, activatedAt: new Date(activatedAt) };
}

describe("когортный K-фактор", () => {
  const members = [
    signup({ userId: "r1", createdAt: "2026-05-01T08:00:00Z" }),
    signup({ userId: "r2", createdAt: "2026-05-01T09:00:00Z" }),
    signup({ userId: "r3", createdAt: "2026-05-01T10:00:00Z" }),
    signup({ userId: "r4", createdAt: "2026-05-01T11:00:00Z" }),
  ];

  it("раскладывает K на i × c", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [
        funnel("share_sheet_opened", "r1", "2026-05-01T12:00:00Z"),
        funnel("invite_sent", "r1", "2026-05-01T12:01:00Z"),
        funnel("invite_sent", "r1", "2026-05-02T12:00:00Z"),
        funnel("invite_sent", "r2", "2026-05-03T12:00:00Z"),
        funnel("invite_link_clicked", "r1", "2026-05-02T13:00:00Z"),
        funnel("invite_link_clicked", "r1", "2026-05-03T13:00:00Z"),
      ],
      activationsByReferrer: groupActivations([activation("r1", "2026-05-04T10:00:00Z")]),
      kWom: null,
      now: NOW,
    });

    expect(metrics.cohortSize).toBe(4);
    expect(metrics.sharers).toBe(2); // r1 и r2 — отправка тоже делает шером
    expect(metrics.invitesSent).toBe(3);
    expect(metrics.invitesPerUser).toBe(0.75);
    expect(metrics.linkClicks).toBe(2);
    expect(metrics.clickRate).toBeCloseTo(0.6667, 4);
    expect(metrics.activations).toBe(1);
    expect(metrics.activationRate).toBe(0.5);
    expect(metrics.kDirect).toBe(0.25);
    expect(metrics.mature).toBe(true);
  });

  it("не выдаёт конверсию, когда клики недосчитаны: это дыра в инструменте", () => {
    // Ровно случай исторической когорты: активации есть (из `referralCountedAt`),
    // а событие клика записать было некому.
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [funnel("invite_link_clicked", "r1", "2026-05-02T13:00:00Z")],
      activationsByReferrer: groupActivations([
        activation("r1", "2026-05-02T14:00:00Z"),
        activation("r2", "2026-05-03T14:00:00Z"),
      ]),
      kWom: null,
      now: NOW,
    });
    expect(metrics.activations).toBe(2);
    expect(metrics.linkClicks).toBe(1);
    expect(metrics.activationRate).toBeNull();
    // Прямой K при этом честен: он не зависит от воронки событий вообще.
    expect(metrics.kDirect).toBe(0.5);
  });

  it("считает время цикла от регистрации РЕФЕРЕРА до активации приглашённого", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [],
      // r1 зарегистрировался в 08:00 1 мая, приглашённый активировался в 08:00
      // 3 мая — ровно 48 часов.
      activationsByReferrer: groupActivations([activation("r1", "2026-05-03T08:00:00Z")]),
      kWom: null,
      now: NOW,
    });
    expect(metrics.cycleTimeMedianHours).toBe(48);
  });

  it("без активаций у времени цикла нет значения, а не ноль", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [],
      activationsByReferrer: new Map(),
      kWom: null,
      now: NOW,
    });
    expect(metrics.cycleTimeMedianHours).toBeNull();
    expect(metrics.activations).toBe(0);
    expect(metrics.kDirect).toBe(0);
    expect(metrics.clickRate).toBeNull();
    expect(metrics.activationRate).toBeNull();
  });

  it("не впускает в окно то, что случилось после его конца", () => {
    const d1 = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 1,
      members,
      events: [funnel("invite_sent", "r1", "2026-05-03T12:00:00Z")],
      activationsByReferrer: groupActivations([activation("r1", "2026-05-05T10:00:00Z")]),
      kWom: null,
      now: NOW,
    });
    expect(d1.invitesSent).toBe(0);
    expect(d1.activations).toBe(0);

    const d7 = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [funnel("invite_sent", "r1", "2026-05-03T12:00:00Z")],
      activationsByReferrer: groupActivations([activation("r1", "2026-05-05T10:00:00Z")]),
      kWom: null,
      now: NOW,
    });
    expect(d7.invitesSent).toBe(1);
    expect(d7.activations).toBe(1);
  });

  it("игнорирует события чужих реферреров", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [
        funnel("invite_sent", "stranger", "2026-05-02T12:00:00Z"),
        funnel("invite_link_clicked", null, "2026-05-02T12:00:00Z"),
      ],
      activationsByReferrer: groupActivations([activation("stranger", "2026-05-02T12:00:00Z")]),
      kWom: null,
      now: NOW,
    });
    expect(metrics.invitesSent).toBe(0);
    expect(metrics.linkClicks).toBe(0);
    expect(metrics.activations).toBe(0);
  });

  it("помечает незрелой когорту, чьё окно ещё не закрылось", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-30",
      cohortDay: new Date("2026-05-30T00:00:00.000Z"),
      maturityDay: 30,
      members: [signup({ userId: "x", createdAt: "2026-05-30T08:00:00Z" })],
      events: [],
      activationsByReferrer: new Map(),
      kWom: null,
      now: NOW,
    });
    expect(metrics.mature).toBe(false);
  });

  it("складывает K_total как сумму прямого и сарафанного", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members,
      events: [],
      activationsByReferrer: groupActivations([activation("r1", "2026-05-02T10:00:00Z")]),
      kWom: 0.3,
      now: NOW,
    });
    expect(metrics.kDirect).toBe(0.25);
    expect(metrics.kTotal).toBe(0.55);
  });

  it("пустая когорта не делит на ноль", () => {
    const metrics = computeCohort({
      cohortDate: "2026-05-01",
      cohortDay: COHORT_DAY,
      maturityDay: 7,
      members: [],
      events: [],
      activationsByReferrer: new Map(),
      kWom: null,
      now: NOW,
    });
    expect(metrics.kDirect).toBe(0);
    expect(metrics.invitesPerUser).toBe(0);
    expect(Number.isFinite(metrics.kTotal)).toBe(true);
  });
});

// ---------------------------------------------------------------------------

function cohort(partial: Partial<CohortMetrics> & { cohortDate: string }): CohortMetrics {
  return {
    cohortDate: partial.cohortDate,
    maturityDay: partial.maturityDay ?? 7,
    cohortSize: partial.cohortSize ?? 10,
    sharers: partial.sharers ?? 0,
    invitesSent: partial.invitesSent ?? 0,
    linkClicks: partial.linkClicks ?? 0,
    activations: partial.activations ?? 0,
    invitesPerUser: partial.invitesPerUser ?? 0,
    clickRate: partial.clickRate ?? null,
    activationRate: partial.activationRate ?? null,
    kDirect: partial.kDirect ?? 0,
    cycleTimeMedianHours: partial.cycleTimeMedianHours ?? null,
    kWom: partial.kWom ?? null,
    kTotal: partial.kTotal ?? 0,
    mature: partial.mature ?? true,
  };
}

describe("свод когорт за период", () => {
  it("отношение сумм, а не среднее отношений", () => {
    // Когорта из 2 с одной активацией (K=0.5) и когорта из 100 с четырьмя
    // (K=0.04). Правильный ответ — 5/102 ≈ 0.049, а не среднее 0.27.
    const agg = aggregateCohorts([
      cohort({ cohortDate: "2026-05-01", cohortSize: 2, activations: 1, kDirect: 0.5 }),
      cohort({ cohortDate: "2026-05-02", cohortSize: 100, activations: 4, kDirect: 0.04 }),
    ]);
    expect(agg?.kDirect).toBeCloseTo(0.049, 3);
  });

  it("не берёт в расчёт незрелые когорты, но сообщает о них", () => {
    const agg = aggregateCohorts([
      cohort({ cohortDate: "2026-05-01", cohortSize: 10, activations: 2 }),
      cohort({ cohortDate: "2026-05-31", cohortSize: 90, activations: 0, mature: false }),
    ]);
    expect(agg?.cohorts).toBe(2);
    expect(agg?.matureCohorts).toBe(1);
    expect(agg?.cohortSize).toBe(10);
    expect(agg?.kDirect).toBe(0.2);
  });

  it("без единой зрелой когорты K — null, а не ноль", () => {
    const agg = aggregateCohorts([
      cohort({ cohortDate: "2026-05-31", cohortSize: 5, mature: false }),
    ]);
    expect(agg?.matureCohorts).toBe(0);
    expect(agg?.kDirect).toBeNull();
  });

  it("на пустом входе возвращает null целиком", () => {
    expect(aggregateCohorts([])).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("опрос HDYHAU", () => {
  const rows: HdyhauRow[] = [
    { answer: "friend_in_person", channel: "organic", answeredAt: NOW, wordOfMouth: true },
    { answer: "friend_in_person", channel: "organic", answeredAt: NOW, wordOfMouth: true },
    { answer: "social_media", channel: "organic", answeredAt: NOW, wordOfMouth: false },
    { answer: "social_media", channel: "organic", answeredAt: NOW, wordOfMouth: false },
    { answer: "ad", channel: "tg:ig_story", answeredAt: NOW, wordOfMouth: false },
  ];

  it("считает распределение и обе доли устных", () => {
    const s = summarizeHdyhau(rows);
    expect(s.total).toBe(5);
    expect(s.byAnswer[0]).toEqual({ answer: "friend_in_person", count: 2, share: 0.4 });
    expect(s.womShare).toBe(0.4);
    expect(s.organicRespondents).toBe(4);
    // Среди пришедших «ниоткуда» половина говорит, что их привёл человек.
    expect(s.womShareOfOrganic).toBe(0.5);
  });

  it("на пустом опросе не выдумывает нулевых долей", () => {
    const s = summarizeHdyhau([]);
    expect(s.total).toBe(0);
    expect(s.womShare).toBeNull();
    expect(s.womShareOfOrganic).toBeNull();
  });
});

describe("калибровка WOM", () => {
  const hdyhau = summarizeHdyhau([
    { answer: "friend_in_person", channel: "organic", answeredAt: NOW, wordOfMouth: true },
    { answer: "social_media", channel: "organic", answeredAt: NOW, wordOfMouth: false },
  ]);

  it("при достаточном покрытии верит опросу", () => {
    const c = calibrateWom({
      organicSignups: 4, // 2 из 4 ответили → покрытие 0.5
      seedSignups: 10,
      baselineUplift: 1,
      hdyhau,
    });
    expect(c.coverage).toBe(0.5);
    expect(c.method).toBe("hdyhau");
    expect(c.upliftFromSurvey).toBe(2); // 4 × 0.5
    expect(c.kWom).toBe(0.2);
  });

  it("при слабом покрытии остаётся на базовой линии", () => {
    const c = calibrateWom({
      organicSignups: 100, // 2 из 100 → покрытие 0.02
      seedSignups: 10,
      baselineUplift: 5,
      hdyhau,
    });
    expect(c.method).toBe("baseline");
    expect(c.kWom).toBe(0.5);
    // Обе оценки всё равно видны — расхождение само по себе сигнал.
    expect(c.upliftFromSurvey).toBe(50);
    expect(c.upliftFromBaseline).toBe(5);
  });

  it("без базы и без опроса честно говорит, что метода нет", () => {
    const c = calibrateWom({
      organicSignups: 0,
      seedSignups: 0,
      baselineUplift: null,
      hdyhau: summarizeHdyhau([]),
    });
    expect(c.method).toBe("none");
    expect(c.kWom).toBeNull();
  });

  it("нулевое семя оставляет K_wom невычислимым даже при известном приросте", () => {
    const c = calibrateWom({
      organicSignups: 4,
      seedSignups: 0,
      baselineUplift: 3,
      hdyhau,
    });
    expect(c.kWom).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe("аномалии органики", () => {
  it("ловит всплеск сверх 2σ", () => {
    const organic = [...Array(BASELINE_WINDOW_DAYS).fill(0).map((_, i) => (i % 2 ? 3 : 5)), 40];
    const rows = withOrganicBaseline(series(organic));
    const found = detectOrganicAnomalies(rows, GLOBAL_SCOPE);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("organic_spike");
    expect(found[0].direction).toBe("up");
    expect(found[0].zScore).toBeGreaterThan(2);
  });

  it("ловит провал так же, как всплеск", () => {
    const organic = [...Array(BASELINE_WINDOW_DAYS).fill(0).map((_, i) => (i % 2 ? 30 : 34)), 0];
    const rows = withOrganicBaseline(series(organic));
    const found = detectOrganicAnomalies(rows, GLOBAL_SCOPE);
    expect(found.map((f) => f.kind)).toContain("organic_drop");
  });

  it("на идеально ровном ряде всё равно видит всплеск — через пуассоновский пол", () => {
    // Выборочное σ окна = 0. Без пола такой день молча выпадал бы из проверки —
    // и слепым оказывался бы ровно тихий город, в котором случился дроп.
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(5), 500]));
    const found = detectOrganicAnomalies(rows, GLOBAL_SCOPE);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("organic_spike");
    // √5 ≈ 2.24 — на него и поделено, и это же число возвращено читателю.
    expect(found[0].stdDev).toBe(2.24);
    expect(found[0].zScore).toBeCloseTo((500 - 5) / Math.sqrt(5), 1);
  });

  it("на ровном ряде не поднимает шум из-за колебания в один человек", () => {
    // База 5, пол √5 ≈ 2.24: отклонение на 2 человека — это меньше сигмы.
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(5), 7]));
    expect(detectOrganicAnomalies(rows, GLOBAL_SCOPE)).toEqual([]);
  });

  it("при нулевой базе порога нет — истории тоже нет", () => {
    const rows = withOrganicBaseline(series([...Array(BASELINE_WINDOW_DAYS).fill(0), 3]));
    expect(detectOrganicAnomalies(rows, GLOBAL_SCOPE)).toEqual([]);
  });

  it("на шумном ряде остаётся наблюдённое СКО, а не пуассоновский пол", () => {
    // Разброс 0..20 вокруг средних 10: выборочное σ ≈ 10 много больше √10.
    const noisy = Array.from({ length: BASELINE_WINDOW_DAYS }, (_, i) => (i % 2 ? 0 : 20));
    const rows = withOrganicBaseline(series([...noisy, 25]));
    // 25 при базе ~10 и σ ~10 — это 1.5σ, то есть НЕ аномалия. С полом √10
    // (≈3.2) это было бы 4.7σ и ложной тревогой.
    expect(detectOrganicAnomalies(rows, GLOBAL_SCOPE)).toEqual([]);
  });

  it("не судит о днях, у которых базы ещё нет", () => {
    const rows = withOrganicBaseline(series([100, 0, 0]));
    expect(detectOrganicAnomalies(rows, GLOBAL_SCOPE)).toEqual([]);
  });
});

describe("аномалии времени цикла", () => {
  it("замечает резкий сдвиг медианы", () => {
    const stable = Array.from({ length: BASELINE_WINDOW_DAYS }, (_, i) =>
      cohort({
        cohortDate: `2026-04-${String(i + 1).padStart(2, "0")}`,
        cycleTimeMedianHours: i % 2 ? 24 : 26,
      }),
    );
    const shifted = cohort({ cohortDate: "2026-04-20", cycleTimeMedianHours: 200 });
    const found = detectCycleTimeAnomalies([...stable, shifted], GLOBAL_SCOPE);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("cycle_time_shift");
    expect(found[0].at).toBe("2026-04-20");
  });

  it("не смотрит на незрелые когорты и на когорты без цикла", () => {
    const rows = [
      ...Array.from({ length: BASELINE_WINDOW_DAYS }, (_, i) =>
        cohort({
          cohortDate: `2026-04-${String(i + 1).padStart(2, "0")}`,
          cycleTimeMedianHours: 24,
          mature: false,
        }),
      ),
      cohort({ cohortDate: "2026-04-20", cycleTimeMedianHours: 500, mature: false }),
    ];
    expect(detectCycleTimeAnomalies(rows, GLOBAL_SCOPE)).toEqual([]);
  });
});
