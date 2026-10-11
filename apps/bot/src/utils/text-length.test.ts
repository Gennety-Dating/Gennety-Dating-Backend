import { describe, expect, it } from "vitest";
import { exceedsVisibleLength, graphemeLength } from "./text-length.js";

describe("graphemeLength", () => {
  it("counts what a person sees, like Swift's String.count", () => {
    expect(graphemeLength("abc")).toBe(3);
    expect(graphemeLength("❤️")).toBe(1);
    expect(graphemeLength("👍🏽")).toBe(1);
    expect(graphemeLength("👨‍👩‍👧‍👦")).toBe(1);
    expect(graphemeLength("🇺🇦")).toBe(1);
  });
});

describe("exceedsVisibleLength", () => {
  it("never refuses what iOS allowed: N emoji under a limit of N", () => {
    expect(exceedsVisibleLength("👍🏽".repeat(10), 10)).toBe(false);
    expect(exceedsVisibleLength("👍🏽".repeat(11), 10)).toBe(true);
  });

  it("plain text is judged by length", () => {
    expect(exceedsVisibleLength("a".repeat(10), 10)).toBe(false);
    expect(exceedsVisibleLength("a".repeat(11), 10)).toBe(true);
  });

  it("caps the raw size, so one grapheme cannot carry a megabyte of marks", () => {
    const zalgo = `a${"́".repeat(100)}`;
    expect(graphemeLength(zalgo)).toBe(1);
    expect(exceedsVisibleLength(zalgo, 10)).toBe(true);
  });
});
