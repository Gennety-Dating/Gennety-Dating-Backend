import { describe, expect, it, vi } from "vitest";

const matchFindUnique = vi.fn();
vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: (...a: unknown[]) => matchFindUnique(...a) } },
}));

const { matchTimeZone, loadMatchTimeZone } = await import("./match-time-zone.js");

const side = (homeCityKey: string | null, homeCountryCode: string | null = null) => ({
  profile: { homeCityKey, homeCountryCode },
});

describe("matchTimeZone (audit C-25)", () => {
  it("resolves the date city's zone", () => {
    expect(matchTimeZone({ userA: side("de:berlin", "DE"), userB: side("de:berlin", "DE") })).toBe(
      "Europe/Berlin",
    );
    expect(matchTimeZone({ userA: side("ua:kyiv", "UA"), userB: side("ua:kyiv", "UA") })).toBe(
      "Europe/Kyiv",
    );
  });

  it("falls back to the default zone when the city is unknown", () => {
    expect(matchTimeZone({ userA: null, userB: null })).toBe("Europe/Kyiv");
    expect(matchTimeZone({ userA: { profile: null }, userB: { profile: null } })).toBe(
      "Europe/Kyiv",
    );
    expect(matchTimeZone({ userA: side(null), userB: side(null) })).toBe("Europe/Kyiv");
  });

  it("uses whichever side carries the city, and never mixes two profiles", () => {
    expect(matchTimeZone({ userA: side(null), userB: side("de:berlin") })).toBe("Europe/Berlin");
    // A's country must not override B's city key.
    expect(matchTimeZone({ userA: side(null, "UA"), userB: side("de:berlin", "DE") })).toBe(
      "Europe/Berlin",
    );
  });

  it("is deterministic when the two sides disagree — side A wins", () => {
    const zone = matchTimeZone({ userA: side("de:berlin", "DE"), userB: side("ua:kyiv", "UA") });
    expect(zone).toBe("Europe/Berlin");
    expect(matchTimeZone({ userA: side("de:berlin", "DE"), userB: side("ua:kyiv", "UA") })).toBe(zone);
  });

  it("ignores Profile.timeZone — a per-person value — in favour of the city", () => {
    const withStaleZone = {
      userA: { profile: { homeCityKey: "de:berlin", homeCountryCode: "DE", timeZone: "Europe/Kyiv" } },
      userB: { profile: { homeCityKey: "de:berlin", homeCountryCode: "DE", timeZone: "Europe/London" } },
    };
    expect(matchTimeZone(withStaleZone)).toBe("Europe/Berlin");
  });

  it("loads the profiles and resolves; a missing match reads as the default", async () => {
    matchFindUnique.mockResolvedValueOnce({ userA: side("de:berlin"), userB: side("de:berlin") });
    await expect(loadMatchTimeZone("m-1")).resolves.toBe("Europe/Berlin");
    matchFindUnique.mockResolvedValueOnce(null);
    await expect(loadMatchTimeZone("m-2")).resolves.toBe("Europe/Kyiv");
  });
});
