import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `explainMatch` — что `explain_my_match` отдаёт модели (аудит A13-M6).
 *
 * `match_score_logs` хранит одну симметричную раскладку на пару: `scorePair`
 * усредняет оба направления и берёт максимум из двух бонусов простоя. Поля,
 * в которые подмешана сторона партнёра — сработавшие стоп-факторы, бонус
 * простоя, попадание в его возрастной диапазон, — модели не отдаются: она
 * пересказала бы их человеку как факт о партнёре.
 */

const userFindUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({ id: "viewer" }));
const matchFindFirst = vi.fn(async (_a: unknown): Promise<unknown> => null);
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    match: { findFirst: (a: unknown) => matchFindFirst(a) },
  },
  Prisma: {},
}));

const { explainMatch } = await import("./agent-insights.js");

/** Пара, в которой у партнёра сработали стоп-факторы и был бонус простоя. */
const MATCH_ROW = {
  id: "m1",
  status: "pending",
  userAId: "viewer",
  synergyScore: 0.81,
  synergyReason: "Оба любите долгие прогулки.",
  synergyReasonB: null,
  userA: { firstName: "Я" },
  userB: { firstName: "Аня" },
  scoreLog: {
    scoreExplicit: 0.9,
    scoreResearch: 0.6,
    scoreLeague: 0.75,
    scoreAgePref: 0.4,
    scorePenalty: 0.3,
    starvationBonus: 0.05,
  },
};

describe("explainMatch", () => {
  beforeEach(() => {
    matchFindFirst.mockReset();
    matchFindFirst.mockResolvedValue(MATCH_ROW);
  });

  it("отдаёт только факторы без приватных сигналов партнёра", async () => {
    const explanation = await explainMatch(1n);

    expect(explanation?.factors).toEqual({
      psychologicalFit: "very strong",
      lifestyleFit: "moderate",
      attractivenessBalance: "strong",
    });
    const serialized = JSON.stringify(explanation);
    expect(serialized).not.toContain("hadNegativeSignal");
    expect(serialized).not.toContain("priorityBoost");
    expect(serialized).not.toContain("agePreferenceFit");
  });

  it("не читает из лога столбцы, смешанные со стороной партнёра", async () => {
    await explainMatch(1n);

    const args = matchFindFirst.mock.calls[0]![0] as {
      select: { scoreLog: { select: Record<string, true> } };
    };
    expect(Object.keys(args.select.scoreLog.select).sort()).toEqual([
      "scoreExplicit",
      "scoreLeague",
      "scoreResearch",
    ]);
  });
});
