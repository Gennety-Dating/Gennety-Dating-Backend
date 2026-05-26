import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("./openai.js", () => ({
  callOpenAIText: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { callOpenAIText } from "./openai.js";
import { generateAndSaveWingmanHints } from "./wingman-hint.js";

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
