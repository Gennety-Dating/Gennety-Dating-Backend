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
    match: {
      findFirst: vi.fn(),
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
  describeActiveMatch,
  type ActiveMatchView,
} from "./prompt-builder.js";
import type { PlaybookFeatures } from "./product-playbook.js";

const mockKnowledge = prisma.systemKnowledge.findMany as ReturnType<typeof vi.fn>;
const mockUserFind = prisma.user.findUnique as ReturnType<typeof vi.fn>;
const mockMatchFindFirst = prisma.match.findFirst as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  clearKnowledgeCache();
  mockMatchFindFirst.mockResolvedValue(null);
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

  it("includes the code-owned product playbook with the find-each-other section", async () => {
    mockKnowledge.mockResolvedValue([]);
    mockUserFind.mockResolvedValue({
      firstName: "Eve",
      universityDomain: "kcl.ac.uk",
      status: "active",
      language: "en",
      matchesAsA: [],
      matchesAsB: [],
    });

    const prompt = await buildSystemPrompt(BigInt(33333));
    expect(prompt).toContain("## Product Playbook");
    expect(prompt).toContain("How to find each other at the venue");
    expect(prompt).toContain("Optional features enabled: none");
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

  it("includes pending rejection follow-up for a proposed self-decline", async () => {
    mockKnowledge.mockResolvedValue([]);
    mockMatchFindFirst.mockResolvedValue({ id: "match-1" });

    mockUserFind.mockResolvedValue({
      id: "uid-A",
      firstName: "Alice",
      universityDomain: "stanford.edu",
      status: "active",
      language: "en",
      matchesAsA: [{ status: "proposed", agreedTime: null, venueName: null }],
      matchesAsB: [],
    });

    const prompt = await buildSystemPrompt(BigInt(12345));

    expect(mockMatchFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { in: ["proposed", "cancelled", "expired"] },
          OR: expect.arrayContaining([
            expect.objectContaining({
              userAId: "uid-A",
              acceptedByA: false,
              rejectionReasonA: null,
            }),
          ]),
        }),
      }),
    );
    expect(prompt).toContain("Pending Rejection Follow-up");
    expect(prompt).toContain("match-1");
    expect(prompt).toContain("voice note transcript");
  });
});

describe("describeActiveMatch", () => {
  const NOW = new Date("2026-06-23T12:00:00Z");
  const FEATURES_OFF: PlaybookFeatures = {
    coordination: false,
    venueChange: false,
    tickets: false,
  };
  const FEATURES_ON: PlaybookFeatures = {
    coordination: true,
    venueChange: true,
    tickets: true,
  };

  function scheduled(overrides: Partial<ActiveMatchView> = {}): ActiveMatchView {
    return {
      status: "scheduled",
      agreedTime: new Date("2026-06-23T16:00:00Z"), // +4h from NOW
      venueName: "Kaffa",
      venueAddress: "Velyka Vasylkivska 12",
      venueGoogleMapsUri: "https://maps.google.com/?cid=1",
      ticketStatus: "completed",
      coordOfferSentAt: null,
      proxyOpenedAt: null,
      proxyClosesAt: null,
      proxyClosedAt: null,
      venueChangeStatus: null,
      partnerFirstName: "Sasha",
      ...overrides,
    };
  }

  it("returns the waiting line for no active match", () => {
    expect(describeActiveMatch(null, NOW, "en-US", FEATURES_OFF)).toContain(
      "No active match",
    );
  });

  it("surfaces partner name, venue and time-until for a scheduled date", () => {
    const text = describeActiveMatch(scheduled(), NOW, "en-US", FEATURES_OFF);
    expect(text).toContain("Date scheduled");
    expect(text).toContain("Kaffa".slice(0, 4)); // venue name present
    expect(text).toContain("Partner: Sasha");
    expect(text).toContain("Time until the date: in ~4h");
    expect(text).toContain("Velyka Vasylkivska 12");
  });

  it("falls back to the venue pin for find-each-other when coordination is OFF", () => {
    const text = describeActiveMatch(scheduled(), NOW, "en-US", FEATURES_OFF);
    expect(text).toContain("Find-each-other: have them go to the venue pin");
    expect(text).not.toContain("Enter chat");
  });

  it("reports the proxy chat as open NOW when the window is live", () => {
    const text = describeActiveMatch(
      scheduled({
        proxyOpenedAt: new Date("2026-06-23T11:50:00Z"),
        proxyClosesAt: new Date("2026-06-23T18:00:00Z"),
      }),
      NOW,
      "en-US",
      FEATURES_ON,
    );
    expect(text).toContain("OPEN NOW");
    expect(text).toContain("Enter chat");
  });

  it("announces when the proxy chat will open before the date", () => {
    const text = describeActiveMatch(scheduled(), NOW, "en-US", FEATURES_ON);
    expect(text).toContain("Find-each-other:");
    expect(text).toContain("30 min before");
  });

  it("describes the venue-selection sub-stage", () => {
    const text = describeActiveMatch(
      scheduled({ status: "negotiating_venue", agreedTime: null, venueName: null }),
      NOW,
      "en-US",
      FEATURES_OFF,
    );
    expect(text).toContain("choosing the meeting place");
    expect(text).toContain("Partner: Sasha");
  });
});
