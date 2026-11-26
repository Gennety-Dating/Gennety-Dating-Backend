import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_RULES, CONCEPT_RULES, STANCE_RULES, TASTE_CANON, conceptBlock } from "@gennety/shared";
import { joinPromptPart, splitRuleBlocks, steppedWindowSize } from "./prompt-layout.js";

describe("splitRuleBlocks", () => {
  it("keeps every rule and every live piece, each in its own order", () => {
    const concept = conceptBlock({
      now: new Date("2026-11-26T11:13:00.000Z"),
      timeZone: "Europe/Kyiv",
      relationshipIntents: [],
    });
    const { rules, live } = splitRuleBlocks([AGENT_MEMORY_RULES, "NOTES", TASTE_CANON, "VIDEO", STANCE_RULES, null, concept]);
    expect(rules).toEqual([AGENT_MEMORY_RULES, TASTE_CANON, STANCE_RULES, CONCEPT_RULES]);
    expect(live[0]).toBe("NOTES");
    expect(live[1]).toBe("VIDEO");
    expect(live[2]!.startsWith("### This person, for the rules above")).toBe(true);
    // Nothing lost: the concept block is its rules plus its live remainder.
    expect(`${CONCEPT_RULES}\n\n${live[2]}`).toBe(concept);
  });

  it("a block that only mentions a rule text later is live", () => {
    expect(splitRuleBlocks([`intro\n${TASTE_CANON}`]).rules).toEqual([]);
  });
});

describe("steppedWindowSize", () => {
  it("never shows fewer rows than the minimum and starts on a step", () => {
    for (let total = 0; total <= 200; total++) {
      const size = steppedWindowSize(total, 30);
      expect(size).toBe(total <= 30 ? total : size);
      if (total > 30) {
        expect(size).toBeGreaterThanOrEqual(30);
        expect(size).toBeLessThanOrEqual(39);
        expect((total - size) % 10).toBe(0);
      }
    }
  });
});

describe("joinPromptPart", () => {
  it("drops empty pieces", () => {
    expect(joinPromptPart(["a", null, "", "  ", false, undefined, "b"])).toBe("a\n\nb");
  });
});
