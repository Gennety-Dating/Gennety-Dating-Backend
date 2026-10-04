import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("./openai.js", () => ({
  callOpenAIText: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { callOpenAIText } from "./openai.js";
import { generateAndSaveWingmanHints, refreshWingmanHintAbout } from "./wingman-hint.js";

type MockFn = ReturnType<typeof vi.fn>;
const mFindUnique = (prisma.match as unknown as { findUnique: MockFn }).findUnique;
const mUpdate = (prisma.match as unknown as { update: MockFn }).update;
const mCall = callOpenAIText as unknown as MockFn;

function baseMatchRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: "m1",
    wingmanHintA: null,
    wingmanHintB: null,
    userA: {
      firstName: "Alice",
      language: "en",
      profile: { psychologicalSummary: "loves jazz and rock climbing" },
    },
    userB: {
      firstName: "Bob",
      language: "en",
      profile: { psychologicalSummary: "debate-club lead, philosophy nerd" },
    },
    ...overrides,
  };
}

describe("generateAndSaveWingmanHints", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue(undefined);
  });

  it("returns null when the match doesn't exist", async () => {
    mFindUnique.mockResolvedValueOnce(null);
    const result = await generateAndSaveWingmanHints("missing");
    expect(result).toBeNull();
    expect(mCall).not.toHaveBeenCalled();
  });

  it("no-ops when both hints are already populated (idempotent)", async () => {
    mFindUnique.mockResolvedValueOnce(
      baseMatchRow({ wingmanHintA: "existing A", wingmanHintB: "existing B" }),
    );
    const result = await generateAndSaveWingmanHints("m1");
    expect(result).toEqual({ a: "existing A", b: "existing B" });
    expect(mCall).not.toHaveBeenCalled();
    expect(mUpdate).not.toHaveBeenCalled();
  });

  it("generates two asymmetric hints and persists them", async () => {
    mFindUnique.mockResolvedValueOnce(baseMatchRow());
    mCall
      .mockResolvedValueOnce("Ask him about his crazy debate-club story from last spring.")
      .mockResolvedValueOnce("Get her to tell you about her favourite jazz set this year.");

    const result = await generateAndSaveWingmanHints("m1");

    expect(mCall).toHaveBeenCalledTimes(2);
    expect(result?.a).toMatch(/debate-club/);
    expect(result?.b).toMatch(/jazz/);
    expect(mUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { wingmanHintA: result!.a, wingmanHintB: result!.b },
    });
  });

  it("falls back to a language-specific default when the model returns junk", async () => {
    mFindUnique.mockResolvedValueOnce(
      baseMatchRow({ userA: { firstName: "Alice", language: "ru", profile: null } }),
    );
    // A: empty (fallback). B: contains a question mark (fallback).
    mCall.mockResolvedValueOnce("").mockResolvedValueOnce("What do you think about jazz?");

    const result = await generateAndSaveWingmanHints("m1");

    // Russian fallback for Alice (viewer A speaks ru), English for Bob.
    expect(result?.a).toMatch(/Спроси/);
    expect(result?.b).toMatch(/excited/);
  });

  it("has German and Polish fallbacks", async () => {
    mFindUnique.mockResolvedValueOnce(
      baseMatchRow({
        userA: { firstName: "Max", language: "de", profile: null },
        userB: { firstName: "Ania", language: "pl", profile: null },
      }),
    );
    mCall.mockResolvedValueOnce("").mockResolvedValueOnce("");

    const result = await generateAndSaveWingmanHints("m1");

    expect(result?.a).toMatch(/Frag/);
    expect(result?.b).toMatch(/Zapytaj/);
  });

  it("regenerates only the missing side when one hint is already cached", async () => {
    mFindUnique.mockResolvedValueOnce(
      baseMatchRow({ wingmanHintA: "cached-from-earlier", wingmanHintB: null }),
    );
    mCall.mockResolvedValueOnce("Ask Alice about her rock-climbing trip last month.");

    const result = await generateAndSaveWingmanHints("m1");

    expect(mCall).toHaveBeenCalledTimes(1);
    expect(result?.a).toBe("cached-from-earlier");
    expect(result?.b).toMatch(/rock-climbing/);
  });
});

describe("refreshWingmanHintAbout", () => {
  const NOW = new Date("2026-06-10T07:00:00Z");
  const HOUR = 60 * 60 * 1000;
  const mUpdateMany = (prisma.match as unknown as { updateMany: MockFn }).updateMany;

  function scheduled(overrides: Record<string, unknown> = {}) {
    return {
      status: "scheduled",
      agreedTime: new Date(NOW.getTime() + 24 * HOUR),
      userAId: "ua",
      userBId: "ub",
      wingmanSentAt: null,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mUpdate.mockResolvedValue(undefined);
    mUpdateMany.mockResolvedValue({ count: 1 });
  });

  it("rewrites only the tip ABOUT the subject — the one in the partner's slot", async () => {
    mFindUnique
      .mockResolvedValueOnce(scheduled())
      .mockResolvedValueOnce(baseMatchRow({ wingmanHintA: "tip about B, kept" }));
    mCall.mockResolvedValueOnce("Ask her about the synth she is building.");

    expect(await refreshWingmanHintAbout("m1", "ua", NOW)).toBe(true);

    expect(mUpdateMany).toHaveBeenCalledWith({
      where: { id: "m1", status: "scheduled", wingmanSentAt: null },
      data: { wingmanHintB: null },
    });
    expect(mCall).toHaveBeenCalledTimes(1);
    expect(mUpdate).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: {
        wingmanHintA: "tip about B, kept",
        wingmanHintB: "Ask her about the synth she is building.",
      },
    });
  });

  it("leaves a tip that is revealed, about to be, or no longer for a live date", async () => {
    for (const row of [
      scheduled({ wingmanSentAt: new Date(NOW.getTime() - HOUR) }),
      scheduled({ agreedTime: new Date(NOW.getTime() + 1.9 * HOUR) }),
      scheduled({ status: "cancelled" }),
      null,
    ]) {
      mFindUnique.mockResolvedValueOnce(row);
      expect(await refreshWingmanHintAbout("m1", "ua", NOW)).toBe(false);
    }
    expect(mUpdateMany).not.toHaveBeenCalled();
    expect(mCall).not.toHaveBeenCalled();
  });

  it("ignores someone who is not in the match", async () => {
    mFindUnique.mockResolvedValueOnce(scheduled());
    expect(await refreshWingmanHintAbout("m1", "stranger", NOW)).toBe(false);
    expect(mUpdateMany).not.toHaveBeenCalled();
  });
});
