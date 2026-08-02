import { describe, it, expect } from "vitest";
import {
  buildProductPlaybook,
  type PlaybookCadence,
  type PlaybookFeatures,
} from "./product-playbook.js";

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

  describe("rematch flag", () => {
    // It was ON in production while the playbook had no idea it existed, so the
    // agent's own "only describe what is listed here" rule made it deny a paid
    // feature the user could actually buy.
    it("describes the paid re-run only when ON", () => {
      const on = buildProductPlaybook({ ...ALL_OFF, rematch: true });
      expect(on).toContain("Searching again before the next drop");
      expect(on).toContain("INTRODUCTION, not a date");
      expect(buildProductPlaybook(ALL_OFF)).not.toContain(
        "Searching again before the next drop",
      );
    });

    // The gift framing is the product. A woman must never learn a pitch was
    // bought, so the rule has to be in the prompt, not just in our heads.
    it("forbids ever surfacing it to a woman", () => {
      const on = buildProductPlaybook({ ...ALL_OFF, rematch: true });
      expect(on).toContain("never mention this feature");
      expect(on).toMatch(/Read the user's Gender/);
    });
  });

  describe("pricing", () => {
    it("quotes the injected prices, never a hardcoded literal", () => {
      const text = buildProductPlaybook(
        { ...ALL_ON, rematch: true },
        { ticketPrice: "$4.20", premiumPrice: "$42.00", rematchPrice: "$1.23" },
      );
      expect(text).toContain("$4.20");
      expect(text).toContain("$42.00");
      expect(text).toContain("$1.23");
      // The old inline literals must be gone, or an env price change silently
      // turns the agent into a source of wrong prices.
      expect(text).not.toContain("$6.99");
      expect(text).not.toContain("$11.99");
    });
  });

  describe("account controls stay in sync with the real menu", () => {
    it("does not send anyone to Settings to re-verify", () => {
      const text = buildProductPlaybook(ALL_ON);
      // The entry was removed 2026-07-24 — verification is mandatory and
      // happens before the app opens.
      expect(text).toContain('NO "verify account" entry');
      expect(text).not.toContain("re-verify");
    });

    it("never offers a museum as a first-date venue", () => {
      expect(buildProductPlaybook(ALL_ON)).toContain("never museums");
    });
  });

  /**
   * Every deadline the playbook states is a `DropCadence` field. Written into
   * the prose they would silently become false the moment the cadence changes —
   * and a confidently wrong deadline is the single worst answer this agent can
   * give (its own rules say so).
   */
  describe("deadlines are derived from the cadence, not written into the prose", () => {
    const DAILY_ISH: PlaybookCadence = {
      silentDrops: true,
      decisionWindowHours: null, // anchored to the next drop
      planningNudgeHours: [3, 6],
      stallCheckInHours: 12,
      stallTimeoutHours: 24,
    };

    it("defaults to weekly's numbers when no cadence is passed", () => {
      const text = buildProductPlaybook(ALL_ON);
      expect(text).toContain("decide within 24h");
      expect(text).toContain("~6h and ~12h");
      expect(text).toContain("At ~24h");
      expect(text).toContain("cancelled after ~48h");
    });

    it("states none of weekly's hours under a faster cadence", () => {
      const text = buildProductPlaybook(ALL_ON, undefined, DAILY_ISH);
      expect(text).toContain("~3h and ~6h");
      expect(text).toContain("At ~12h");
      expect(text).toContain("cancelled after ~24h");
      expect(text).not.toContain("~48h");
      expect(text).not.toContain("At ~24h");
    });

    it("describes an anchored decision window instead of inventing a number", () => {
      const text = buildProductPlaybook(ALL_ON, undefined, DAILY_ISH);
      expect(text).toContain("decide within until shortly before the next drop");
      expect(text).not.toContain("24h to decide");
    });
  });

  describe("silent drops", () => {
    const SILENT: PlaybookCadence = {
      silentDrops: true,
      decisionWindowHours: null,
      planningNudgeHours: [3, 6],
      stallCheckInHours: 12,
      stallTimeoutHours: 24,
    };

    it("explains that a search finding nobody sends nothing at all", () => {
      const text = buildProductPlaybook(ALL_ON, undefined, SILENT);
      expect(text).toContain("only write when there is something to say");
      expect(text).toContain("sends NOTHING");
      // The agent must not reach for a fault to explain the quiet.
      expect(text).toContain("does not mean they were skipped");
    });

    it("says nothing about silence when every drop reports on itself", () => {
      // Under weekly the timer always resolves into a match or a famine DM, so
      // this guidance would describe a state the user cannot be in.
      const text = buildProductPlaybook(ALL_ON);
      expect(text).not.toContain("sends NOTHING");
    });
  });
});
