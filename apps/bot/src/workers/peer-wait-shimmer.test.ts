import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../config.js", () => ({
  env: { CUSTOM_EMOJI_THINKING_ID: "" },
}));

vi.mock("@gennety/db", () => ({
  prisma: { match: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() } },
}));

import { prisma } from "@gennety/db";
import {
  isSideWaitingOnPeer,
  peerWaitShimmerTick,
  PEER_WAIT_FALLBACK_EDIT_MS,
  type PeerWaitMatchRow,
} from "./peer-wait-shimmer.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findMany: MockFn;
  update: MockFn;
};

const NOW = new Date("2026-07-28T12:00:00.000Z");

function row(overrides: Partial<PeerWaitMatchRow> = {}): PeerWaitMatchRow {
  return {
    id: "m1",
    status: "proposed",
    acceptedByA: null,
    acceptedByB: null,
    proposedTimes: [],
    availableTimesA: [],
    availableTimesB: [],
    venueIntentA: null,
    venueIntentB: null,
    vibeTextA: null,
    vibeTextB: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeLatB: null,
    vibeLngB: null,
    venueChangeStatus: null,
    venueChangeProposerId: null,
    venueLikesA: [],
    venueLikesB: [],
    venueChangeOfferPaySentAt: null,
    venueChangeExpressAt: null,
    venueChangePaidAt: null,
    userA: { id: "uid-A", gender: null },
    userB: { id: "uid-B", gender: null },
    ...overrides,
  };
}

/** A full findMany row: the predicate columns plus the delivery/side columns. */
function dbRow(overrides: Record<string, unknown> = {}) {
  return {
    ...row(),
    peerWaitMessageIdA: null,
    peerWaitMessageIdB: null,
    peerWaitEditedAtA: null,
    peerWaitEditedAtB: null,
    peerWaitStartedAtA: null,
    peerWaitStartedAtB: null,
    ...overrides,
    userA: {
      id: "uid-A",
      telegramId: 111n,
      language: "en",
      firstName: "Gleb",
      gender: null,
      ...((overrides.userA as Record<string, unknown>) ?? {}),
    },
    userB: {
      id: "uid-B",
      telegramId: 222n,
      language: "en",
      firstName: "Anna",
      gender: null,
      ...((overrides.userB as Record<string, unknown>) ?? {}),
    },
  };
}

function createApi(opts: { richWorks?: boolean } = {}) {
  const richWorks = opts.richWorks ?? true;
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 900 }),
    editMessageText: vi.fn().mockResolvedValue(true),
    deleteMessage: vi.fn().mockResolvedValue(true),
    raw: {
      sendRichMessageDraft: richWorks
        ? vi.fn().mockResolvedValue(true)
        : vi.fn().mockRejectedValue(new Error("rich unsupported")),
    },
  } as never;
}

const typed = (api: unknown) =>
  api as unknown as {
    sendMessage: MockFn;
    editMessageText: MockFn;
    deleteMessage: MockFn;
    raw: { sendRichMessageDraft: MockFn };
  };

beforeEach(() => {
  vi.clearAllMocks();
  mMatch.findMany.mockReset().mockResolvedValue([]);
  mMatch.update.mockReset().mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// The product decision: who counts as waiting
// ---------------------------------------------------------------------------

describe("isSideWaitingOnPeer — pitch decision", () => {
  it("waits when I accepted and the peer hasn't answered", () => {
    const m = row({ status: "proposed", acceptedByA: true, acceptedByB: null });
    expect(isSideWaitingOnPeer(m, "A")).toBe(true);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("does NOT wait after a decline — a pass is irreversible", () => {
    // The decliner's next screen is "what was the main reason?", not a wait.
    const m = row({ status: "proposed", acceptedByA: false, acceptedByB: null });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
  });

  it("stops the moment the peer answers, either way", () => {
    for (const peer of [true, false]) {
      const m = row({ status: "proposed", acceptedByA: true, acceptedByB: peer });
      expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    }
  });

  it("does not wait before deciding anything", () => {
    expect(isSideWaitingOnPeer(row({ status: "proposed" }), "A")).toBe(false);
  });
});

describe("isSideWaitingOnPeer — calendar", () => {
  const slot = new Date("2026-08-01T16:00:00.000Z");

  it("waits when I marked slots and the peer hasn't", () => {
    const m = row({
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [slot],
      availableTimesB: [],
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(true);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("does NOT wait while the Date Ticket gate is still open", () => {
    // `negotiating` covers the ticket gate too, whose waiting state its Mini App
    // owns. An empty `proposedTimes` is exactly "the calendar hasn't opened".
    // Deliberately NOT keyed off `ticketStatus`, which defaults to "pending"
    // even when the ticket feature is disabled entirely.
    const m = row({
      status: "negotiating",
      proposedTimes: [],
      availableTimesA: [slot],
      availableTimesB: [],
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
  });

  it("stops once the peer marks a slot we share (the date auto-locks)", () => {
    const m = row({
      status: "negotiating",
      proposedTimes: [slot],
      availableTimesA: [slot],
      availableTimesB: [slot],
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("shows NEITHER side a status when both picked and nothing overlaps", () => {
    // A picks Monday, B picks Tuesday. Both of them now owe the next move —
    // widen the selection, or take one of the other's slots — so a "we're
    // coordinating a time" status would tell each of them to sit still while
    // the flow is blocked on them. They get the scheduling reminder instead
    // (`schedulingOwedKind` → "no-overlap" in `workers/match-nudge.ts`).
    const other = new Date("2026-08-02T16:00:00.000Z");
    const m = row({
      status: "negotiating",
      proposedTimes: [slot, other],
      availableTimesA: [slot],
      availableTimesB: [other],
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("stops the first mover's shimmer the moment the partner answers", () => {
    // The same row a beat earlier: A alone had picked and WAS waiting. What
    // ends that wait is the partner answering at all, overlap or not.
    const other = new Date("2026-08-02T16:00:00.000Z");
    const before = row({
      status: "negotiating",
      proposedTimes: [slot, other],
      availableTimesA: [slot],
      availableTimesB: [],
    });
    expect(isSideWaitingOnPeer(before, "A")).toBe(true);
    expect(isSideWaitingOnPeer({ ...before, availableTimesB: [other] }, "A")).toBe(false);
  });
});

describe("isSideWaitingOnPeer — venue", () => {
  it("waits on a confirmed V2 intent when the partner has none", () => {
    const m = row({
      status: "negotiating_venue",
      venueIntentA: { state: "confirmed" },
      venueIntentB: null,
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(true);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("does not count a V2 draft as submitted", () => {
    const m = row({
      status: "negotiating_venue",
      venueIntentA: { state: "draft" },
      venueIntentB: null,
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
  });

  it("counts the legacy path only with BOTH the vibe and the pin", () => {
    const partial = row({
      status: "negotiating_venue",
      vibeTextA: "quiet cafe",
      vibeLatA: null,
      vibeLngA: null,
    });
    expect(isSideWaitingOnPeer(partial, "A")).toBe(false);

    const complete = row({
      status: "negotiating_venue",
      vibeTextA: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
    });
    expect(isSideWaitingOnPeer(complete, "A")).toBe(true);
  });

  it("stops once both sides are in (finalization takes over)", () => {
    const m = row({
      status: "negotiating_venue",
      venueIntentA: { state: "confirmed" },
      venueIntentB: { state: "confirmed" },
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });
});

describe("isSideWaitingOnPeer — terminal states", () => {
  it("never waits on a match that ended", () => {
    for (const status of ["cancelled", "completed", "expired"]) {
      const m = row({ status, acceptedByA: true, acceptedByB: null });
      expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    }
  });

  it("ignores a scheduled date with no venue-change board", () => {
    // `scheduled` is now scanned for the §3.7b board, so it must not become a
    // catch-all: an ordinary locked-in date has nobody waiting.
    const m = row({ status: "scheduled", acceptedByA: true, acceptedByB: true });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §3.7b venue-change board
// ---------------------------------------------------------------------------

describe("isSideWaitingOnPeer — venue change", () => {
  const hetero = { userA: { id: "uid-A", gender: "male" }, userB: { id: "uid-B", gender: "female" } };
  const board = (overrides: Partial<PeerWaitMatchRow> = {}) =>
    row({ status: "scheduled", ...hetero, ...overrides });

  it("waits while I hearted places and the partner hasn't opened the board", () => {
    const m = board({ venueChangeStatus: "liking", venueLikesA: [{ key: "x" }], venueLikesB: [] });
    expect(isSideWaitingOnPeer(m, "A")).toBe(true);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("stops once the partner hearts anything", () => {
    const m = board({
      venueChangeStatus: "liking",
      venueLikesA: [{ key: "x" }],
      venueLikesB: [{ key: "y" }],
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
  });

  it("makes the NON-payer wait once a swap is agreed", () => {
    // Hetero → the man pays, whoever initiated. He has an action; she waits.
    const m = board({ venueChangeStatus: "agreed", venueChangeProposerId: "uid-A" });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false); // payer owes the Stars
    expect(isSideWaitingOnPeer(m, "B")).toBe(true);
  });

  it("does NOT make her wait while she can still offer — she holds the decision", () => {
    const m = board({
      venueChangeStatus: "agreed",
      venueChangeProposerId: "uid-B", // she initiated
      venueChangeOfferPaySentAt: null,
    });
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("starts her wait the moment she hands the payment over", () => {
    const m = board({
      venueChangeStatus: "agreed",
      venueChangeProposerId: "uid-B",
      venueChangeOfferPaySentAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    expect(isSideWaitingOnPeer(m, "B")).toBe(true);
  });

  it("never shimmers at the partner during a hidden express mint", () => {
    // An express mint is invisible until paid — the surprise IS the product. A
    // shimmer in his chat would announce that something is pending.
    const m = board({
      venueChangeStatus: "agreed",
      venueChangeProposerId: "uid-B",
      venueChangeExpressAt: new Date("2026-07-30T10:00:00.000Z"),
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("stops once the change is paid for", () => {
    const m = board({
      venueChangeStatus: "agreed",
      venueChangeProposerId: "uid-A",
      venueChangePaidAt: new Date("2026-07-30T11:00:00.000Z"),
    });
    expect(isSideWaitingOnPeer(m, "B")).toBe(false);
  });

  it("falls back to the initiator as payer in a same-sex pair", () => {
    const m = row({
      status: "scheduled",
      venueChangeStatus: "agreed",
      venueChangeProposerId: "uid-A",
      userA: { id: "uid-A", gender: "female" },
      userB: { id: "uid-B", gender: "female" },
    });
    expect(isSideWaitingOnPeer(m, "A")).toBe(false); // initiator pays
    expect(isSideWaitingOnPeer(m, "B")).toBe(true);
  });

  it("does not wait on a lapsed or settled board", () => {
    for (const venueChangeStatus of ["settled", "lapsed", null]) {
      const m = board({ venueChangeStatus, venueLikesA: [{ key: "x" }] });
      expect(isSideWaitingOnPeer(m, "A")).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

describe("peerWaitShimmerTick", () => {
  it("refreshes the draft for the waiting side only", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({ status: "proposed", acceptedByA: true, acceptedByB: null }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.refreshed).toBe(1);
    const calls = typed(api).raw.sendRichMessageDraft.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].chat_id).toBe(111);
    // No plain message is ever sent on the rich path — that is the whole point.
    expect(typed(api).sendMessage).not.toHaveBeenCalled();
  });

  it("keeps the same draft id across ticks so the shimmer refreshes, not restarts", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({ status: "proposed", acceptedByA: true, acceptedByB: null }),
    ]);

    await peerWaitShimmerTick(api, { now: NOW });
    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 20_000) });

    const calls = typed(api).raw.sendRichMessageDraft.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0]![0].draft_id).toBe(calls[1]![0].draft_id);
  });

  it("climbs the wording as the wait ages", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "proposed",
        acceptedByA: true,
        acceptedByB: null,
        peerWaitStartedAtA: NOW,
      }),
    ]);

    await peerWaitShimmerTick(api, { now: NOW });
    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 2 * 60 * 60 * 1000) });

    const calls = typed(api).raw.sendRichMessageDraft.mock.calls;
    expect(calls[0]![0].rich_message.html).not.toBe(calls[1]![0].rich_message.html);
  });

  it("stamps the anchor on the first tick and leaves it alone afterwards", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({ status: "proposed", acceptedByA: true, acceptedByB: null }),
    ]);

    await peerWaitShimmerTick(api, { now: NOW });

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { peerWaitStartedAtA: NOW } }),
    );

    // Second tick, anchor already present → no further write.
    mMatch.update.mockClear();
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "proposed",
        acceptedByA: true,
        acceptedByB: null,
        peerWaitStartedAtA: NOW,
      }),
    ]);
    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 20_000) });
    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("releases the anchor when the wait ends, so a later wait restarts at tier 1", async () => {
    // Without this a second wait on the same match would inherit a stale
    // "waiting since" and open on the 24h deadline copy.
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "proposed",
        acceptedByA: true,
        acceptedByB: true, // both answered → nobody waiting
        peerWaitStartedAtA: NOW,
      }),
    ]);

    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 60_000) });

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ peerWaitStartedAtA: null }),
      }),
    );
  });

  it("skips a side that is not waiting and has nothing to clean up", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([dbRow({ status: "proposed" })]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.refreshed).toBe(0);
    expect(typed(api).raw.sendRichMessageDraft).not.toHaveBeenCalled();
  });

  it("skips a mobile-only side (synthetic negative telegramId)", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "proposed",
        acceptedByA: true,
        acceptedByB: null,
        userA: { telegramId: -7n, language: "en", firstName: "Gleb" },
      }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });
    expect(res.refreshed).toBe(0);
  });

  // --- fallback path (clients that can't render rich drafts) ---------------

  it("establishes the plain fallback line when the draft is rejected", async () => {
    const api = createApi({ richWorks: false });
    mMatch.findMany.mockResolvedValue([
      dbRow({ status: "proposed", acceptedByA: true, acceptedByB: null }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.fallbackSent).toBe(1);
    expect(typed(api).sendMessage).toHaveBeenCalledTimes(1);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { peerWaitMessageIdA: 900, peerWaitEditedAtA: NOW },
    });
  });

  it("never retries the draft once a side is on the fallback", async () => {
    // Otherwise every tick would be a guaranteed failing API call, forever.
    const api = createApi({ richWorks: false });
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "proposed",
        acceptedByA: true,
        acceptedByB: null,
        peerWaitMessageIdA: 900,
        peerWaitEditedAtA: NOW,
      }),
    ]);

    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 20_000) });

    expect(typed(api).raw.sendRichMessageDraft).not.toHaveBeenCalled();
  });

  it("rewrites the fallback text at most once per rotation window", async () => {
    const api = createApi({ richWorks: false });
    const base = dbRow({
      status: "proposed",
      acceptedByA: true,
      acceptedByB: null,
      peerWaitMessageIdA: 900,
      peerWaitEditedAtA: NOW,
    });
    mMatch.findMany.mockResolvedValue([base]);

    // Too soon — an edit is a real API call on a real message.
    await peerWaitShimmerTick(api, { now: new Date(NOW.getTime() + 20_000) });
    expect(typed(api).editMessageText).not.toHaveBeenCalled();

    await peerWaitShimmerTick(api, {
      now: new Date(NOW.getTime() + PEER_WAIT_FALLBACK_EDIT_MS),
    });
    expect(typed(api).editMessageText).toHaveBeenCalledTimes(1);
  });

  it("deletes the fallback line and forgets it once the wait ends", async () => {
    const api = createApi();
    mMatch.findMany.mockResolvedValue([
      dbRow({
        // Peer answered → no longer waiting, but the line is still on screen.
        status: "proposed",
        acceptedByA: true,
        acceptedByB: true,
        peerWaitMessageIdA: 900,
        peerWaitEditedAtA: NOW,
      }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.clearedFallback).toBe(1);
    expect(typed(api).deleteMessage).toHaveBeenCalledWith(111, 900);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { peerWaitMessageIdA: null, peerWaitEditedAtA: null, peerWaitStartedAtA: null },
    });
  });

  it("forgets the fallback even when Telegram refuses the delete", async () => {
    // Telegram only lets a bot delete its own message for 48h; a wait can run
    // longer. Forgetting anyway is what stops us touching it every tick.
    const api = createApi();
    typed(api).deleteMessage.mockRejectedValue(new Error("message can't be deleted"));
    mMatch.findMany.mockResolvedValue([
      dbRow({
        status: "cancelled",
        peerWaitMessageIdB: 901,
        peerWaitEditedAtB: NOW,
      }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.clearedFallback).toBe(1);
    expect(mMatch.update).toHaveBeenCalledWith({
      where: { id: "m1" },
      data: { peerWaitMessageIdB: null, peerWaitEditedAtB: null, peerWaitStartedAtB: null },
    });
  });

  it("survives one side blowing up and still processes the rest", async () => {
    const api = createApi();
    typed(api).raw.sendRichMessageDraft
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(true);
    typed(api).sendMessage.mockRejectedValueOnce(new Error("also boom"));
    mMatch.findMany.mockResolvedValue([
      dbRow({ id: "m1", status: "proposed", acceptedByA: true, acceptedByB: null }),
      dbRow({ id: "m2", status: "proposed", acceptedByA: true, acceptedByB: null }),
    ]);

    const res = await peerWaitShimmerTick(api, { now: NOW });

    expect(res.errors).toBe(1);
    expect(res.refreshed).toBe(1);
  });
});
