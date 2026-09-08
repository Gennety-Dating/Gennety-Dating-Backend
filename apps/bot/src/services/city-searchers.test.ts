import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Порог счётчика «в поиске в городе».
 *
 * Проверяется не арифметика `count`, а правило: ниже порога наружу уходит
 * `null`, а не маленькое число. Это единственное место, где живёт политика —
 * если она протечёт в клиент, две поверхности начнут показывать разное.
 */

const env = { SEARCHERS_COUNTER_MIN: 250 };
vi.mock("../config.js", () => ({ env }));

const findUnique = vi.fn(async (_args: unknown): Promise<unknown> => ({
  profile: { homeCityKey: "kyiv" },
}));
const count = vi.fn(async (_args: unknown): Promise<number> => 0);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: (args: unknown) => findUnique(args),
      count: (args: unknown) => count(args),
    },
  },
}));

const { countCitySearchers, SEARCHERS_VISIBILITY_THRESHOLD } = await import(
  "./city-searchers.js"
);

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue({ profile: { homeCityKey: "kyiv" } });
  count.mockReset();
});

describe("countCitySearchers", () => {
  it("порог берётся из окружения — основатель выбрал 250", () => {
    expect(SEARCHERS_VISIBILITY_THRESHOLD).toBe(250);
  });

  it("ниже порога отдаёт null, а не честную мелочь", async () => {
    count.mockResolvedValue(4);
    expect(await countCitySearchers("u1")).toBeNull();
  });

  it("ровно на пороге счётчик уже виден — граница включающая", async () => {
    count.mockResolvedValue(250);
    expect(await countCitySearchers("u1")).toBe(250);
  });

  it("на единицу ниже порога — ещё нет", async () => {
    count.mockResolvedValue(249);
    expect(await countCitySearchers("u1")).toBeNull();
  });

  it("выше порога отдаёт настоящее число, а не округление", async () => {
    count.mockResolvedValue(2_341);
    expect(await countCitySearchers("u1")).toBe(2_341);
  });

  it("город не выбран — null, и запрос на подсчёт даже не уходит", async () => {
    findUnique.mockResolvedValue({ profile: null });

    expect(await countCitySearchers("u1")).toBeNull();
    expect(count).not.toHaveBeenCalled();
  });

  it("считает город целиком: без фильтра по полу и без исключения себя", async () => {
    count.mockResolvedValue(300);
    await countCitySearchers("u1");

    const where = (count.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    // `active` уже исключает paused/frozen/модерацию — отдельных условий не надо.
    expect(where).toEqual({
      status: "active",
      onboardingStep: "completed",
      profile: { homeCityKey: "kyiv" },
    });
    // Ни gender/preference (это персональная выборка, ею занят agent-insights),
    // ни `id: { not: ... }` — сам пользователь тоже в поиске.
    expect(where).not.toHaveProperty("gender");
    expect(where).not.toHaveProperty("id");
  });
});
