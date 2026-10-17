import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ env: { ADMIN_TEST_TELEGRAM_IDS: "" } }));
vi.mock("@gennety/db", () => ({ prisma: {} }));

const { cohortRetained } = await import("./retention.js");

const DAY = 86_400_000;
const NOW = new Date("2026-10-15T12:00:00.000Z");
const at = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * DAY);

describe("cohortRetained — maturity gate", () => {
  it("waits for the LATEST member before reporting W+1", () => {
    // Earliest joined 10 days ago, latest 3 days ago: W+1 is not mature for
    // the latest one yet, so the cell must be null rather than count them as
    // churned. Before the fix the earliest member (10 d ≥ 7 d) opened it.
    const members = [
      { created: at(10), last: at(1) },
      { created: at(3), last: at(3) },
    ];
    expect(cohortRetained(members, NOW)[1]).toBeNull();
  });

  it("reports the cell once every member is old enough", () => {
    const members = [
      { created: at(20), last: at(1) }, // active 19 days after signup
      { created: at(15), last: at(14) }, // gone after a day
    ];
    const r = cohortRetained(members, NOW);
    expect(r[1]).toBe(0.5);
    expect(r[2]).toBe(0.5);
    // 4 weeks have not elapsed since the latest member (15 d).
    expect(r[4]).toBeNull();
    expect(r[8]).toBeNull();
  });

  it("an empty cohort reports nothing", () => {
    expect(cohortRetained([], NOW)).toEqual({ 1: null, 2: null, 4: null, 8: null });
  });
});
