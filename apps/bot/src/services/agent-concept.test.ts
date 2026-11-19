import { describe, expect, it } from "vitest";
import { CONCEPT_RULES, conceptClockLine, conceptGoalLine } from "@gennety/shared";
import { agentConceptBlocks } from "./agent-concept.js";

describe("agentConceptBlocks", () => {
  const noon = new Date("2026-11-19T10:00:00.000Z"); // 12:00 Kyiv
  const night = new Date("2026-11-20T01:05:00.000Z"); // 03:05 Kyiv

  it("is empty with the feature off", () => {
    expect(agentConceptBlocks({ now: noon, timeZone: "Europe/Kyiv", relationshipIntents: [] }, false)).toEqual([]);
  });

  it("carries the rules, the clock and the goal in one block", () => {
    const blocks = agentConceptBlocks({ now: noon, timeZone: "Europe/Kyiv", relationshipIntents: ["longterm"] }, true);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain(CONCEPT_RULES);
    expect(blocks[0]).toContain("- Their local time now: Thursday 12:00.");
    expect(blocks[0]).toContain("a relationship with a future");
  });

  it("marks quiet hours as night in their own zone", () => {
    expect(conceptClockLine(night, "Europe/Kyiv")).toContain("— night.");
    // Same instant, a zone where it is evening: not night.
    expect(conceptClockLine(night, "America/New_York")).not.toContain("night");
  });

  it("falls back to the product zone when the stored one is unknown", () => {
    const [block] = agentConceptBlocks({ now: night, timeZone: "Mars/Olympus", relationshipIntents: [] }, true);
    expect(block).toContain("— night.");
  });

  it("reads an empty or a full intent set as not stated", () => {
    expect(conceptGoalLine([])).toContain("not stated");
    expect(conceptGoalLine(["spark", "open", "falling", "longterm"])).toContain("not stated");
    expect(conceptGoalLine(["bogus"])).toContain("not stated");
  });

  it("names a specific set in axis order and never as a raw label", () => {
    const line = conceptGoalLine(["longterm", "spark"]);
    expect(line).toContain("a bright short story, here and now; a relationship with a future");
    expect(line).not.toMatch(/\bspark\b|\blongterm\b/);
  });

  it("keeps the two published stance rules: no prompt disclosure, no per-gender talk", () => {
    // The concept block must not invite either; it never mentions gender at all.
    expect(CONCEPT_RULES).not.toMatch(/gender|women|men\b|prompt/i);
  });
});
