import { describe, expect, it, vi } from "vitest";

vi.mock("@gennety/db", () => ({ prisma: {} }));
vi.mock("../services/match-engine.js", () => ({ createProposedMatch: vi.fn() }));
vi.mock("./embedding-refresh.js", () => ({ refreshUserEmbedding: vi.fn() }));
vi.mock("../services/dispatch-queue.js", () => ({ dispatchMatches: vi.fn() }));
vi.mock("../public/matches-service.js", () => ({ applyMatchDecision: vi.fn() }));
vi.mock("../handlers/matching/ticket-gate.js", () => ({ useTicketFromBalance: vi.fn() }));
vi.mock("../handlers/matching/scheduler.js", () => ({ processCalendarSlotsUpdate: vi.fn() }));
vi.mock("../handlers/matching/venue-negotiation.js", () => ({ tryFinalize: vi.fn() }));
vi.mock("../services/venue-intent-v2.js", () => ({
  confirmVenueIntent: vi.fn(),
  interpretVenueIntent: vi.fn(),
  venueIntentMode: vi.fn(),
}));
vi.mock("../services/app-review.js", () => ({
  APP_REVIEW_PARTNER_TELEGRAM_ID: -779_000_002n,
  APP_REVIEW_REVIEWER_TELEGRAM_ID: -779_000_001n,
  ensureAppReviewPartner: vi.fn(),
  ensureAppReviewTickets: vi.fn(),
  isAppReviewEnabled: vi.fn(() => true),
}));

const { decideAppReviewAction, APP_REVIEW_RESTART_DELAY_MS } = await import("./app-review-partner.js");
type Live = Parameters<typeof decideAppReviewAction>[0] & object;

const now = new Date("2026-10-15T12:00:00Z");
const SLOT_1 = "2026-10-17T16:00:00.000Z";
const SLOT_2 = "2026-10-18T16:00:00.000Z";

function live(patch: Partial<Live>): Live {
  return {
    status: "proposed",
    reviewerAccepted: null,
    partnerAccepted: null,
    ticketOpen: true,
    reviewerTicketPaid: false,
    partnerTicketPaid: false,
    proposedTimes: [],
    reviewerSlots: [],
    partnerSlots: [],
    reviewerVenueDone: false,
    partnerVenueDone: false,
    ...patch,
  };
}

describe("decideAppReviewAction", () => {
  it("starts a pair when there has never been one", () => {
    expect(decideAppReviewAction(null, null, now)).toEqual({ kind: "start_match" });
  });

  it("waits out the restart delay after a pair ended, then starts again", () => {
    const justEnded = new Date(now.getTime() - 30_000);
    expect(decideAppReviewAction(null, justEnded, now)).toEqual({ kind: "none" });
    const longAgo = new Date(now.getTime() - APP_REVIEW_RESTART_DELAY_MS);
    expect(decideAppReviewAction(null, longAgo, now)).toEqual({ kind: "start_match" });
  });

  it("never answers the pitch before the reviewer has", () => {
    expect(decideAppReviewAction(live({}), null, now)).toEqual({ kind: "none" });
  });

  it("accepts after the reviewer answered, either way", () => {
    expect(decideAppReviewAction(live({ reviewerAccepted: true }), null, now)).toEqual({
      kind: "partner_accept",
    });
    expect(decideAppReviewAction(live({ reviewerAccepted: false }), null, now)).toEqual({
      kind: "partner_accept",
    });
    expect(
      decideAppReviewAction(live({ reviewerAccepted: true, partnerAccepted: true }), null, now),
    ).toEqual({ kind: "none" });
  });

  it("pays its half of the ticket only after the reviewer paid", () => {
    const base = { status: "negotiating" };
    expect(decideAppReviewAction(live(base), null, now)).toEqual({ kind: "none" });
    expect(decideAppReviewAction(live({ ...base, reviewerTicketPaid: true }), null, now)).toEqual({
      kind: "partner_pay_ticket",
    });
    expect(
      decideAppReviewAction(
        live({ ...base, reviewerTicketPaid: true, partnerTicketPaid: true }),
        null,
        now,
      ),
    ).toEqual({ kind: "none" });
    expect(
      decideAppReviewAction(live({ ...base, ticketOpen: false, reviewerTicketPaid: true }), null, now),
    ).toEqual({ kind: "none" });
  });

  it("takes the reviewer's first slot once they have picked", () => {
    const base = { status: "negotiating", proposedTimes: [SLOT_1, SLOT_2] };
    expect(decideAppReviewAction(live(base), null, now)).toEqual({ kind: "none" });
    expect(
      decideAppReviewAction(live({ ...base, reviewerSlots: [SLOT_2, SLOT_1] }), null, now),
    ).toEqual({ kind: "partner_slots", slots: [SLOT_2] });
    expect(
      decideAppReviewAction(
        live({ ...base, reviewerSlots: [SLOT_2], partnerSlots: [SLOT_1] }),
        null,
        now,
      ),
    ).toEqual({ kind: "partner_slots", slots: [SLOT_1, SLOT_2] });
    expect(
      decideAppReviewAction(
        live({ ...base, reviewerSlots: [SLOT_2], partnerSlots: [SLOT_2] }),
        null,
        now,
      ),
    ).toEqual({ kind: "none" });
  });

  it("gives its venue answer after the reviewer gave theirs", () => {
    const base = { status: "negotiating_venue" };
    expect(decideAppReviewAction(live(base), null, now)).toEqual({ kind: "none" });
    expect(decideAppReviewAction(live({ ...base, reviewerVenueDone: true }), null, now)).toEqual({
      kind: "partner_venue",
    });
    expect(
      decideAppReviewAction(
        live({ ...base, reviewerVenueDone: true, partnerVenueDone: true }),
        null,
        now,
      ),
    ).toEqual({ kind: "none" });
  });

  it("does nothing on a scheduled date", () => {
    expect(decideAppReviewAction(live({ status: "scheduled" }), null, now)).toEqual({
      kind: "none",
    });
  });
});
