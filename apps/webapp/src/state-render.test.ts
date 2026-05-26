import { describe, it, expect } from "vitest";
import { classifyDaySlots, classifySlot } from "./state-render.js";

describe("classifySlot", () => {
  const A = "2026-05-09T19:00:00.000Z";
  const B = "2026-05-10T19:00:00.000Z";

  it("returns 'empty' when neither side marked the slot", () => {
    expect(classifySlot(A, new Set(), new Set())).toBe("empty");
  });

  it("returns 'mine' when only the current user marked it", () => {
    expect(classifySlot(A, new Set([A]), new Set())).toBe("mine");
  });

  it("returns 'peer' when only the partner marked it (drives the banner CTA)", () => {
    expect(classifySlot(A, new Set(), new Set([A]))).toBe("peer");
  });

  it("returns 'overlap' when both sides marked it (drives the lock-in handoff)", () => {
    expect(classifySlot(A, new Set([A]), new Set([A]))).toBe("overlap");
  });

  it("classifies independently across slots in the same grid", () => {
    const mine = new Set([A]);
    const peer = new Set([B]);
    expect(classifySlot(A, mine, peer)).toBe("mine");
    expect(classifySlot(B, mine, peer)).toBe("peer");
    expect(classifySlot("2026-05-11T19:00:00.000Z", mine, peer)).toBe("empty");
  });
});

describe("classifyDaySlots", () => {
  const A = "2026-05-09T17:30:00.000Z";
  const B = "2026-05-09T18:00:00.000Z";
  const C = "2026-05-10T18:00:00.000Z";

  it("returns 'mixed' when both sides picked the same day but different times", () => {
    expect(classifyDaySlots([A, B], new Set([A]), new Set([B]))).toBe("mixed");
  });

  it("keeps exact same-day time matches as overlap", () => {
    expect(classifyDaySlots([A, B], new Set([A]), new Set([A, B]))).toBe("overlap");
  });

  it("still separates mine, peer, and empty days", () => {
    expect(classifyDaySlots([A, B], new Set([A]), new Set([C]))).toBe("mine");
    expect(classifyDaySlots([A, B], new Set([C]), new Set([B]))).toBe("peer");
    expect(classifyDaySlots([A, B], new Set([C]), new Set())).toBe("empty");
  });
});
