import { describe, it, expect } from "vitest";
import { computeGenderRatio } from "./gender-ratio.js";
import type { ClassifiedUser } from "./user-health.js";

function u(gender: string | null, classification = "live"): ClassifiedUser {
  return {
    gender,
    verdict: { classification },
  } as unknown as ClassifiedUser;
}

describe("computeGenderRatio", () => {
  it("keeps the unknown share visible instead of hiding it", () => {
    // Прод на момент написания: 6 / 1 / 16. Расклад «85.7% мужчин», поданный
    // как расклад базы, описывает 30% базы как всю базу.
    const out = computeGenderRatio([
      ...Array(6).fill(u("male")),
      u("female"),
      ...Array(16).fill(u(null)),
    ]);
    expect(out).toMatchObject({
      male: 6,
      female: 1,
      unknown: 16,
      total: 23,
      malePctOfKnown: 85.7,
      femalePctOfKnown: 14.3,
      unknownPctOfTotal: 69.6,
    });
  });

  it("excludes test accounts from every number", () => {
    const out = computeGenderRatio([u("male"), u("female", "test"), u(null, "test")]);
    expect(out.total).toBe(1);
    expect(out.female).toBe(0);
    expect(out.unknown).toBe(0);
  });

  it("returns null shares rather than 0 when nobody answered", () => {
    const out = computeGenderRatio([u(null), u(null)]);
    expect(out.malePctOfKnown).toBeNull();
    expect(out.femalePctOfKnown).toBeNull();
    expect(out.unknownPctOfTotal).toBe(100);
  });

  it("is all-null on an empty base", () => {
    const out = computeGenderRatio([]);
    expect(out.total).toBe(0);
    expect(out.unknownPctOfTotal).toBeNull();
  });
});
