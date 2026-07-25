import { describe, it, expect } from "vitest";
import type { BotContext } from "../session.js";
import { isVerificationGateAllowed, isVerificationGated } from "./verification-gate.js";

function makeCtx(overrides: {
  data?: string;
  menuState?: string;
}): BotContext {
  return {
    callbackQuery: overrides.data ? { data: overrides.data } : undefined,
    session: { menuState: overrides.menuState ?? "idle" },
  } as unknown as BotContext;
}

describe("isVerificationGated", () => {
  it("gates a user who finalized onboarding but is still status=onboarding", () => {
    expect(
      isVerificationGated({ status: "onboarding", onboardingStep: "completed" }),
    ).toBe(true);
  });

  it("does not gate an activated user", () => {
    expect(
      isVerificationGated({ status: "active", onboardingStep: "completed" }),
    ).toBe(false);
  });

  it("does not gate a user still mid-onboarding (the FSM owns them)", () => {
    expect(
      isVerificationGated({ status: "onboarding", onboardingStep: "conversational" }),
    ).toBe(false);
  });

  it("does not gate paused / moderated states", () => {
    for (const status of ["paused", "frozen", "suspended", "banned"]) {
      expect(isVerificationGated({ status, onboardingStep: "completed" })).toBe(false);
    }
  });

  it("treats a missing user as not gated", () => {
    expect(isVerificationGated(null)).toBe(false);
    expect(isVerificationGated(undefined)).toBe(false);
  });
});

describe("isVerificationGateAllowed", () => {
  it("lets every verification callback through", () => {
    for (const data of [
      "verify:check",
      "verify:skip",
      "verify:skip:confirm",
      "verify:photos",
      "verify:photos:clear",
    ]) {
      expect(isVerificationGateAllowed(makeCtx({ data }))).toBe(true);
    }
  });

  it("blocks every menu callback", () => {
    for (const data of [
      "menu:open",
      "menu:profile",
      "menu:settings",
      "menu:tickets",
      "menu:premium",
      "menu:referral",
      "menu:pause",
      "menu:edit:photos",
    ]) {
      expect(isVerificationGateAllowed(makeCtx({ data }))).toBe(false);
    }
  });

  it("blocks free text (it would reach the menu agent)", () => {
    expect(isVerificationGateAllowed(makeCtx({}))).toBe(false);
  });

  it("lets the photo manager work once it is open", () => {
    // Raw photo messages the manager consumes…
    expect(isVerificationGateAllowed(makeCtx({ menuState: "edit_photos" }))).toBe(true);
    // …and its own buttons.
    for (const data of [
      "menu:edit:photos:add",
      "menu:edit:photos:del:0",
      "menu:edit:photos:continue",
    ]) {
      expect(
        isVerificationGateAllowed(makeCtx({ data, menuState: "edit_photos" })),
      ).toBe(true);
    }
  });

  it("still blocks unrelated menu actions while the photo manager is open", () => {
    expect(
      isVerificationGateAllowed(
        makeCtx({ data: "menu:settings", menuState: "edit_photos" }),
      ),
    ).toBe(false);
  });
});
