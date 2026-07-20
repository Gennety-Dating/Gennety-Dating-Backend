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
  buildEmbeddingInput,
  saveFallbackProfileAnalysis,
  saveProfileAnalysis,
  buildFallbackProfileAnalysis,
  appendVibeToSummary,
  isEvidenceProfileSummary,
  isValidFastPathSummary,
  parseDumpWithLLM,
} = await import("./profile-analysis.js");
const { callOpenAIJson } = await import("./openai.js");

const emptyEvidenceProfile = {
  schema_version: 2 as const,
  relationships: [],
  emotions_and_conflict: [],
  needs_and_boundaries: [],
  values_in_action: [],
  life_rhythm_and_social_energy: [],
  sustained_interests: [],
  partner_fit: [],
  likely_friction: [],
  grounded_summary: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  profileUpsert.mockResolvedValue({});
  executeRaw.mockResolvedValue(1);
  profileUpdate.mockResolvedValue({});
});

describe("evidence-first AI-memory parsing", () => {
  it("accepts a fully sparse V2 object without asking another model to fill it", async () => {
    const parsed = await parseDumpWithLLM(
      JSON.stringify(emptyEvidenceProfile),
      "Alice",
      "en",
    );

    expect(parsed).toEqual(emptyEvidenceProfile);
    expect(callOpenAIJson).not.toHaveBeenCalled();
  });

  it("accepts grounded evidence items and rejects unsupported summaries", () => {
    const grounded = {
      ...emptyEvidenceProfile,
      relationships: [
        {
          signal: "Needs time before discussing conflict",
          basis: "Described pausing before two difficult conversations",
          kind: "pattern",
        },
      ],
      grounded_summary: "They tend to slow conflict down before responding.",
    };
    expect(isEvidenceProfileSummary(grounded)).toBe(true);
    expect(isValidFastPathSummary(grounded)).toBe(true);
    expect(
      isEvidenceProfileSummary({
        ...emptyEvidenceProfile,
        grounded_summary: "A generic flattering portrait without evidence.",
      }),
    ).toBe(false);
  });

  it("accepts real section evidence even when grounded_summary is an empty string", () => {
    // Some models emit "" instead of null for "no summary"; that must not
    // discard a payload that carries real evidence.
    const withEmptySummary = {
      ...emptyEvidenceProfile,
      sustained_interests: [
        {
          signal: "Plays piano regularly",
          basis: "Mentioned weekly practice across several months",
          kind: "pattern",
        },
      ],
      grounded_summary: "   ",
    };
    expect(isEvidenceProfileSummary(withEmptySummary)).toBe(true);
    expect(isValidFastPathSummary(withEmptySummary)).toBe(true);
  });

  it("keeps a complete legacy Magic Prompt response backward-compatible", () => {
    expect(
      isValidFastPathSummary({
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
      }),
    ).toBe(true);
  });

  it("does not persist arbitrary long prose when repair cannot validate it", async () => {
    vi.mocked(callOpenAIJson).mockResolvedValueOnce(null);
    const client = { embed: vi.fn() };

    const result = await analyseAndSaveProfile(
      "user-invalid",
      "This is unrelated prose. ".repeat(30),
      client,
    );

    expect(result).toEqual({ parsed: null, embeddingSaved: false });
    expect(client.embed).not.toHaveBeenCalled();
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it("rejects partial JSON when the repair service fails", async () => {
    vi.mocked(callOpenAIJson).mockRejectedValueOnce(new Error("repair unavailable"));
    const client = { embed: vi.fn() };

    const result = await analyseAndSaveProfile(
      "user-partial",
      JSON.stringify({ relationships: [], grounded_summary: null }),
      client,
    );

    expect(result).toEqual({ parsed: null, embeddingSaved: false });
    expect(client.embed).not.toHaveBeenCalled();
    expect(profileUpsert).not.toHaveBeenCalled();
  });

  it("saves a sparse V2 import without creating a meaningless empty embedding", async () => {
    const client = { embed: vi.fn() };

    const result = await analyseAndSaveProfile(
      "user-sparse",
      JSON.stringify(emptyEvidenceProfile),
      client,
    );

    expect(result.parsed).toEqual(emptyEvidenceProfile);
    expect(result.embeddingSaved).toBe(false);
    expect(client.embed).not.toHaveBeenCalled();
    expect(profileUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ psychologicalSummary: "" }),
      }),
    );
  });
});

describe("buildEmbeddingInput", () => {
  it("retains every evidence signal but not its private basis", () => {
    const text = buildEmbeddingInput(
      {
        ...emptyEvidenceProfile,
        relationships: [
          {
            signal: "Prefers calm repair after conflict",
            basis: "Discussed reconnecting after cooling down",
            kind: "pattern",
          },
        ],
        values_in_action: [
          {
            signal: "Protects time for close friendships",
            basis: "Repeatedly chose friends over optional work events",
            kind: "pattern",
          },
        ],
        grounded_summary: "Values calm repair and durable close relationships.",
      },
      "ignored",
    );

    expect(text).toContain("Prefers calm repair after conflict");
    expect(text).toContain("Protects time for close friendships");
    expect(text).not.toContain("cooling down");
    expect(text).not.toContain("optional work events");
  });

  it("keeps previously dropped legacy values and style signals", () => {
    const text = buildEmbeddingInput(
      {
        personality_traits: ["curious", "warm", "direct"],
        communication_style: "Direct.",
        interests: ["music", "travel"],
        values: ["honesty", "kindness"],
        attachment_style: "secure",
        social_energy: "ambivert",
        humor_style: "dry",
        ideal_partner: "Thoughtful.",
        dealbreakers: ["dishonesty"],
        summary: "Grounded.",
      },
      "ignored",
    );
    expect(text).toContain("Values: honesty, kindness");
    expect(text).toContain("Attachment: secure");
    expect(text).toContain("Social energy: ambivert");
    expect(text).toContain("Humor: dry");
  });
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
