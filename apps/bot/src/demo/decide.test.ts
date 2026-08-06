import { describe, expect, it } from "vitest";
import {
  DEMO_CONVERGE_WAIT_MS,
  DEMO_STEP_WAIT_MS,
  decideDemoAction,
  pickCounterSlots,
  type DemoMatchSnapshot,
  type DemoSnapshot,
} from "./decide.js";
import type { DemoBeat } from "./script.js";

function snapshot(overrides: Partial<DemoSnapshot> = {}): DemoSnapshot {
  return {
    language: "ru",
    status: "active",
    onboardingStep: "completed",
    verificationStatus: "verified",
    currentQuestion: null,
    spokenBeats: new Set<DemoBeat>(["intro"]),
    match: null,
    awaitingContinueOffer: false,
    ...overrides,
  };
}

function match(overrides: Partial<DemoMatchSnapshot> = {}): DemoMatchSnapshot {
  return {
    id: "m1",
    status: "proposed",
    visitorSide: "A",
    visitorAccepted: null,
    partnerAccepted: null,
    ticketOpen: false,
    visitorTicketPaid: false,
    partnerTicketPaid: false,
    proposedTimes: [],
    visitorSlots: [],
    partnerSlots: [],
    agreedTime: null,
    visitorVenueConfirmed: false,
    partnerVenueConfirmed: false,
    icebreakersSentAt: null,
    venueChangeStatus: null,
    visitorLikeKeys: [],
    partnerLikeKeys: [],
    venueChangePayerIsPartner: false,
    ...overrides,
  };
}

describe("demo narration", () => {
  // The onboarding Mini App owns `consent` and `language` (PRODUCT_SPEC §1.2),
  // so before it hands off there is no `User.language` and the intro would be
  // English for everyone — pushed at someone not yet asked what they read.
  it.each(["consent", "language"] as const)(
    "stays silent on %s, before the Mini App has asked for a language",
    (onboardingStep) => {
      const decision = decideDemoAction(
        snapshot({ spokenBeats: new Set(), status: "onboarding", onboardingStep, language: null }),
      );
      expect(decision.action).toEqual({ kind: "none" });
    },
  );

  it("opens with the intro once the Mini App hands the chat back", () => {
    const decision = decideDemoAction(
      snapshot({
        spokenBeats: new Set(),
        status: "onboarding",
        onboardingStep: "conversational",
        verificationStatus: "unverified",
      }),
    );
    expect(decision.action).toEqual({ kind: "narrate", beat: "intro" });
    // Narration is not a "wait a beat" action — the visitor is mid-step.
    expect(decision.waitMs).toBe(0);
  });

  it("still leads with the intro when a later beat is also owed", () => {
    // Ordering matters: a visitor who reaches the verification gate without
    // having read the intro must get the intro first, not the gate's warning.
    const decision = decideDemoAction(
      snapshot({
        spokenBeats: new Set(),
        status: "onboarding",
        onboardingStep: "completed",
        verificationStatus: "unverified",
      }),
    );
    expect(decision.action).toEqual({ kind: "narrate", beat: "intro" });
  });

  it("warns about photos exactly when the collector asks for them", () => {
    const base = {
      status: "onboarding" as const,
      onboardingStep: "conversational" as const,
      verificationStatus: "unverified" as const,
    };
    expect(
      decideDemoAction(snapshot({ ...base, currentQuestion: "hobbies" })).action,
    ).toEqual({ kind: "none" });
    expect(
      decideDemoAction(snapshot({ ...base, currentQuestion: "photos" })).action,
    ).toEqual({ kind: "narrate", beat: "photos" });
  });

  it("explains the fake liveness check while the verification gate holds them", () => {
    const decision = decideDemoAction(
      snapshot({
        status: "onboarding",
        onboardingStep: "completed",
        verificationStatus: "pending",
      }),
    );
    expect(decision.action).toEqual({ kind: "narrate", beat: "verification" });
  });

  it("never repeats a beat it has already spoken", () => {
    const decision = decideDemoAction(
      snapshot({
        status: "onboarding",
        onboardingStep: "completed",
        verificationStatus: "pending",
        spokenBeats: new Set<DemoBeat>(["intro", "verification"]),
      }),
    );
    expect(decision.action).toEqual({ kind: "none" });
  });
});

describe("first match", () => {
  it("pitches once the visitor is active and verified", () => {
    const decision = decideDemoAction(snapshot());
    expect(decision.action).toEqual({ kind: "pitch" });
    expect(decision.waitMs).toBe(DEMO_STEP_WAIT_MS);
  });

  it("does not pitch to a visitor still behind the verification gate", () => {
    expect(
      decideDemoAction(
        snapshot({
          status: "onboarding",
          onboardingStep: "completed",
          verificationStatus: "pending",
          spokenBeats: new Set<DemoBeat>(["intro", "verification"]),
        }),
      ).action,
    ).toEqual({ kind: "none" });
  });
});

describe("blind decision invariant", () => {
  it("stays silent until the visitor has committed", () => {
    expect(
      decideDemoAction(snapshot({ match: match({ visitorAccepted: null }) })).action,
    ).toEqual({ kind: "none" });
  });

  it("answers only after the visitor accepted", () => {
    expect(
      decideDemoAction(snapshot({ match: match({ visitorAccepted: true }) })).action,
    ).toEqual({ kind: "partner_accept" });
  });

  it("never answers twice", () => {
    expect(
      decideDemoAction(
        snapshot({ match: match({ visitorAccepted: true, partnerAccepted: true }) }),
      ).action,
    ).toEqual({ kind: "none" });
  });
});

describe("date ticket gate", () => {
  const gate = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({ status: "negotiating", ticketOpen: true, proposedTimes: [], ...over });

  it("waits for the visitor to pay first — their move, no status", () => {
    expect(
      decideDemoAction(snapshot({ match: gate({ visitorTicketPaid: false }) })).action,
    ).toEqual({ kind: "none" });
  });

  it("settles the puppet's half once the visitor has paid", () => {
    expect(
      decideDemoAction(snapshot({ match: gate({ visitorTicketPaid: true }) })).action,
    ).toEqual({ kind: "partner_pay_ticket" });
  });

  it("does nothing when the visitor covered both", () => {
    expect(
      decideDemoAction(
        snapshot({ match: gate({ visitorTicketPaid: true, partnerTicketPaid: true }) }),
      ).action,
    ).toEqual({ kind: "none" });
  });
});

describe("calendar negotiation", () => {
  const slots = [
    "2026-09-01T13:00:00.000Z",
    "2026-09-01T14:00:00.000Z",
    "2026-09-02T13:00:00.000Z",
    "2026-09-03T13:00:00.000Z",
    "2026-09-04T13:00:00.000Z",
  ];
  const cal = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({ status: "negotiating", proposedTimes: slots, ...over });

  it("says nothing while the visitor has not picked — their move", () => {
    expect(decideDemoAction(snapshot({ match: cal() })).action).toEqual({ kind: "none" });
  });

  it("counters with slots the visitor did not pick", () => {
    const decision = decideDemoAction(
      snapshot({ match: cal({ visitorSlots: [slots[0]!, slots[1]!] }) }),
    );
    expect(decision.action.kind).toBe("partner_counter_slots");
    if (decision.action.kind !== "partner_counter_slots") throw new Error("unreachable");
    expect(decision.action.slots).not.toContain(slots[0]);
    expect(decision.action.slots).not.toContain(slots[1]);
    expect(decision.action.slots.length).toBeGreaterThan(0);
  });

  it("gives in after a longer wait when the two sets never meet", () => {
    const decision = decideDemoAction(
      snapshot({
        match: cal({ visitorSlots: [slots[0]!], partnerSlots: [slots[3]!] }),
      }),
    );
    expect(decision.action).toEqual({
      kind: "partner_converge_slots",
      slots: [slots[0]],
    });
    // Deliberately longer: answering the counter-proposal is the mechanic the
    // demo is showing, so the visitor gets a real chance to do it themselves.
    expect(decision.waitMs).toBe(DEMO_CONVERGE_WAIT_MS);
  });

  it("stops once the sets overlap — the product locks the date itself", () => {
    expect(
      decideDemoAction(
        snapshot({ match: cal({ visitorSlots: [slots[0]!], partnerSlots: [slots[0]!] }) }),
      ).action,
    ).toEqual({ kind: "none" });
  });

  it("gives in immediately when the visitor marked every slot", () => {
    const decision = decideDemoAction(snapshot({ match: cal({ visitorSlots: slots }) }));
    expect(decision.action.kind).toBe("partner_converge_slots");
  });
});

describe("venue negotiation", () => {
  it("submits only after the visitor has confirmed their own intent", () => {
    const base = { status: "negotiating_venue" as const };
    expect(
      decideDemoAction(snapshot({ match: match({ ...base }) })).action,
    ).toEqual({ kind: "none" });
    expect(
      decideDemoAction(
        snapshot({ match: match({ ...base, visitorVenueConfirmed: true }) }),
      ).action,
    ).toEqual({ kind: "partner_venue" });
  });
});

describe("venue change board", () => {
  const board = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({ status: "scheduled", icebreakersSentAt: new Date(), ...over });

  it("counters with a venue the visitor did not heart", () => {
    expect(
      decideDemoAction(
        snapshot({
          match: board({ venueChangeStatus: "liking", visitorLikeKeys: ["a"] }),
        }),
      ).action,
    ).toEqual({ kind: "partner_counter_likes" });
  });

  it("agrees on the second round", () => {
    expect(
      decideDemoAction(
        snapshot({
          match: board({
            venueChangeStatus: "liking",
            visitorLikeKeys: ["a"],
            partnerLikeKeys: ["b"],
          }),
        }),
      ).action,
    ).toEqual({ kind: "partner_agree_likes" });
  });

  it("settles only when the payer matrix puts the bill on the puppet", () => {
    expect(
      decideDemoAction(
        snapshot({ match: board({ venueChangeStatus: "agreed" }) }),
      ).action,
    ).toEqual({ kind: "none" });
    expect(
      decideDemoAction(
        snapshot({
          match: board({ venueChangeStatus: "agreed", venueChangePayerIsPartner: true }),
        }),
      ).action,
    ).toEqual({ kind: "partner_settle_venue_change" });
  });

  it("does not interrupt an open board with the pre-date replay", () => {
    const decision = decideDemoAction(
      snapshot({
        match: board({
          icebreakersSentAt: null,
          venueChangeStatus: "liking",
          visitorLikeKeys: ["a"],
        }),
      }),
    );
    expect(decision.action).toEqual({ kind: "partner_counter_likes" });
  });
});

describe("pre-date replay", () => {
  it("runs once the date is scheduled", () => {
    expect(
      decideDemoAction(snapshot({ match: match({ status: "scheduled" }) })).action,
    ).toEqual({ kind: "run_predate" });
  });

  it("does not repeat after the lifecycle has claimed its marker", () => {
    expect(
      decideDemoAction(
        snapshot({ match: match({ status: "scheduled", icebreakersSentAt: new Date() }) }),
      ).action,
    ).toEqual({ kind: "none" });
  });
});

describe("decline recovery", () => {
  it("offers the way back, and does so before trying to pitch again", () => {
    const decision = decideDemoAction(snapshot({ awaitingContinueOffer: true }));
    expect(decision.action).toEqual({ kind: "offer_continue" });
  });
});

describe("pickCounterSlots", () => {
  const slots = [
    "2026-09-01T13:00:00.000Z",
    "2026-09-01T14:00:00.000Z",
    "2026-09-02T13:00:00.000Z",
    "2026-09-03T13:00:00.000Z",
    "2026-09-04T13:00:00.000Z",
  ];

  it("prefers days the visitor did not choose at all", () => {
    const picked = pickCounterSlots(slots, [slots[0]!]);
    expect(picked).not.toContain(slots[1]); // same day as the visitor's pick
    expect(picked.every((s) => !s.startsWith("2026-09-01"))).toBe(true);
  });

  it("returns at most three, one per day", () => {
    const picked = pickCounterSlots(slots, []);
    expect(picked.length).toBeLessThanOrEqual(3);
    expect(new Set(picked.map((s) => s.slice(0, 10))).size).toBe(picked.length);
  });

  it("falls back to any free slot when every day is taken", () => {
    const visitorTookEveryDay = [slots[0]!, slots[2]!, slots[3]!, slots[4]!];
    const picked = pickCounterSlots(slots, visitorTookEveryDay);
    expect(picked).toEqual([slots[1]]);
  });

  it("returns nothing when the visitor marked everything", () => {
    expect(pickCounterSlots(slots, slots)).toEqual([]);
  });
});
