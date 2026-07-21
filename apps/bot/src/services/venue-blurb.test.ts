import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./openai.js", () => ({
  callOpenAIText: vi.fn(),
}));

import { callOpenAIText } from "./openai.js";
import { generateVenueBlurb } from "./venue-blurb.js";
import type { Venue } from "./venue.js";

type MockFn = ReturnType<typeof vi.fn>;
const mCall = callOpenAIText as unknown as MockFn;

function venue(overrides: Partial<Venue> = {}): Venue {
  return {
    name: "Kavovary on the Square",
    address: "14 Khreshchatyk St, Kyiv",
    googleMapsUri: "https://maps.google.com/?cid=1",
    editorialSummary: "Cosy specialty coffee bar with a quiet upstairs nook.",
    rating: 4.6,
    userRatingCount: 412,
    primaryType: "coffee_shop",
    ...overrides,
  };
}

describe("generateVenueBlurb", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the cleaned model blurb when valid", async () => {
    mCall.mockResolvedValueOnce(
      "A calm specialty coffee bar — easy to talk and get to know each other.",
    );
    const out = await generateVenueBlurb({
      venue: venue(),
      category: "cafe",
      keywords: ["quiet"],
      language: "en",
    });
    expect(out).toBe(
      "A calm specialty coffee bar — easy to talk and get to know each other.",
    );
  });

  it("collapses whitespace/newlines and strips wrapping quotes", async () => {
    mCall.mockResolvedValueOnce('  "A quiet\n  coffee spot,\teasy to chat."  ');
    const out = await generateVenueBlurb({
      venue: venue(),
      category: "cafe",
      keywords: [],
      language: "en",
    });
    expect(out).toBe("A quiet coffee spot, easy to chat.");
  });

  it("grounds the prompt on venue facts without treating the requested vibe as evidence", async () => {
    mCall.mockResolvedValueOnce("A calm coffee bar, easy to talk.");
    await generateVenueBlurb({
      venue: venue(),
      category: "cafe",
      keywords: ["quiet", "vegan"],
      language: "en",
    });
    const systemPrompt = mCall.mock.calls[0]![0] as string;
    expect(systemPrompt).toContain("Cosy specialty coffee bar");
    expect(systemPrompt).toContain("4.6");
    expect(systemPrompt).not.toContain("quiet, vegan");
  });

  it("falls back to a generic line when the model returns nothing (no API key)", async () => {
    mCall.mockResolvedValueOnce("");
    const out = await generateVenueBlurb({
      venue: venue({ editorialSummary: null, rating: null, userRatingCount: null }),
      category: "cafe",
      keywords: [],
      language: "en",
    });
    expect(out).toBe("A verified public place selected with both of your routes in mind.");
  });

  it("rejects over-long output, a question, or a URL leak → fallback", async () => {
    const longText = "word ".repeat(60).trim();
    mCall
      .mockResolvedValueOnce(longText)
      .mockResolvedValueOnce("Want to grab a coffee here?")
      .mockResolvedValueOnce("See it at http://example.com");

    const en = { venue: venue(), category: "cafe" as const, keywords: [], language: "en" as const };
    expect(await generateVenueBlurb(en)).toMatch(/verified public place/);
    expect(await generateVenueBlurb(en)).toMatch(/verified public place/);
    expect(await generateVenueBlurb(en)).toMatch(/verified public place/);
  });

  it("uses the per-language fallback (ru/de/pl)", async () => {
    mCall.mockResolvedValue("");
    expect(
      await generateVenueBlurb({ venue: venue(), category: "cafe", keywords: [], language: "ru" }),
    ).toMatch(/Проверенное публичное/);
    expect(
      await generateVenueBlurb({ venue: venue(), category: "cafe", keywords: [], language: "de" }),
    ).toMatch(/überprüfter öffentlicher Ort/);
    expect(
      await generateVenueBlurb({ venue: venue(), category: "cafe", keywords: [], language: "pl" }),
    ).toMatch(/Sprawdzone publiczne miejsce/);
  });

  it("survives an OpenAI throw → fallback (never blocks finalization)", async () => {
    mCall.mockRejectedValueOnce(new Error("network"));
    const out = await generateVenueBlurb({
      venue: venue(),
      category: "cafe",
      keywords: [],
      language: "en",
    });
    expect(out).toMatch(/verified public place/);
  });
});
