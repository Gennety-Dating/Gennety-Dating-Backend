import { describe, it, expect, vi } from "vitest";
import {
  parseVibe,
  mergeParsed,
  VENUE_CATEGORY_WHITELIST,
} from "./vibe-parser.js";

// Helper: a deterministic fake LLM that echoes whatever the caller asks
// for, so we can isolate the deny-list / whitelist layers from any real
// model behaviour.
const fakeLlm = (
  payload: { category: string; keywords: string[]; safe: boolean } | null,
) => vi.fn().mockResolvedValue(payload);

describe("vibe-parser: deny-list short-circuits BEFORE the LLM", () => {
  it("'hotel room' returns safe=false, category=cafe, no LLM call", async () => {
    const llm = fakeLlm(null);
    const out = await parseVibe("let's grab a hotel room", llm);
    expect(out.category).toBe("cafe");
    expect(out.keywords).toEqual([]);
    expect(out.safe).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });

  it("'my place' / 'your place' / 'my apartment' all trigger the override", async () => {
    const llm = fakeLlm(null);
    for (const phrase of [
      "come to my place",
      "meet at your apartment",
      "just chill at my flat",
      "her dorm room",
    ]) {
      const out = await parseVibe(phrase, llm);
      expect(out.safe).toBe(false);
      expect(out.category).toBe("cafe");
    }
    expect(llm).not.toHaveBeenCalled();
  });

  it("sauna / banya / bathhouse / massage all trigger", async () => {
    const llm = fakeLlm(null);
    for (const p of ["sauna", "banya", "bath house", "massage"]) {
      const out = await parseVibe(p, llm);
      expect(out.safe).toBe(false);
      expect(out.category).toBe("cafe");
    }
  });

  it("empty string yields safe default without calling the LLM", async () => {
    const llm = fakeLlm(null);
    const out = await parseVibe("   ", llm);
    expect(out.category).toBe("cafe");
    expect(out.safe).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });
});

describe("vibe-parser: LLM path + whitelist coercion", () => {
  it("accepts a whitelisted category from the LLM", async () => {
    const llm = fakeLlm({ category: "restaurant", keywords: ["vegan"], safe: true });
    const out = await parseVibe("vegan dinner spot", llm);
    expect(out.category).toBe("restaurant");
    expect(out.keywords).toEqual(["vegan"]);
    expect(out.safe).toBe(true);
  });

  it("coerces a non-whitelisted category to cafe", async () => {
    const llm = fakeLlm({ category: "nightclub", keywords: ["edm"], safe: true });
    const out = await parseVibe("something fun", llm);
    expect(out.category).toBe("cafe");
  });

  it("drops LLM output when the emitted keywords hit the deny-list", async () => {
    const llm = fakeLlm({
      category: "restaurant",
      keywords: ["hotel brunch"],
      safe: true,
    });
    const out = await parseVibe("nice restaurant", llm);
    expect(out.category).toBe("cafe");
    expect(out.keywords).toEqual([]);
    expect(out.safe).toBe(false);
  });

  it("LLM unreachable → safe fallback (still cafe)", async () => {
    const llm = fakeLlm(null);
    const out = await parseVibe("coffee please", llm);
    expect(out.category).toBe("cafe");
    expect(out.safe).toBe(true); // non-deny, LLM unreachable ≠ unsafe
  });

  it("caps keywords at 3", async () => {
    const llm = fakeLlm({
      category: "cafe",
      keywords: ["a", "b", "c", "d", "e"],
      safe: true,
    });
    const out = await parseVibe("anything", llm);
    expect(out.keywords.length).toBeLessThanOrEqual(3);
  });
});

describe("vibe-parser: mergeParsed picks the safer category when users disagree", () => {
  it("A='coffee' + B='hotel room' → category='cafe' (B dropped to cafe via deny-list, union wins)", async () => {
    // This is the headline safety test from the spec.
    const a = await parseVibe("coffee", fakeLlm({ category: "coffee_shop", keywords: ["coffee"], safe: true }));
    const b = await parseVibe("hotel room", fakeLlm(null));
    const merged = mergeParsed(a, b);
    expect(VENUE_CATEGORY_WHITELIST).toContain(merged.category);
    // Because B was coerced to cafe, merged category must NOT be hotel or any
    // non-whitelist value. cafe is safer than coffee_shop in our ordering.
    expect(merged.category).toBe("cafe");
    expect(merged.keywords).toEqual(["coffee"]);
  });

  it("same category on both sides is preserved", () => {
    const merged = mergeParsed(
      { category: "park", keywords: ["quiet"], safe: true },
      { category: "park", keywords: ["walk"], safe: true },
    );
    expect(merged.category).toBe("park");
    expect(merged.keywords.sort()).toEqual(["quiet", "walk"].sort());
  });

  it("falls back to cafe when the two users disagree (strict intersection)", () => {
    const merged = mergeParsed(
      { category: "lounge", keywords: [], safe: true },
      { category: "museum", keywords: [], safe: true },
    );
    // No consensus → safest public default.
    expect(merged.category).toBe("cafe");
  });

  it("A=restaurant + B=park → cafe (no arbitrary pick from either user)", () => {
    const merged = mergeParsed(
      { category: "restaurant", keywords: ["vegan"], safe: true },
      { category: "park", keywords: ["walk"], safe: true },
    );
    expect(merged.category).toBe("cafe");
    // Keywords from both still flow through — radius + type handle the rest.
    expect(merged.keywords.sort()).toEqual(["vegan", "walk"].sort());
  });

  it("dedupes the keyword union and caps at 3", () => {
    const merged = mergeParsed(
      { category: "cafe", keywords: ["vegan", "quiet"], safe: true },
      { category: "cafe", keywords: ["quiet", "jazz", "wifi"], safe: true },
    );
    expect(merged.keywords.length).toBeLessThanOrEqual(3);
    expect(new Set(merged.keywords).size).toBe(merged.keywords.length);
  });
});
