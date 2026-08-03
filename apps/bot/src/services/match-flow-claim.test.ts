import { describe, expect, it } from "vitest";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";
import {
  MATCH_FLOW_CLAIM_TTL_MS,
  claimMatchFlow,
  matchFlowClaimIsLive,
  releaseMatchFlowClaim,
  updateReleasesMatchFlowClaim,
} from "./match-flow-claim.js";

const session = (over: Partial<SessionData> = {}): SessionData => ({
  ...DEFAULT_SESSION,
  ...over,
});

const NOW = new Date("2026-08-03T12:00:00Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("claimMatchFlow", () => {
  it("stamps a deadline sized to the state", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_emergency_reason", "m1", NOW);

    expect(s.matchFlow).toBe("awaiting_emergency_reason");
    expect(s.activeMatchId).toBe("m1");
    expect(s.matchFlowClaimUntil).toBe(
      NOW.getTime() + MATCH_FLOW_CLAIM_TTL_MS.awaiting_emergency_reason!,
    );
  });

  it("gives the destructive state the shortest window and feedback the longest", () => {
    // The ordering is the point: the emergency reason cancels a scheduled date,
    // feedback only ever writes to the answerer's own profile.
    expect(MATCH_FLOW_CLAIM_TTL_MS.awaiting_emergency_reason!).toBeLessThan(
      MATCH_FLOW_CLAIM_TTL_MS.awaiting_report_details!,
    );
    expect(MATCH_FLOW_CLAIM_TTL_MS.awaiting_report_details!).toBeLessThan(
      MATCH_FLOW_CLAIM_TTL_MS.awaiting_feedback!,
    );
  });
});

describe("matchFlowClaimIsLive", () => {
  it("is live inside the window and dead after it", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_report_details", "m1", NOW);

    expect(matchFlowClaimIsLive(s, "awaiting_report_details", later(60_000))).toBe(true);
    expect(
      matchFlowClaimIsLive(
        s,
        "awaiting_report_details",
        later(MATCH_FLOW_CLAIM_TTL_MS.awaiting_report_details! + 1),
      ),
    ).toBe(false);
  });

  it("fails closed for a session written before the deadline existed", () => {
    // The storage adapter merges DEFAULT_SESSION over a stored blob, so an old
    // row reads `null` here. Trusting it would reproduce the exact bug this
    // field exists to close — an abandoned state consuming a message days later.
    const s = session({ matchFlow: "awaiting_emergency_reason", matchFlowClaimUntil: null });
    expect(matchFlowClaimIsLive(s, "awaiting_emergency_reason", NOW)).toBe(false);
  });

  it("does not answer for a different state", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_feedback", "m1", NOW);
    expect(matchFlowClaimIsLive(s, "awaiting_report_details", NOW)).toBe(false);
  });
});

describe("releaseMatchFlowClaim", () => {
  it("clears the state and everything scoped to it", () => {
    const s = session({ pendingReportCategory: "other" });
    claimMatchFlow(s, "awaiting_report_details", "m1", NOW);

    releaseMatchFlowClaim(s);

    expect(s.matchFlow).toBe("idle");
    expect(s.matchFlowClaimUntil).toBeNull();
    expect(s.activeMatchId).toBeNull();
    expect(s.pendingReportCategory).toBeNull();
  });
});

describe("updateReleasesMatchFlowClaim", () => {
  it("keeps the claim for the question's own buttons", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_report_details", "m1", NOW);

    for (const data of ["rs:m1", "rb:m1", "rc:m1:other"]) {
      expect(updateReleasesMatchFlowClaim(s, { callbackData: data })).toBe(false);
    }
  });

  it("drops the claim on any other tap — the user moved on", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_emergency_reason", "m1", NOW);

    expect(updateReleasesMatchFlowClaim(s, { callbackData: "menu:open" })).toBe(true);
    expect(updateReleasesMatchFlowClaim(s, { callbackData: "emerg:abort:m1" })).toBe(false);
  });

  it("drops the claim on a command", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_feedback", "m1", NOW);

    expect(updateReleasesMatchFlowClaim(s, { text: "/menu" })).toBe(true);
  });

  it("never drops the claim on plain text — that IS the answer", () => {
    const s = session();
    claimMatchFlow(s, "awaiting_emergency_reason", "m1", NOW);

    expect(updateReleasesMatchFlowClaim(s, { text: "sorry, something came up" })).toBe(false);
  });

  it("is inert when nothing is claimed", () => {
    expect(updateReleasesMatchFlowClaim(session(), { callbackData: "menu:open" })).toBe(false);
    expect(
      updateReleasesMatchFlowClaim(session({ matchFlow: "coordination_chat" }), {
        callbackData: "menu:open",
      }),
    ).toBe(false);
  });
});
