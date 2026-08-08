import { describe, expect, it } from "vitest";
import {
  DEMO_CHAT_WAIT_MS,
  DEMO_COORD_CHOICE_WAIT_MS,
  DEMO_CONVERGE_WAIT_MS,
  DEMO_DATE_CARD_WAIT_MS,
  DEMO_EXPLORE_WAIT_MS,
  DEMO_PROXY_MAX_PARTNER_MESSAGES,
  DEMO_PROXY_REPLY_WAIT_MS,
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
    awaitingPhotoUpload: false,
    spokenBeats: new Set<DemoBeat>(["intro"]),
    match: null,
    finishedMatch: null,
    hasEverMatched: false,
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
    coordMethod: null,
    proxyState: "none",
    proxyLastSender: null,
    proxyPartnerMessageCount: 0,
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

  it("does not replay the intro to an active visitor after a restart", () => {
    // `spokenBeats` lives in memory, so a deploy forgets what was read. Every
    // other beat is protected by its own window having closed; this is the
    // intro's.
    const decision = decideDemoAction(snapshot({ spokenBeats: new Set() }));
    expect(decision.action).not.toEqual({ kind: "narrate", beat: "intro" });
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

  describe("the photo note", () => {
    const base = {
      status: "onboarding" as const,
      onboardingStep: "conversational" as const,
      verificationStatus: "unverified" as const,
    };

    it("lands once the bot is actually waiting for photos", () => {
      expect(
        decideDemoAction(
          snapshot({ ...base, currentQuestion: "photos", awaitingPhotoUpload: true }),
        ).action,
      ).toEqual({ kind: "narrate", beat: "photos" });
    });

    it("says nothing on an earlier question", () => {
      expect(
        decideDemoAction(
          snapshot({ ...base, currentQuestion: "hobbies", awaitingPhotoUpload: true }),
        ).action,
      ).toEqual({ kind: "none" });
    });

    // The regression this whole field exists for. The Type Radar gate makes the
    // collector reach `photos` while the chat still shows the radar invite, so
    // firing here put the note minutes above the photo request and under a Mini
    // App the visitor was about to spend several minutes inside — it read as
    // never having been sent.
    it("waits out the Type Radar step instead of firing under its invite", () => {
      expect(
        decideDemoAction(
          snapshot({ ...base, currentQuestion: "photos", awaitingPhotoUpload: false }),
        ).action,
      ).toEqual({ kind: "none" });
    });
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

  it("also answers after the visitor DECLINED, so the row can terminate", () => {
    // §3.4: a first decider leaves the match `proposed` whichever way they
    // went. A puppet that only answered a "yes" left a declined match live
    // until its 24h TTL, so `finishedMatch` never appeared and the
    // "continue the demo" button never arrived.
    expect(
      decideDemoAction(snapshot({ match: match({ visitorAccepted: false }) })).action,
    ).toEqual({ kind: "partner_accept" });
  });

  it("never answers twice after a decline either", () => {
    expect(
      decideDemoAction(
        snapshot({ match: match({ visitorAccepted: false, partnerAccepted: true }) }),
      ).action,
    ).toEqual({ kind: "none" });
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
    // Not `none`: with the board leaving nothing owed, the coordination stretch
    // takes over (these fixtures are past the T-2h gate). What matters is that
    // the puppet does not reach for a bill that is the visitor's.
    expect(
      decideDemoAction(
        snapshot({ match: board({ venueChangeStatus: "agreed" }) }),
      ).action.kind,
    ).not.toBe("partner_settle_venue_change");
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
  const scheduled = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({ status: "scheduled", ...over });

  it("hands the date card over first, and leaves it alone for a beat", () => {
    // The replay buries the card under five more messages, and the card is
    // where the venue-change board, Maps and the share copy live.
    const decision = decideDemoAction(snapshot({ match: scheduled() }));
    expect(decision.action).toEqual({ kind: "narrate", beat: "date_ready" });
    expect(decision.waitMs).toBe(DEMO_DATE_CARD_WAIT_MS);
  });

  it("gives the visitor minutes with the card before continuing by itself", () => {
    const decision = decideDemoAction(
      snapshot({
        match: scheduled(),
        spokenBeats: new Set<DemoBeat>(["intro", "date_ready"]),
      }),
    );
    expect(decision.action).toEqual({ kind: "run_predate" });
    expect(decision.waitMs).toBe(DEMO_EXPLORE_WAIT_MS);
    // The button in the beat is the intended path; this is only the floor.
    expect(DEMO_EXPLORE_WAIT_MS).toBeGreaterThan(5 * 60_000);
  });

  it("does not repeat after the lifecycle has claimed its marker", () => {
    // The T-2h gate has played, so the coordination stretch owns everything from
    // here — the replay must NOT run a second time.
    expect(
      decideDemoAction(
        snapshot({
          match: scheduled({ icebreakersSentAt: new Date() }),
          spokenBeats: new Set<DemoBeat>(["intro", "date_ready"]),
        }),
      ).action.kind,
    ).not.toBe("run_predate");
  });
});

describe("coordination fork", () => {
  // Everything here runs after the T-2h gate, which is what `icebreakersSentAt`
  // marks; before it the date card and the pre-date replay own the flow.
  const played = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({
      status: "scheduled",
      icebreakersSentAt: new Date(),
      agreedTime: new Date("2026-08-20T16:00:00Z"),
      ...over,
    });
  const spoken = (...beats: DemoBeat[]) => new Set<DemoBeat>(["intro", "date_ready", "predate", ...beats]);

  it("sends the fork once the pre-date gate has played", () => {
    const decision = decideDemoAction(snapshot({ match: played(), spokenBeats: spoken() }));
    expect(decision.action).toEqual({ kind: "coord_offer" });
    // Narration-grade: the visitor is mid-step and the card belongs under the
    // ice-breakers that just landed, not a beat later.
    expect(decision.waitMs).toBe(0);
  });

  it("holds the fork open while the visitor reads the impossible variants", () => {
    // Tapping "share my Telegram" / "ask for theirs" writes NOTHING, on purpose,
    // so the snapshot is unchanged and the demo keeps waiting rather than
    // deciding for them.
    const decision = decideDemoAction(
      snapshot({ match: played(), spokenBeats: spoken("coord_offer") }),
    );
    expect(decision.action).toEqual({ kind: "coord_pick_proxy" });
    expect(decision.waitMs).toBe(DEMO_COORD_CHOICE_WAIT_MS);
    // Long enough to press both explanations and read them.
    expect(DEMO_COORD_CHOICE_WAIT_MS).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("does not re-send the fork once it is on screen", () => {
    expect(
      decideDemoAction(snapshot({ match: played(), spokenBeats: spoken("coord_offer") })).action
        .kind,
    ).not.toBe("coord_offer");
  });

  it("moves on when a method is set but no window ever opened", () => {
    // COORDINATION_FEATURE_ENABLED off: the sweep stamps nothing, so waiting for
    // a chat would hold the demo open forever.
    const decision = decideDemoAction(
      snapshot({
        match: played({ coordMethod: "proxy", proxyState: "none" }),
        spokenBeats: spoken("coord_offer"),
      }),
    );
    expect(decision.action).toEqual({ kind: "run_after_date" });
  });

  it("keeps the venue-change board ahead of the whole stretch", () => {
    // A visitor mid-board must not be interrupted by the coordination fork.
    const decision = decideDemoAction(
      snapshot({
        match: played({ venueChangeStatus: "liking", visitorLikeKeys: ["a"] }),
        spokenBeats: spoken("coord_offer"),
      }),
    );
    expect(decision.action).toEqual({ kind: "partner_counter_likes" });
  });
});

describe("anonymous chat", () => {
  const open = (over: Partial<DemoMatchSnapshot> = {}) =>
    match({
      status: "scheduled",
      icebreakersSentAt: new Date(),
      agreedTime: new Date("2026-08-20T16:00:00Z"),
      coordMethod: "proxy",
      proxyState: "open",
      ...over,
    });
  const spoken = (...beats: DemoBeat[]) =>
    new Set<DemoBeat>(["intro", "date_ready", "predate", "coord_offer", ...beats]);

  it("explains the window before the puppet writes into it", () => {
    const decision = decideDemoAction(snapshot({ match: open(), spokenBeats: spoken() }));
    expect(decision.action).toEqual({ kind: "narrate", beat: "chat_open" });
  });

  it("opens the conversation itself, before the visitor has said anything", () => {
    // The opener is what makes the visitor press "Enter chat" — a relayed DM
    // arrives whether or not they are in the chat session.
    const decision = decideDemoAction(
      snapshot({ match: open({ proxyLastSender: null }), spokenBeats: spoken("chat_open") }),
    );
    expect(decision.action).toEqual({ kind: "partner_proxy_reply" });
    expect(decision.waitMs).toBe(DEMO_PROXY_REPLY_WAIT_MS);
    // A person typing, not a negotiation step.
    expect(DEMO_PROXY_REPLY_WAIT_MS).toBeLessThan(DEMO_STEP_WAIT_MS);
  });

  it("answers the visitor", () => {
    expect(
      decideDemoAction(
        snapshot({
          match: open({ proxyLastSender: "visitor", proxyPartnerMessageCount: 1 }),
          spokenBeats: spoken("chat_open"),
        }),
      ).action,
    ).toEqual({ kind: "partner_proxy_reply" });
  });

  it("does not talk to itself while waiting for a reply", () => {
    const decision = decideDemoAction(
      snapshot({
        match: open({ proxyLastSender: "partner", proxyPartnerMessageCount: 1 }),
        spokenBeats: spoken("chat_open"),
      }),
    );
    expect(decision.action).toEqual({ kind: "run_after_date" });
    expect(decision.waitMs).toBe(DEMO_CHAT_WAIT_MS);
  });

  it("stops answering at the cap", () => {
    // The visitor bounds this already (the puppet only ever replies), so the cap
    // is the guard against a stuck relay becoming an open-ended LLM bill.
    const decision = decideDemoAction(
      snapshot({
        match: open({
          proxyLastSender: "visitor",
          proxyPartnerMessageCount: DEMO_PROXY_MAX_PARTNER_MESSAGES,
        }),
        spokenBeats: spoken("chat_open"),
      }),
    );
    expect(decision.action).toEqual({ kind: "run_after_date" });
  });
});

describe("endings", () => {
  it("offers the way back after a pass, before trying to pitch again", () => {
    const decision = decideDemoAction(
      snapshot({
        hasEverMatched: true,
        finishedMatch: { id: "m1", status: "cancelled" },
      }),
    );
    expect(decision.action).toEqual({
      kind: "offer_continue",
      matchId: "m1",
      beat: "declined",
    });
  });

  it("closes a demo that ran all the way through with its own copy", () => {
    // The post-date feedback flips `scheduled` to `completed`. Both endings
    // leave a terminal row, and telling someone who just finished a successful
    // date that "a pass is final" is the wrong message entirely.
    const decision = decideDemoAction(
      snapshot({
        hasEverMatched: true,
        finishedMatch: { id: "m1", status: "completed" },
      }),
    );
    expect(decision.action).toEqual({
      kind: "offer_continue",
      matchId: "m1",
      beat: "finale",
    });
  });

  it("never re-pitches on its own once the offer has been made", () => {
    // The driver clears `finishedMatch` after speaking, and the terminal rows
    // stay. Without `hasEverMatched` this state was indistinguishable from a
    // fresh visitor and produced an unasked-for second profile.
    expect(
      decideDemoAction(snapshot({ hasEverMatched: true, finishedMatch: null })).action,
    ).toEqual({ kind: "none" });
  });

  it("still pitches unprompted to a visitor who has never matched", () => {
    expect(decideDemoAction(snapshot({ hasEverMatched: false })).action).toEqual({
      kind: "pitch",
    });
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
