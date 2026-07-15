import { describe, expect, it } from "vitest";
import {
  computeAcquisition,
  normalizeChannel,
  type GrowthUserInput,
} from "./growth.js";

describe("normalizeChannel", () => {
  it("maps the known referralSource shapes to coarse channels", () => {
    expect(normalizeChannel(null)).toBe("organic");
    expect(normalizeChannel("")).toBe("organic");
    expect(normalizeChannel("tg:ig_story")).toBe("tg:ig_story");
    expect(normalizeChannel("mobile:utm=spring")).toBe("mobile");
    expect(normalizeChannel("web:join")).toBe("web:join");
    expect(normalizeChannel("tg:referral_abc123")).toBe("referral");
  });
});

describe("computeAcquisition", () => {
  const u = (
    referralSource: string | null,
    onboardingStep: string,
    status: string,
    matched: boolean,
  ): GrowthUserInput => ({ referralSource, onboardingStep, status, matched });

  it("aggregates downstream conversion per channel and ranks by signups", () => {
    const users: GrowthUserInput[] = [
      // ig_story: 3 signups, 2 completed, 1 active, 1 matched
      u("tg:ig_story", "completed", "active", true),
      u("tg:ig_story", "completed", "onboarding", false),
      u("tg:ig_story", "conversational", "onboarding", false),
      // organic: 1 signup, fully converted
      u(null, "completed", "active", true),
    ];

    const result = computeAcquisition(users);

    expect(result.organicShare).toBe(0.25);
    expect(result.bySource[0]!.channel).toBe("tg:ig_story"); // most signups first

    const ig = result.bySource.find((r) => r.channel === "tg:ig_story")!;
    expect(ig).toMatchObject({
      signups: 3,
      completedOnboarding: 2,
      active: 1,
      matched: 1,
      completionRate: 0.67,
      activationRate: 0.33,
    });

    const organic = result.bySource.find((r) => r.channel === "organic")!;
    expect(organic.activationRate).toBe(1);
  });

  it("returns zeroed rates and empty summary for no users", () => {
    const result = computeAcquisition([]);
    expect(result.bySource).toEqual([]);
    expect(result.organicShare).toBe(0);
  });
});
