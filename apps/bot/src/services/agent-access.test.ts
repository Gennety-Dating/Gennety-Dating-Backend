import { describe, it, expect } from "vitest";
import {
  AGENT_DENIAL_COPY,
  agentAccessHttpStatus,
  evaluateAgentAccess,
} from "./agent-access.js";

describe("evaluateAgentAccess", () => {
  it("admits an ordinary completed, active user", () => {
    expect(
      evaluateAgentAccess({ status: "active", onboardingStep: "completed" }),
    ).toEqual({ allowed: true });
  });

  it("admits a paused user — pausing is the user's own choice, not a penalty", () => {
    expect(
      evaluateAgentAccess({ status: "paused", onboardingStep: "completed" }),
    ).toEqual({ allowed: true });
  });

  it("refuses a user who is still onboarding", () => {
    const decision = evaluateAgentAccess({
      status: "onboarding",
      onboardingStep: "conversational",
    });
    expect(decision).toEqual({ allowed: false, reason: "not_onboarded" });
  });

  it("refuses a verification-gated user (finished profile, liveness not passed)", () => {
    const decision = evaluateAgentAccess({
      status: "onboarding",
      onboardingStep: "completed",
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason: "verification_required" });
  });

  it.each([
    ["banned", "banned"],
    ["pending_investigation", "under_investigation"],
    ["suspended", "suspended"],
  ] as const)("refuses a %s account", (status, reason) => {
    const decision = evaluateAgentAccess({ status, onboardingStep: "completed" });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ reason });
  });

  it("carries the suspension end date through so the caller can show it", () => {
    const until = new Date("2026-08-10T00:00:00Z");
    const decision = evaluateAgentAccess({
      status: "suspended",
      onboardingStep: "completed",
      suspendedUntil: until,
    });
    expect(decision).toMatchObject({ suspendedUntil: until });
  });

  it("reports moderation rather than verification when both could apply", () => {
    // A moderated account can also look verification-gated depending on how the
    // row was left; the user should hear the specific reason, not the generic one.
    const decision = evaluateAgentAccess({
      status: "banned",
      onboardingStep: "completed",
    });
    expect(decision).toMatchObject({ reason: "banned" });
  });

  it("refuses a missing user", () => {
    expect(evaluateAgentAccess(null)).toEqual({
      allowed: false,
      reason: "not_onboarded",
    });
  });
});

describe("agentAccessHttpStatus", () => {
  it("uses 409 for an unfinished onboarding and 403 for everything else", () => {
    expect(agentAccessHttpStatus("not_onboarded")).toBe(409);
    expect(agentAccessHttpStatus("banned")).toBe(403);
    expect(agentAccessHttpStatus("verification_required")).toBe(403);
  });
});

describe("AGENT_DENIAL_COPY", () => {
  it("has copy for every denial the chat surface can render", () => {
    expect(Object.keys(AGENT_DENIAL_COPY).sort()).toEqual([
      "banned",
      "suspended",
      "under_investigation",
      "verification_required",
    ]);
  });
});
