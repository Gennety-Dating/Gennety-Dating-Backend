import { beforeEach, describe, expect, it, vi } from "vitest";

const profileUpsert = vi.fn();
const executeRaw = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    profile: {
      upsert: profileUpsert,
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
} = await import("./profile-analysis.js");

beforeEach(() => {
  vi.clearAllMocks();
  profileUpsert.mockResolvedValue({});
  executeRaw.mockResolvedValue(1);
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
