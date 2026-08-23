import { describe, expect, it } from "vitest";
import { onboardingReactionFor } from "./message-reactions.js";

describe("onboardingReactionFor", () => {
  it("reacts 👍 to the hobbies answer", () => {
    expect(onboardingReactionFor(["hobbies"])).toBe("like");
  });

  it("reacts ❤ to the closing vibe answer", () => {
    expect(onboardingReactionFor(["vibe_focus"])).toBe("heart");
  });

  it("prefers ❤ when one answer closes both fields", () => {
    expect(onboardingReactionFor(["hobbies", "vibe_focus"])).toBe("heart");
  });

  it("stays silent on every other field and on no fields at all", () => {
    expect(onboardingReactionFor(["first_name", "age"])).toBeNull();
    expect(onboardingReactionFor([])).toBeNull();
    expect(onboardingReactionFor(undefined)).toBeNull();
  });
});
