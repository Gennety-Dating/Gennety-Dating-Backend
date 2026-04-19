import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    systemKnowledge: {
      findMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "test-key",
  },
}));

import { prisma } from "@gennety/db";
import {
  buildSystemPrompt,
  fetchKnowledgeBase,
  clearKnowledgeCache,
} from "./prompt-builder.js";

const mockKnowledge = prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>;
const mockUserFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearKnowledgeCache();
});

describe("fetchKnowledgeBase", () => {
  it("returns formatted knowledge entries", async () => {
    mockKnowledge.mockResolvedValue([
      { title: "Zero-Chat Philosophy", content: "No in-app chat." },
      { title: "Match Timing", content: "Weekly batches." },
    ]);

    const result = await fetchKnowledgeBase();
    expect(result).toContain("### Zero-Chat Philosophy");
    expect(result).toContain("No in-app chat.");
    expect(result).toContain("### Match Timing");
    expect(result).toContain("Weekly batches.");
  });

  it("caches results for subsequent calls", async () => {
    mockKnowledge.mockResolvedValue([
      { title: "Test", content: "Cached content." },
    ]);

    await fetchKnowledgeBase();
    await fetchKnowledgeBase();

    expect(mockKnowledge).toHaveBeenCalledTimes(1);
  });

  it("re-fetches after cache is cleared", async () => {
    mockKnowledge.mockResolvedValue([
      { title: "Test", content: "First." },
    ]);

    await fetchKnowledgeBase();
    clearKnowledgeCache();

    mockKnowledge.mockResolvedValue([
      { title: "Test", content: "Second." },
    ]);

    const result = await fetchKnowledgeBase();
    expect(result).toContain("Second.");
    expect(mockKnowledge).toHaveBeenCalledTimes(2);
  });
});

describe("buildSystemPrompt", () => {
  it("assembles persona + knowledge + user context with accurate next batch date", async () => {
    mockKnowledge.mockResolvedValue([
      { title: "Zero-Chat Philosophy", content: "Users NEVER message each other." },
      { title: "Match Timing FAQ", content: "Matches are generated weekly." },
    ]);

    mockUserFind.mockResolvedValue({
      firstName: "Alice",
      universityDomain: "stanford.edu",
      status: "active",
      language: "en",
      matchesAsA: [],
      matchesAsB: [],
    });

    const prompt = await buildSystemPrompt(BigInt(12345));

    // Base persona
    expect(prompt).toContain("Gennety Dating assistant");

    // Knowledge base entries
    expect(prompt).toContain("Zero-Chat Philosophy");
    expect(prompt).toContain("Users NEVER message each other.");
    expect(prompt).toContain("Matches are generated weekly.");

    // User context
    expect(prompt).toContain("Alice");
    expect(prompt).toContain("stanford.edu");
    expect(prompt).toContain("active");
    expect(prompt).toContain("No active match");

    // Next batch date — must contain a real day name, not a hallucinated one
    expect(prompt).toMatch(/Next match batch:.*day/i);
  });

  it("includes active match info when user has a pending proposal", async () => {
    mockKnowledge.mockResolvedValue([]);

    mockUserFind.mockResolvedValue({
      firstName: "Bob",
      universityDomain: "mit.edu",
      status: "active",
      language: "en",
      matchesAsA: [{ status: "proposed", agreedTime: null, venueName: null }],
      matchesAsB: [],
    });

    const prompt = await buildSystemPrompt(BigInt(67890));
    expect(prompt).toContain("pending match proposal");
  });

  it("includes scheduled date details", async () => {
    mockKnowledge.mockResolvedValue([]);

    const agreedTime = new Date("2025-04-20T19:00:00Z");
    mockUserFind.mockResolvedValue({
      firstName: "Carol",
      universityDomain: "oxford.ac.uk",
      status: "active",
      language: "en",
      matchesAsA: [],
      matchesAsB: [{
        status: "scheduled",
        agreedTime,
        venueName: "The Library Cafe",
      }],
    });

    const prompt = await buildSystemPrompt(BigInt(11111));
    expect(prompt).toContain("Date scheduled");
    expect(prompt).toContain("The Library Cafe");
  });

  it("responds in user's language", async () => {
    mockKnowledge.mockResolvedValue([]);

    mockUserFind.mockResolvedValue({
      firstName: "Дима",
      universityDomain: "msu.edu.ru",
      status: "active",
      language: "ru",
      matchesAsA: [],
      matchesAsB: [],
    });

    const prompt = await buildSystemPrompt(BigInt(22222));
    expect(prompt).toContain("Preferred language: ru");
    expect(prompt).toContain("Respond in the user's preferred language (ru)");
  });
});
