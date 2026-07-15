import { describe, expect, it } from "vitest";
import {
  computeOnboardingFunnel,
  type StepEventLite,
} from "./onboarding-funnel.js";

const ORDER = ["first_name_age", "gender", "preference", "height"] as const;

describe("computeOnboardingFunnel", () => {
  it("counts reach/answer/advance and flags where users are stuck", () => {
    // u1 completed through height; u2 stuck at gender; u3 stuck at preference.
    const events: StepEventLite[] = [
      // u1 — full run
      { userId: "u1", step: "first_name_age", kind: "answered", dwellMs: 1000 },
      { userId: "u1", step: "gender", kind: "asked", dwellMs: null },
      { userId: "u1", step: "gender", kind: "answered", dwellMs: 2000 },
      { userId: "u1", step: "preference", kind: "asked", dwellMs: null },
      { userId: "u1", step: "preference", kind: "answered", dwellMs: 3000 },
      { userId: "u1", step: "height", kind: "asked", dwellMs: null },
      { userId: "u1", step: "height", kind: "answered", dwellMs: 500 },
      // u2 — reached gender, never answered it
      { userId: "u2", step: "first_name_age", kind: "answered", dwellMs: 800 },
      { userId: "u2", step: "gender", kind: "asked", dwellMs: null },
      // u3 — reached preference, never answered it
      { userId: "u3", step: "first_name_age", kind: "answered", dwellMs: 1200 },
      { userId: "u3", step: "gender", kind: "asked", dwellMs: null },
      { userId: "u3", step: "gender", kind: "answered", dwellMs: 9000 },
      { userId: "u3", step: "preference", kind: "asked", dwellMs: null },
    ];
    // u1 finished onboarding; u2 and u3 are still in it.
    const incomplete = new Set(["u2", "u3"]);

    const funnel = computeOnboardingFunnel(events, ORDER, incomplete);

    expect(funnel.usersEntered).toBe(3);
    expect(funnel.usersStillOnboarding).toBe(2);

    const byStep = Object.fromEntries(funnel.steps.map((s) => [s.step, s]));

    // Everyone reached the first question.
    expect(byStep.first_name_age!.reached).toBe(3);
    expect(byStep.first_name_age!.advanced).toBe(3);
    expect(byStep.first_name_age!.dropOffRate).toBe(0);

    // gender: all three reached; u1 & u3 advanced past → u2 stuck here.
    expect(byStep.gender!.reached).toBe(3);
    expect(byStep.gender!.advanced).toBe(2);
    expect(byStep.gender!.stuckHere).toBe(1);
    expect(byStep.gender!.dropOffRate).toBeCloseTo(0.33, 2);

    // preference: u1 & u3 reached; only u1 advanced → u3 stuck here.
    expect(byStep.preference!.reached).toBe(2);
    expect(byStep.preference!.advanced).toBe(1);
    expect(byStep.preference!.stuckHere).toBe(1);
  });

  it("computes dwell median/p90 only from answered/skipped rows", () => {
    const events: StepEventLite[] = [
      { userId: "a", step: "gender", kind: "asked", dwellMs: null },
      { userId: "a", step: "gender", kind: "answered", dwellMs: 1000 },
      { userId: "b", step: "gender", kind: "answered", dwellMs: 3000 },
      { userId: "c", step: "gender", kind: "answered", dwellMs: 5000 },
    ];
    const funnel = computeOnboardingFunnel(events, ORDER, new Set());
    const gender = funnel.steps.find((s) => s.step === "gender")!;
    expect(gender.dwellSamples).toBe(3);
    expect(gender.dwellMsMedian).toBe(3000);
    expect(gender.dwellMsP90).toBeGreaterThan(3000);
  });

  it("ranks the top drop-off and slowest steps", () => {
    const events: StepEventLite[] = [
      { userId: "x", step: "gender", kind: "asked", dwellMs: null },
      { userId: "y", step: "gender", kind: "asked", dwellMs: null },
      { userId: "z", step: "height", kind: "asked", dwellMs: null },
      { userId: "z", step: "height", kind: "answered", dwellMs: 60_000 },
    ];
    const funnel = computeOnboardingFunnel(
      events,
      ORDER,
      new Set(["x", "y", "z"]),
    );
    expect(funnel.topDropOffSteps[0]!.step).toBe("gender");
    expect(funnel.topDropOffSteps[0]!.stuckHere).toBe(2);
    expect(funnel.slowestSteps[0]!.step).toBe("height");
  });

  it("ignores events for steps outside the canonical order", () => {
    const events: StepEventLite[] = [
      { userId: "a", step: "first_name_age", kind: "answered", dwellMs: 100 },
      { userId: "a", step: "unknown_step", kind: "answered", dwellMs: 100 },
    ];
    const funnel = computeOnboardingFunnel(events, ORDER, new Set());
    expect(funnel.usersEntered).toBe(1);
    expect(funnel.steps.every((s) => s.step !== "unknown_step")).toBe(true);
  });
});
