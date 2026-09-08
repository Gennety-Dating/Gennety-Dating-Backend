import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadSignups: vi.fn(),
  loadActivations: vi.fn(),
  loadFunnelEvents: vi.fn(),
  replaceViralityDays: vi.fn(),
  replaceViralityCohorts: vi.fn(),
}));

vi.mock("../admin/utils/virality-source.js", () => ({
  loadSignups: h.loadSignups,
  loadActivations: h.loadActivations,
  loadFunnelEvents: h.loadFunnelEvents,
  replaceViralityDays: h.replaceViralityDays,
  replaceViralityCohorts: h.replaceViralityCohorts,
}));

const { MIN_CLUSTER_SIGNUPS, selectScopes, viralityRollupTick } = await import(
  "./virality-rollup.js"
);
const { BASELINE_WINDOW_DAYS, GLOBAL_SCOPE } = await import("../admin/utils/virality.js");
import type { SignupRow } from "../admin/utils/virality.js";
import type {
  ScopedCohortMetrics,
  ScopedDayMetrics,
} from "../admin/utils/virality-source.js";

const NOW = new Date("2026-06-01T12:00:00.000Z");
const DAY_MS = 86_400_000;

type SignupInput = Omit<Partial<SignupRow>, "createdAt"> & {
  userId: string;
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

function writtenDays(): ScopedDayMetrics[] {
  return h.replaceViralityDays.mock.calls.at(-1)?.[2] as ScopedDayMetrics[];
}

function writtenCohorts(): ScopedCohortMetrics[] {
  return h.replaceViralityCohorts.mock.calls.at(-1)?.[2] as ScopedCohortMetrics[];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.loadSignups.mockResolvedValue([]);
  h.loadActivations.mockResolvedValue([]);
  h.loadFunnelEvents.mockResolvedValue([]);
  h.replaceViralityDays.mockImplementation(
    (_from: Date, _to: Date, rows: readonly unknown[]) => Promise.resolve(rows.length),
  );
  h.replaceViralityCohorts.mockImplementation(
    (_from: Date, _to: Date, rows: readonly unknown[]) => Promise.resolve(rows.length),
  );
});

describe("выбор срезов", () => {
  const rangeStart = new Date("2026-05-01T00:00:00.000Z");

  it("глобальный есть всегда, даже без единой регистрации", () => {
    expect(selectScopes([], rangeStart)).toEqual([GLOBAL_SCOPE]);
  });

  it("кластер ниже порога не получает собственных строк", () => {
    const rows = Array.from({ length: MIN_CLUSTER_SIGNUPS - 1 }, (_, i) =>
      signup({ userId: `u${i}`, createdAt: "2026-05-02T00:00:00Z", cityKey: "kyiv" }),
    );
    expect(selectScopes(rows, rangeStart)).toEqual([GLOBAL_SCOPE]);
  });

  it("кластер на пороге получает", () => {
    const rows = Array.from({ length: MIN_CLUSTER_SIGNUPS }, (_, i) =>
      signup({ userId: `u${i}`, createdAt: "2026-05-02T00:00:00Z", cityKey: "kyiv" }),
    );
    // Список отсортирован по имени, поэтому `city:*` идёт перед `global`.
    expect(selectScopes(rows, rangeStart)).toEqual(["city:kyiv", GLOBAL_SCOPE]);
  });

  it("порог считается по отчётному окну, а не по разгонному", () => {
    // Заглохший город: весь его объём остался ДО начала окна.
    const rows = Array.from({ length: MIN_CLUSTER_SIGNUPS + 5 }, (_, i) =>
      signup({ userId: `u${i}`, createdAt: "2026-04-01T00:00:00Z", cityKey: "old" }),
    );
    expect(selectScopes(rows, rangeStart)).toEqual([GLOBAL_SCOPE]);
  });
});

describe("прогон", () => {
  it("грузит регистрации с разгоном на окно базовой линии", async () => {
    await viralityRollupTick(NOW, { windowDays: 30 });

    const [from] = h.loadSignups.mock.calls[0] as [Date, Date];
    const expected = new Date(
      Date.UTC(2026, 4, 3) - BASELINE_WINDOW_DAYS * DAY_MS, // 2026-06-01 − 29 дней = 2026-05-03
    );
    expect(from.toISOString()).toBe(expected.toISOString());
  });

  it("сохраняет только отчётные дни, а не разгонные", async () => {
    await viralityRollupTick(NOW, { windowDays: 7 });
    const days = writtenDays();
    expect(days).toHaveLength(7);
    expect(days[0].day).toBe("2026-05-26");
    expect(days.at(-1)?.day).toBe("2026-06-01");
  });

  it("окно удаления совпадает с окном записи", async () => {
    await viralityRollupTick(NOW, { windowDays: 7 });
    const [dayFrom, dayTo] = h.replaceViralityDays.mock.calls[0] as [Date, Date];
    const [cohortFrom, cohortTo] = h.replaceViralityCohorts.mock.calls[0] as [Date, Date];
    expect(dayFrom.toISOString()).toBe("2026-05-26T00:00:00.000Z");
    expect(dayTo.toISOString()).toBe("2026-06-01T00:00:00.000Z");
    expect(cohortFrom.toISOString()).toBe(dayFrom.toISOString());
    expect(cohortTo.toISOString()).toBe(dayTo.toISOString());
  });

  it("пустой день не порождает когортных строк", async () => {
    h.loadSignups.mockResolvedValue([
      signup({ userId: "a", createdAt: "2026-05-28T10:00:00Z" }),
    ]);
    await viralityRollupTick(NOW, { windowDays: 7 });
    const dates = new Set(writtenCohorts().map((c) => c.cohortDate));
    expect([...dates]).toEqual(["2026-05-28"]);
    // Пять дней зрелости на одну когорту.
    expect(writtenCohorts()).toHaveLength(5);
  });

  it("каждая когорта получает строку на каждый день зрелости, помечая незрелые", async () => {
    h.loadSignups.mockResolvedValue([
      signup({ userId: "a", createdAt: "2026-05-31T10:00:00Z" }),
    ]);
    await viralityRollupTick(NOW, { windowDays: 7 });
    const rows = writtenCohorts().sort((x, y) => x.maturityDay - y.maturityDay);
    expect(rows.map((r) => r.maturityDay)).toEqual([1, 3, 7, 14, 30]);
    // 2026-05-31 + 1 день = 2026-06-01 00:00, а «сейчас» 12:00 — окно закрылось.
    expect(rows[0].mature).toBe(true);
    expect(rows[1].mature).toBe(false);
    expect(rows.at(-1)?.mature).toBe(false);
  });

  it("кластерный срез пишется отдельными строками рядом с глобальным", async () => {
    h.loadSignups.mockResolvedValue(
      Array.from({ length: MIN_CLUSTER_SIGNUPS }, (_, i) =>
        signup({ userId: `u${i}`, createdAt: "2026-05-28T10:00:00Z", cityKey: "kyiv" }),
      ),
    );
    await viralityRollupTick(NOW, { windowDays: 7 });
    const scopes = new Set(writtenDays().map((d) => d.scope));
    expect([...scopes].sort()).toEqual(["city:kyiv", "global"]);
    const cohortScopes = new Set(writtenCohorts().map((c) => c.scope));
    expect([...cohortScopes].sort()).toEqual(["city:kyiv", "global"]);
  });

  it("возвращает границы и объём записанного", async () => {
    h.loadSignups.mockResolvedValue([
      signup({ userId: "a", createdAt: "2026-05-28T10:00:00Z" }),
    ]);
    const result = await viralityRollupTick(NOW, { windowDays: 7 });
    expect(result).toMatchObject({
      from: "2026-05-26",
      to: "2026-06-01",
      scopes: 1,
      dayRows: 7,
      cohortRows: 5,
    });
  });

  it("прямой K-фактор считается по активациям приглашённых", async () => {
    h.loadSignups.mockResolvedValue([
      signup({ userId: "r1", createdAt: "2026-05-28T08:00:00Z" }),
      signup({ userId: "r2", createdAt: "2026-05-28T09:00:00Z" }),
    ]);
    h.loadActivations.mockResolvedValue([
      { referrerId: "r1", activatedAt: new Date("2026-05-29T08:00:00Z") },
    ]);

    await viralityRollupTick(NOW, { windowDays: 7 });
    const d7 = writtenCohorts().find((c) => c.maturityDay === 7);
    expect(d7?.cohortSize).toBe(2);
    expect(d7?.activations).toBe(1);
    expect(d7?.kDirect).toBe(0.5);
    expect(d7?.cycleTimeMedianHours).toBe(24);
  });
});
