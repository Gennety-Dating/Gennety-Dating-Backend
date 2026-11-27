import { describe, expect, it } from "vitest";
import { AGENT_MEMORY_RULES, CONCEPT_RULES, STANCE_RULES, TASTE_CANON, conceptBlock } from "@gennety/shared";
import { joinPromptPart, livePartIndex, splitRuleBlocks } from "./prompt-layout.js";

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

describe("livePartIndex", () => {
  const m = (...roles: string[]) => roles.map((role) => ({ role }));
  it("goes right before the message being answered when the chat has history", () => {
    expect(livePartIndex(m("system", "user", "assistant", "user"))).toBe(3);
    expect(livePartIndex(m("system", "system", "user", "assistant", "user"))).toBe(4);
  });
  it("on a chat's first turn goes after their message, never into the leading system run", () => {
    expect(livePartIndex(m("system", "user"))).toBe(2);
    expect(livePartIndex(m("system", "system", "user"))).toBe(3);
  });
  it("a typed lead before a voice note is history enough", () => {
    expect(livePartIndex(m("system", "user", "user"))).toBe(2);
  });
  it("without a person's message it goes last", () => {
    expect(livePartIndex(m("system"))).toBe(1);
    expect(livePartIndex(m())).toBe(0);
  });
});

describe("joinPromptPart", () => {
  it("drops empty pieces", () => {
    expect(joinPromptPart(["a", null, "", "  ", false, undefined, "b"])).toBe("a\n\nb");
  });
});
