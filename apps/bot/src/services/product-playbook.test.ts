import { describe, it, expect } from "vitest";
import { buildProductPlaybook, type PlaybookFeatures } from "./product-playbook.js";

const ALL_OFF: PlaybookFeatures = {
  coordination: false,
  venueChange: false,
  tickets: false,
  premium: false,
};
const ALL_ON: PlaybookFeatures = {
  coordination: true,
  venueChange: true,
  tickets: true,
  premium: true,
};

describe("buildProductPlaybook", () => {
  it("always covers the core lifecycle stages", () => {
    const text = buildProductPlaybook(ALL_OFF);
    expect(text).toContain("The core model");
    expect(text).toContain("waiting for the next match");
    expect(text).toContain("match proposed");
    expect(text).toContain("picking a time");
    expect(text).toContain("picking the place");
    expect(text).toContain("date scheduled");
    expect(text).toContain("the hours before the date");
    expect(text).toContain("after the date");
    expect(text).toContain("How to find each other at the venue");
  });

  it("states the anti-hallucination facts the agent must never get wrong", () => {
    const text = buildProductPlaybook(ALL_OFF);
    // The user SEES the partner (photos/name/age/pitch) before deciding —
    // "blind" is ONLY about the partner's accept/decline, never their look.
    expect(text).toContain("DOES see their match");
    expect(text).toContain("NEVER claim photos or the profile are hidden");
    expect(text).toMatch(/"Blind" refers to ONE thing only/);
    // Private material never reaches the partner.
    expect(text).toContain("NEVER shown to the partner");
    // Unknown product questions must not be improvised.
    expect(text).toContain("NEVER guess, extrapolate, or invent a product rule");
  });

  it("describes the v2 venue-change board (both sides, decline never cancels)", () => {
    const text = buildProductPlaybook({ ...ALL_OFF, venueChange: true });
    expect(text).toContain("BOTH people have");
    expect(text).toContain("NEVER cancels the date");
    expect(text).not.toContain("declining cancels the date");
  });

  it("keeps the ticket earn list accurate (6 photos, no verification bonus)", () => {
    const text = buildProductPlaybook({ ...ALL_OFF, tickets: true });
    expect(text).toContain("reaching 6 photos");
    expect(text).toContain("does NOT grant a ticket");
    expect(text).not.toContain("4+ photos");
  });

  describe("coordination flag", () => {
    it("describes the proxy chat + contact share when ON", () => {
      const text = buildProductPlaybook({ ...ALL_OFF, coordination: true });
      expect(text).toContain("Enter chat");
      expect(text).toContain("30 minutes before");
      expect(text).toMatch(/share my Telegram contact/i);
    });

    it("never promises coordination tools when OFF", () => {
      const text = buildProductPlaybook(ALL_OFF);
      expect(text).not.toContain("Enter chat");
      expect(text).toMatch(/Do not promise contact-sharing/i);
    });
  });

  describe("tickets flag", () => {
    it("includes the Date Tickets section only when ON", () => {
      expect(buildProductPlaybook({ ...ALL_OFF, tickets: true })).toContain(
        "Date Tickets (currently ON)",
      );
      expect(buildProductPlaybook(ALL_OFF)).not.toContain("Date Tickets (currently ON)");
    });
  });

  describe("venue change flag", () => {
    it("mentions the female one-shot venue swap only when ON", () => {
      expect(buildProductPlaybook({ ...ALL_OFF, venueChange: true })).toContain(
        "Change venue",
      );
      expect(buildProductPlaybook(ALL_OFF)).not.toContain("Change venue");
    });
  });

  it("renders everything together with all flags ON", () => {
    const text = buildProductPlaybook(ALL_ON);
    expect(text).toContain("Enter chat");
    expect(text).toContain("Change venue");
    expect(text).toContain("Date Tickets (currently ON)");
  });
});
