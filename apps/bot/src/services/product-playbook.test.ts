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
    it("describes the proxy chat, and no contact exchange, when ON", () => {
      const text = buildProductPlaybook({ ...ALL_OFF, coordination: true });
      expect(text).toContain("Enter chat");
      expect(text).toContain("1 hour before");
      // Founder decision 2026-09-26: the T-3h questionnaire and its handle
      // swap are gone — the agent must say contacts are never exchanged.
      expect(text).not.toMatch(/share my Telegram contact|~3h before|coordination offer/i);
      expect(text).toContain("Contacts are never exchanged");
    });

    it("never promises coordination tools when OFF", () => {
      const text = buildProductPlaybook(ALL_OFF);
      expect(text).not.toContain("Enter chat");
      expect(text).toMatch(/Do not promise contact-sharing/i);
    });
  });

  /**
   * Founder decision 2026-09-26 made explicit what the code already did: a
   * scheduled date can be cancelled from the moment it is booked. The agent
   * used to tell people the cancel button only exists "from ~5h before".
   */
  it("says a booked date can be cancelled any time, with no window to wait for", () => {
    const text = buildProductPlaybook(ALL_OFF);
    expect(text).toContain("can be cancelled at any time before it");
    expect(text).not.toMatch(/From ~5h before the date there's an emergency-cancel button/);
    expect(text).not.toContain("emergency-cancel window opens");
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
        {
          ticketPrice: "$4.20",
          premiumPrice: "$42.00",
          premiumPackagePrices: { 3: "$107.10", 6: "$176.40" },
          rematchPrice: "$1.23",
        },
      );
      expect(text).toContain("$4.20");
      expect(text).toContain("$42.00");
      expect(text).toContain("$1.23");
      // The packages are injected for the same reason as the monthly price:
      // they are derived from PREMIUM_STARS, so a repricing must not leave the
      // agent quoting a discount the invoice will not honour.
      expect(text).toContain("$107.10");
      expect(text).toContain("$176.40");
      // The old inline literals must be gone, or an env price change silently
      // turns the agent into a source of wrong prices.
      expect(text).not.toContain("$6.99");
      expect(text).not.toContain("$11.99");
    });

    it("omits a package whose price could not be derived", () => {
      // `premiumPlanDisplayPrice` returns null when the configured display
      // string carries no number. The playbook's own rule is that the agent
      // describes only what is listed here, so an underivable price must leave
      // the agent silent rather than quoting a default nobody configured.
      const text = buildProductPlaybook(
        { ...ALL_ON, rematch: true },
        {
          ticketPrice: "$4.20",
          premiumPrice: "$42.00",
          premiumPackagePrices: {},
          rematchPrice: "$1.23",
        },
      );
      expect(text).not.toMatch(/3 months for/);
      expect(text).not.toMatch(/6 months for/);
      // The monthly plan is still described — the section does not vanish.
      expect(text).toContain("$42.00");
    });

    it("tells the agent a package does NOT renew", () => {
      // The one thing a buyer must not be wrong about, and the reason the
      // reminder exists at all.
      const text = buildProductPlaybook(
        { ...ALL_ON, rematch: true },
        {
          ticketPrice: "$4.20",
          premiumPrice: "$42.00",
          premiumPackagePrices: { 3: "$107.10", 6: "$176.40" },
          rematchPrice: "$1.23",
        },
      );
      expect(text).toMatch(/do NOT renew/i);
      expect(text).toMatch(/3 days out/i);
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
      rematchMaxPerWindow: 7,
      rematchWindowDays: 7,
      rematchCooldownHours: 24,
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

    it("states the rematch limits from the cadence, not the old literal prose", () => {
      // "2 per week, and 24h between runs" was a hardcoded string on a PAID
      // feature. Under a faster cadence the cap is 7, and quoting 2 would read
      // to the buyer as a refusal to sell him something he is entitled to.
      const withRematch = { ...ALL_ON, rematch: true };
      const weekly = buildProductPlaybook(withRematch);
      expect(weekly).toContain("2 per 7 days");

      const daily = buildProductPlaybook(withRematch, undefined, DAILY_ISH);
      expect(daily).toContain("7 per 7 days");
      expect(daily).not.toContain("2 per 7 days");
      expect(daily).not.toContain("2 per week");
    });
  });

  describe("silent drops", () => {
    const SILENT: PlaybookCadence = {
      silentDrops: true,
      decisionWindowHours: null,
      planningNudgeHours: [3, 6],
      stallCheckInHours: 12,
      stallTimeoutHours: 24,
      rematchMaxPerWindow: 7,
      rematchWindowDays: 7,
      rematchCooldownHours: 24,
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

describe("first-drop calibration (founder decision 2026-10-11)", () => {
  const CAL: PlaybookCadence = {
    silentDrops: true,
    decisionWindowHours: null,
    planningNudgeHours: [3, 6],
    stallCheckInHours: 12,
    stallTimeoutHours: 24,
    rematchMaxPerWindow: 7,
    rematchWindowDays: 7,
    rematchCooldownHours: 24,
    firstDropCalibrationHours: 24,
  };

  it("explains the first day and points at the Search phase line", () => {
    const text = buildProductPlaybook(ALL_OFF, undefined, CAL);
    expect(text).toContain("The first day is calibration");
    expect(text).toContain("second evening after onboarding");
    expect(text).toContain("the window is 24h");
    // Plain words to the user, no internal term or hour count.
    expect(text).toContain('Never say "calibration", "24 hours" or any hour count');
    // Cannot be bought: no paid option while calibrating.
    expect(text).toContain("Calibration cannot be skipped or bought");
    expect(text).toContain('"Search phase"');
    // The date is when the search starts, never a promised match.
    expect(text).toContain("never a promised match");
  });

  it("says nothing about calibration when the window is off", () => {
    const text = buildProductPlaybook(ALL_OFF, undefined, { ...CAL, firstDropCalibrationHours: 0 });
    expect(text).not.toContain("The first day is calibration");
    expect(text).not.toContain("Calibration cannot be skipped or bought");
  });

  it("holds the position on any wait — no apology, no thanks for patience", () => {
    const text = buildProductPlaybook(ALL_OFF, undefined, CAL);
    expect(text).toContain("Hold the position when explaining a wait");
    expect(text).toContain('no "thanks for waiting"');
    expect(text).not.toContain("reassure them");
    // A scam accusation / refund demand gets facts, not an apology.
    expect(text).toContain("If they call it a scam or demand their money back");
  });
});

describe("waiting without a pair (founder decision 2026-10-15)", () => {
  const EARLY: PlaybookFeatures = { ...ALL_OFF, earlyStage: true };

  it("answers 'why no match?' with the early-stage line while EARLY_STAGE is on", () => {
    const text = buildProductPlaybook(EARLY);
    expect(text).toContain('## Waiting without a pair — "why no match?"');
    expect(text).toContain("Gennety has only just opened, so the circle is still small");
    expect(text).toContain("you don't suggest just anyone");
    expect(text).toContain("you write first");
    expect(text).toContain("It is not about them.");
  });

  it("drops the 'just opened' line once the early stage is over", () => {
    const text = buildProductPlaybook(ALL_OFF);
    expect(text).toContain('## Waiting without a pair — "why no match?"');
    expect(text).not.toContain("only just opened");
    expect(text).toContain("you only suggest someone you're sure of");
  });

  it("allows one real tip at most, and forbids apologies, ETAs, priority, pool numbers and persuading", () => {
    const text = buildProductPlaybook(EARLY);
    expect(text).toContain("At most ONE concrete tip, and only if it is true");
    expect(text).toContain("No real gap → no tip");
    expect(text).toContain("Never: apologise, give a date or time frame for a match, promise priority");
    expect(text).toContain("quote or guess how many people are in their city or the pool");
    expect(text).toContain("don't talk them out of it");
    expect(text).toContain("they can come back any time");
    // The old starvation-boost promise is gone.
    expect(text).not.toContain("priority rises the longer they wait");
  });

  it("describes the rare check-ins instead of a weekly one", () => {
    const text = buildProductPlaybook(EARLY);
    expect(text).toContain("a few messages over the first five months without a pair");
    expect(text).not.toContain("about once a week");
  });

  it("says nobody is auto-paused during the early stage, and explains the pause after it", () => {
    const early = buildProductPlaybook(EARLY);
    expect(early).toContain("Nobody is paused for a long wait right now");
    expect(early).not.toContain("the search is paused automatically");

    const later = buildProductPlaybook(ALL_OFF);
    expect(later).toContain("After 28 days with nobody at all, the search is paused automatically");
    expect(later).toContain("it resumes by itself the moment someone who fits appears");
    expect(later).not.toContain("Nobody is paused for a long wait right now");
  });
});
