import { describe, expect, it } from "vitest";

import {
  DATE_BUMP_GRACE_HOURS,
  DATE_BUMP_OPENS_MINUTES,
  DATE_RADAR_LEAD_MINUTES,
} from "@gennety/shared";

import {
  deriveDateState,
  sideOf,
  type DateStateMatch,
  type MatchSide,
} from "./date-state.js";

const T = new Date("2026-09-03T17:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

function match(overrides: Partial<DateStateMatch> = {}): DateStateMatch {
  return {
    status: "scheduled",
    acceptedByA: true,
    acceptedByB: true,
    agreedTime: T,
    feedbackPromptedAt: null,
    feedbackByA: null,
    feedbackByB: null,
    ...overrides,
  };
}

function at(offsetMs: number): Date {
  return new Date(T.getTime() + offsetMs);
}

function state(
  m: DateStateMatch | null,
  now: Date,
  opts: { side?: MatchSide; verified?: boolean } = {},
) {
  return deriveDateState({
    match: m,
    side: opts.side ?? "A",
    bump: opts.verified ? { isVerified: true } : null,
    now,
  });
}

describe("deriveDateState", () => {
  it("has nothing to show without a live match", () => {
    expect(state(null, T)).toBe("IDLE_EXPLORING");
  });

  describe("the pitch decision", () => {
    it("asks the side that has not answered", () => {
      const m = match({ status: "proposed", acceptedByA: null, acceptedByB: null });
      expect(state(m, T)).toBe("DROP_PENDING_DECISION");
    });

    it("stops asking the side that has answered", () => {
      const m = match({ status: "proposed", acceptedByA: true, acceptedByB: null });
      expect(state(m, T)).toBe("LOGISTICS_SCHEDULING");
    });

    it("treats a decline as answered, not as still pending", () => {
      const m = match({ status: "proposed", acceptedByA: false, acceptedByB: null });
      expect(state(m, T)).toBe("LOGISTICS_SCHEDULING");
    });

    // The blind-decision invariant, asserted rather than described: a side that
    // has committed must resolve to the SAME state whatever the peer did, or
    // the canvas leaks the peer's answer before this user has earned it.
    it("reads identically whatever the peer chose", () => {
      const peerPending = match({ status: "proposed", acceptedByA: true, acceptedByB: null });
      const peerYes = match({ status: "proposed", acceptedByA: true, acceptedByB: true });
      const peerNo = match({ status: "proposed", acceptedByA: true, acceptedByB: false });

      expect(state(peerPending, T)).toBe(state(peerYes, T));
      expect(state(peerYes, T)).toBe(state(peerNo, T));
    });

    it("asks each side about its own column", () => {
      const m = match({ status: "proposed", acceptedByA: true, acceptedByB: null });
      expect(state(m, T, { side: "A" })).toBe("LOGISTICS_SCHEDULING");
      expect(state(m, T, { side: "B" })).toBe("DROP_PENDING_DECISION");
    });
  });

  describe("planning", () => {
    it("covers both negotiation statuses", () => {
      expect(state(match({ status: "negotiating" }), T)).toBe("LOGISTICS_SCHEDULING");
      expect(state(match({ status: "negotiating_venue" }), T)).toBe("LOGISTICS_SCHEDULING");
    });

    it("does not do clock arithmetic on a scheduled row with no time", () => {
      expect(state(match({ agreedTime: null }), T)).toBe("LOGISTICS_SCHEDULING");
    });
  });

  describe("the ladder into the date", () => {
    it("shows a locked date before the radar opens", () => {
      expect(state(match(), at(-(DATE_RADAR_LEAD_MINUTES + 1) * MINUTE))).toBe(
        "DATE_SCHEDULED",
      );
    });

    it("opens the radar exactly at T-45m", () => {
      expect(state(match(), at(-DATE_RADAR_LEAD_MINUTES * MINUTE))).toBe(
        "DATE_RADAR_ACTIVE",
      );
    });

    it("keeps the radar until the bump window opens", () => {
      expect(state(match(), at(-(DATE_BUMP_OPENS_MINUTES + 1) * MINUTE))).toBe(
        "DATE_RADAR_ACTIVE",
      );
    });

    it("asks for the bump exactly at T-15m", () => {
      expect(state(match(), at(-DATE_BUMP_OPENS_MINUTES * MINUTE))).toBe(
        "DATE_BUMP_PENDING",
      );
    });

    it("still asks for the bump after the agreed time", () => {
      expect(state(match(), at(30 * MINUTE))).toBe("DATE_BUMP_PENDING");
    });

    it("opens the deck once the bump is verified", () => {
      expect(state(match(), at(5 * MINUTE), { verified: true })).toBe("DATE_IN_PROGRESS");
    });

    // The overlap the ladder exists for: a verified bump sits inside the bump
    // window, which sits inside the radar window. Broadest-first would answer
    // DATE_RADAR_ACTIVE for a pair already at the table.
    it("prefers a verified bump over the window it happened in", () => {
      const early = at(-(DATE_BUMP_OPENS_MINUTES + 5) * MINUTE);
      expect(state(match(), early, { verified: true })).toBe("DATE_IN_PROGRESS");
    });
  });

  describe("after the evening", () => {
    const past = () => at(DATE_BUMP_GRACE_HOURS * HOUR + MINUTE);

    it("goes back to the map once the grace window closes", () => {
      expect(state(match(), past())).toBe("IDLE_EXPLORING");
    });

    it("does not keep a verified bump on screen forever", () => {
      expect(state(match(), past(), { verified: true })).toBe("IDLE_EXPLORING");
    });

    it("asks for feedback only once the prompt has actually been sent", () => {
      const notAsked = match({ feedbackPromptedAt: null });
      const asked = match({ feedbackPromptedAt: at(24 * HOUR) });
      expect(state(notAsked, past())).toBe("IDLE_EXPLORING");
      expect(state(asked, past())).toBe("POST_DATE_FEEDBACK");
    });
  });

  describe("terminal matches", () => {
    it("shows nothing for a cancelled or expired match", () => {
      expect(state(match({ status: "cancelled" }), T)).toBe("IDLE_EXPLORING");
      expect(state(match({ status: "expired" }), T)).toBe("IDLE_EXPLORING");
    });

    it("owes feedback on a completed match until this side answers", () => {
      const m = match({ status: "completed", feedbackPromptedAt: at(24 * HOUR) });
      expect(state(m, at(25 * HOUR))).toBe("POST_DATE_FEEDBACK");
    });

    it("stops asking the side that answered, and only that side", () => {
      const m = match({
        status: "completed",
        feedbackPromptedAt: at(24 * HOUR),
        feedbackByA: "it was lovely",
      });
      expect(state(m, at(25 * HOUR), { side: "A" })).toBe("IDLE_EXPLORING");
      expect(state(m, at(25 * HOUR), { side: "B" })).toBe("POST_DATE_FEEDBACK");
    });

    it("does not ask on a completed match the tick never prompted", () => {
      const m = match({ status: "completed", feedbackPromptedAt: null });
      expect(state(m, at(25 * HOUR))).toBe("IDLE_EXPLORING");
    });
  });
});

describe("sideOf", () => {
  const pair = { userAId: "aaa", userBId: "bbb" };

  it("resolves each participant", () => {
    expect(sideOf(pair, "aaa")).toBe("A");
    expect(sideOf(pair, "bbb")).toBe("B");
  });

  // Positively resolved rather than "not A, therefore B" — the bug already
  // fixed once in startPeerWaitShimmer, where a stranger's id aimed at side B.
  it("returns null for someone who is on neither side", () => {
    expect(sideOf(pair, "ccc")).toBeNull();
  });
});
