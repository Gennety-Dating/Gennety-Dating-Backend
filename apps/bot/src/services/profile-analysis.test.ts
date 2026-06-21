import { beforeEach, describe, expect, it, vi } from "vitest";

const profileUpsert = vi.fn();
const executeRaw = vi.fn();
const profileFindUnique = vi.fn();
const profileUpdate = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: {
      upsert: profileUpsert,
      findUnique: profileFindUnique,
      update: profileUpdate,
    },
    $executeRaw: executeRaw,
  },
}));

vi.mock("../config.js", () => ({
  env: {
    OPENAI_API_KEY: "test-key",
  },
}));

vi.mock("./openai.js", () => ({
  callOpenAIJson: vi.fn(),
}));

const {
  analyseAndSaveProfile,
  saveFallbackProfileAnalysis,
  saveProfileAnalysis,
  buildFallbackProfileAnalysis,
  appendVibeToSummary,
} = await import("./profile-analysis.js");

beforeEach(() => {
  vi.clearAllMocks();
  profileUpsert.mockResolvedValue({});
  executeRaw.mockResolvedValue(1);
  profileUpdate.mockResolvedValue({});
});

describe("profile analysis embedding retry", () => {
  it("queues an AI-memory profile for retry when embedding generation fails", async () => {
    const client = {
      embed: vi.fn().mockRejectedValue(new Error("OpenAI unavailable")),
    };
    const dump = JSON.stringify({
      personality_traits: ["curious", "warm", "direct"],
      communication_style: "Reflective and direct.",
      interests: ["music", "travel"],
      values: ["honesty", "kindness"],
      attachment_style: "secure",
      social_energy: "ambivert",
      humor_style: "dry",
      ideal_partner: "Someone thoughtful.",
      dealbreakers: ["dishonesty"],
      summary: "A thoughtful and curious person.",
    });

    const result = await analyseAndSaveProfile("user-ai", dump, client);

    expect(result.embeddingSaved).toBe(false);
    expect(profileUpsert).toHaveBeenCalledWith({
      where: { userId: "user-ai" },
      create: expect.objectContaining({
        userId: "user-ai",
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
    });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("queues a fallback profile for retry when embedding generation fails", async () => {
    const client = {
      embed: vi.fn().mockRejectedValue(new Error("OpenAI unavailable")),
    };

    const result = await saveFallbackProfileAnalysis(
      "user-fallback",
      {
        firstName: "Alice",
        age: 21,
        gender: "female",
        preference: "men",
        height: 165,
        ethnicity: null,
        hobbies: [],
        partnerPreferences: "Someone kind and funny.",
        homeCityKey: "ua:kyiv",
      },
      client,
    );

    expect(result.embeddingSaved).toBe(false);
    expect(profileUpsert).toHaveBeenCalledWith({
      where: { userId: "user-fallback" },
      create: expect.objectContaining({
        userId: "user-fallback",
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
    });
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("clears retry state only when the generated vector is persisted", async () => {
    const embedding = new Array(1536).fill(0.1);

    const saved = await saveProfileAnalysis("user-success", "summary", embedding);

    expect(saved).toBe(true);
    expect(profileUpsert).toHaveBeenCalledWith({
      where: { userId: "user-success" },
      create: expect.objectContaining({
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
      update: expect.objectContaining({
        embeddingDirty: true,
        embeddingDirtyAt: expect.any(Date),
      }),
    });
    expect(executeRaw).toHaveBeenCalledTimes(1);
  });
});

describe("buildFallbackProfileAnalysis — de-dup + vibe", () => {
  const base = {
    firstName: "Alice",
    age: 21,
    gender: "female",
    preference: "men",
    height: 165,
    ethnicity: null,
    hobbies: ["cooking", "hiking"],
    partnerPreferences: "Someone kind and funny.",
    homeCityKey: "ua:kyiv",
  };

  it("excludes demographics already scored elsewhere (age/gender/height/city/name)", () => {
    const text = buildFallbackProfileAnalysis(base);
    expect(text).not.toMatch(/Alice/);
    expect(text).not.toMatch(/Age:/);
    expect(text).not.toMatch(/Gender:/);
    expect(text).not.toMatch(/Height:/);
    expect(text).not.toMatch(/Dating city:/);
    // Real open-ended signal is kept.
    expect(text).toContain("cooking, hiking");
    expect(text).toContain("Someone kind and funny.");
  });

  it("folds the vibe answers into the embedding text", () => {
    const text = buildFallbackProfileAnalysis({
      ...base,
      fridayVibe: "quiet dinner then a film at home with one close friend",
      vibeFocus: "who's with me",
    });
    expect(text).toContain("Ideal Friday night: quiet dinner");
    expect(text).toContain("What matters most on a night out: who's with me");
  });
});

describe("appendVibeToSummary", () => {
  it("appends the vibe block and re-marks the embedding dirty", async () => {
    profileFindUnique.mockResolvedValue({ psychologicalSummary: "Existing magic-prompt summary." });
    await appendVibeToSummary("user-acc", "club night with friends", "the energy");
    expect(profileUpdate).toHaveBeenCalledTimes(1);
    const arg = profileUpdate.mock.calls[0]![0];
    expect(arg.data.psychologicalSummary).toContain("Existing magic-prompt summary.");
    expect(arg.data.psychologicalSummary).toContain("Ideal Friday night: club night with friends");
    expect(arg.data.embeddingDirty).toBe(true);
    expect(arg.data.embeddingDirtyAt).toBeInstanceOf(Date);
  });

  it("is idempotent when the block is already present", async () => {
    const block = "Ideal Friday night: club night";
    profileFindUnique.mockResolvedValue({ psychologicalSummary: `Summary.\n${block}` });
    await appendVibeToSummary("user-acc", "club night", null);
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it("no-ops when there is no vibe text", async () => {
    await appendVibeToSummary("user-acc", "  ", null);
    expect(profileFindUnique).not.toHaveBeenCalled();
    expect(profileUpdate).not.toHaveBeenCalled();
  });
});
