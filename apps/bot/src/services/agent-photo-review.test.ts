import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `getPhotoReview` — покадровая ревизия собственных фотографий.
 *
 * Проверяется главным образом то, ради чего инструмент вообще безопасен:
 * покадровые оценки УЖЕ лежат в базе, но лежат по-разному свежие. Оценка
 * совпадения лица переписывается на каждой правке фотографий и потому
 * позиционно верна; ранжирование vision заморожено в момент посева и на
 * изменившемся наборе называет не ту фотографию. Тесты ниже про то, что
 * второе снимается целиком, а не подгоняется.
 */

const userFindUnique = vi.fn(async (_a: unknown): Promise<unknown> => null);
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (a: unknown) => userFindUnique(a) } },
  Prisma: {},
}));

const { getPhotoReview } = await import("./agent-insights.js");

const SEEDED_AT = new Date("2026-09-01T10:00:00Z");

/** Профиль с четырьмя фотографиями и посевом, который им соответствует. */
function row(overrides: {
  photos?: string[];
  photoFaceScores?: number[];
  pendingPhotoCandidates?: unknown[];
  eloSeedDetails?: unknown;
  eloSeededAt?: Date | null;
  faceMatchedAt?: Date | null;
}) {
  return {
    faceMatchedAt: overrides.faceMatchedAt ?? null,
    profile: {
      photos: overrides.photos ?? ["a", "b", "c", "d"],
      photoFaceScores: overrides.photoFaceScores ?? [0.91, 0.88, 0.93, 0.9],
      pendingPhotoCandidates: overrides.pendingPhotoCandidates ?? [],
      eloSeedDetails:
        "eloSeedDetails" in overrides
          ? overrides.eloSeedDetails
          : {
              photos: [
                { index: 1, score: 72 },
                { index: 2, score: 55 },
                { index: 3, score: 81 },
                { index: 4, score: 68 },
              ],
            },
      eloSeededAt: "eloSeededAt" in overrides ? overrides.eloSeededAt : SEEDED_AT,
    },
  };
}

describe("getPhotoReview", () => {
  beforeEach(() => {
    userFindUnique.mockReset();
    userFindUnique.mockResolvedValue(row({}));
  });

  it("returns null for an unknown user", async () => {
    userFindUnique.mockResolvedValue(null);
    expect(await getPhotoReview(1n)).toBeNull();
  });

  it("names the strongest and weakest photo when the seed still fits the set", async () => {
    const review = await getPhotoReview(1n);
    expect(review?.standouts).toEqual({ strongest: 3, weakest: 2 });
    expect(review?.photoCount).toBe(4);
  });

  it("flags only the positions where the face barely cleared the gate", async () => {
    // Порог приёмки 0.6, полоса «плохо узнаётся» — 0.1 над ним.
    userFindUnique.mockResolvedValue(row({ photoFaceScores: [0.94, 0.64, 0.88, 0.69] }));
    const review = await getPhotoReview(1n);
    expect(review?.hardToRecognise).toEqual([2, 4]);
    expect(review?.faceDataAvailable).toBe(true);
  });

  it("withholds face data entirely when the scores do not line up with the photos", async () => {
    // Легаси-строка: оценок меньше, чем фотографий. Позицию не восстановить.
    userFindUnique.mockResolvedValue(row({ photoFaceScores: [0.64] }));
    const review = await getPhotoReview(1n);
    expect(review?.faceDataAvailable).toBe(false);
    expect(review?.hardToRecognise).toEqual([]);
  });

  it("drops the ranking when a photo was uploaded after the seed ran", async () => {
    userFindUnique.mockResolvedValue(
      row({ faceMatchedAt: new Date(SEEDED_AT.getTime() + 60_000) }),
    );
    expect((await getPhotoReview(1n))?.standouts).toBeNull();
  });

  it("keeps the ranking when the last face match predates the seed", async () => {
    userFindUnique.mockResolvedValue(
      row({ faceMatchedAt: new Date(SEEDED_AT.getTime() - 60_000) }),
    );
    expect((await getPhotoReview(1n))?.standouts).toEqual({ strongest: 3, weakest: 2 });
  });

  it("drops the ranking when a photo was removed since the seed", async () => {
    userFindUnique.mockResolvedValue(row({ photos: ["a", "b", "c"] }));
    expect((await getPhotoReview(1n))?.standouts).toBeNull();
  });

  it("drops the ranking when the spread between best and worst is noise", async () => {
    userFindUnique.mockResolvedValue(
      row({
        eloSeedDetails: {
          photos: [
            { index: 1, score: 70 },
            { index: 2, score: 72 },
            { index: 3, score: 74 },
            { index: 4, score: 71 },
          ],
        },
      }),
    );
    expect((await getPhotoReview(1n))?.standouts).toBeNull();
  });

  it("drops the ranking on a malformed seed instead of half-reading it", async () => {
    userFindUnique.mockResolvedValue(
      row({ eloSeedDetails: { photos: [{ index: 1 }, { index: 2, score: 55 }] } }),
    );
    expect((await getPhotoReview(1n))?.standouts).toBeNull();
  });

  it("drops the ranking when the profile was never seeded", async () => {
    userFindUnique.mockResolvedValue(row({ eloSeedDetails: null, eloSeededAt: null }));
    expect((await getPhotoReview(1n))?.standouts).toBeNull();
  });

  it("reports photos still waiting on the identity check", async () => {
    userFindUnique.mockResolvedValue(row({ pendingPhotoCandidates: [{ path: "x" }] }));
    expect((await getPhotoReview(1n))?.pendingIdentityCheck).toBe(1);
  });

  it("survives an empty profile without inventing positions", async () => {
    userFindUnique.mockResolvedValue(
      row({ photos: [], photoFaceScores: [], eloSeedDetails: null, eloSeededAt: null }),
    );
    const review = await getPhotoReview(1n);
    expect(review?.photoCount).toBe(0);
    expect(review?.standouts).toBeNull();
    expect(review?.hardToRecognise).toEqual([]);
  });
});
