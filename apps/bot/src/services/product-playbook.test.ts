import { describe, it, expect } from "vitest";
import { buildProductPlaybook, type PlaybookFeatures } from "./product-playbook.js";

const ALL_OFF: PlaybookFeatures = {
  coordination: false,
  venueChange: false,
  tickets: false,
};
const ALL_ON: PlaybookFeatures = {
  coordination: true,
  venueChange: true,
  tickets: true,
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
