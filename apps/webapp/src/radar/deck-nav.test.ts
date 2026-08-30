import { describe, expect, it } from "vitest";
import type { RadarAnswerInput } from "../api.js";
import {
  TAP_LOCKOUT_MS,
  canStepBack,
  shouldAcceptTap,
  stepBack,
  type DeckNavState,
} from "./deck-nav.js";

const answer = (photoId: string): RadarAnswerInput => ({
  photoId,
  verdict: "like",
  chipId: null,
});

const rating = (n: number): DeckNavState => ({
  index: n,
  answers: Array.from({ length: n }, (_, i) => answer(`f0${i + 1}`)),
  phase: "rating",
});

describe("canStepBack", () => {
  it("is false on the very first card — there is nothing to undo", () => {
    expect(canStepBack(rating(0))).toBe(false);
  });

  it("is true once a card has been answered", () => {
    expect(canStepBack(rating(1))).toBe(true);
  });

  it("is true with the reason panel open even on the first card", () => {
    // The verdict is chosen but not recorded yet, so there IS something to
    // take back — the user's own pending answer.
    expect(canStepBack({ ...rating(0), phase: "chips" })).toBe(true);
  });
});

describe("stepBack from the reason-chip panel", () => {
  it("cancels the pending verdict and re-offers the SAME card", () => {
    const before: DeckNavState = { ...rating(3), phase: "chips" };
    const after = stepBack(before);
    expect(after.phase).toBe("rating");
    expect(after.index).toBe(3);
    // The verdict that opened the panel was never recorded, so nothing is
    // popped here. Popping would silently discard the previous card's answer.
    expect(after.answers).toEqual(before.answers);
  });
});

describe("stepBack from the rating phase", () => {
  it("pops exactly one answer and re-asks the previous card", () => {
    const after = stepBack(rating(3));
    expect(after.index).toBe(2);
    expect(after.answers.map((a) => a.photoId)).toEqual(["f01", "f02"]);
    expect(after.phase).toBe("rating");
  });

  it("re-asking replaces rather than appends a second answer for one photo", () => {
    const back = stepBack(rating(3));
    const reAnswered = [...back.answers, { ...answer("f03"), verdict: "dislike" as const }];
    expect(reAnswered).toHaveLength(3);
    expect(reAnswered.filter((a) => a.photoId === "f03")).toHaveLength(1);
    expect(reAnswered[2]?.verdict).toBe("dislike");
  });

  it("is a no-op at the start of the deck rather than a negative index", () => {
    const start = rating(0);
    expect(stepBack(start)).toBe(start);
  });

  it("walks back to the first card and then stops", () => {
    let state = rating(4);
    for (let i = 0; i < 10; i += 1) state = stepBack(state);
    expect(state.index).toBe(0);
    expect(state.answers).toHaveLength(0);
  });

  it("keeps index === answers.length, the invariant the whole deck reads", () => {
    let state = rating(5);
    for (const step of [1, 1, 1, 1, 1, 1]) {
      state = stepBack(state);
      expect(state.index).toBe(state.answers.length * step);
    }
  });
});

describe("shouldAcceptTap", () => {
  it("drops a second committing tap inside the lockout", () => {
    // The next card mounts under the same two buttons, so this second tap
    // would answer a photo the user never saw.
    expect(shouldAcceptTap(1_000, 1_000 + TAP_LOCKOUT_MS - 1)).toBe(false);
  });

  it("accepts a tap at the lockout boundary and beyond", () => {
    expect(shouldAcceptTap(1_000, 1_000 + TAP_LOCKOUT_MS)).toBe(true);
    expect(shouldAcceptTap(1_000, 1_000 + 4_000)).toBe(true);
  });

  it("accepts the first tap of a session", () => {
    expect(shouldAcceptTap(0, Date.now())).toBe(true);
  });

  it("stays well under a deliberate decision, so a real rater is never blocked", () => {
    expect(TAP_LOCKOUT_MS).toBeLessThan(700);
    // ...and above the double-tap window it exists to catch.
    expect(TAP_LOCKOUT_MS).toBeGreaterThanOrEqual(300);
  });
});
