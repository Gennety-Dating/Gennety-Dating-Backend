import { describe, expect, it } from "vitest";
import { STANCE_RULES } from "@gennety/shared";
import { agentStanceBlocks } from "./agent-stances.js";

describe("agentStanceBlocks", () => {
  const turn = (texts: string[], gender: string | null = "female", preference: string | null = "men") => ({
    recentUserTexts: texts,
    gender,
    preference,
  });

  it("is empty with the feature off", () => {
    expect(agentStanceBlocks(turn(["что думаешь про бдсм"]), false)).toEqual([]);
  });

  it("always carries the rules, and the stance only when named", () => {
    expect(agentStanceBlocks(turn(["привет"]), true)).toEqual([STANCE_RULES]);
    const blocks = agentStanceBlocks(turn(["что думаешь про бдсм"]), true);
    expect(blocks).toHaveLength(2);
    expect(blocks[1]).toContain("kinks:");
    expect(blocks[1]).toContain("woman dating men");
  });

  it("reads the previous message too, so a follow-up keeps the topic", () => {
    const blocks = agentStanceBlocks(turn(["а парню ты сказал бы так же?", "он хочет открытые отношения"]), true);
    expect(blocks[1]).toContain("open-relationships:");
  });

  it("does not look further back than the lookback", () => {
    const blocks = agentStanceBlocks(turn(["ок", "понятно", "он хочет открытые отношения"]), true);
    expect(blocks).toEqual([STANCE_RULES]);
  });
});
