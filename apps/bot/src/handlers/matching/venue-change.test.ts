import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    match: { findUnique: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    profile: { updateMany: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({
  env: { VENUE_CHANGE_FEATURE_ENABLED: true, WEBAPP_URL: "https://app.test" },
}));

import { prisma } from "@gennety/db";
import {
  proposeVenueChange,
  handleVenueChangeAccept,
  handleVenueChangeConfirmCancel,
  sweepExpiredVenueChanges,
  buildVenueChangeProposalNotice,
} from "./venue-change.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  updateMany: MockFn;
  findMany: MockFn;
};
const mProfile = prisma.profile as unknown as { updateMany: MockFn };

const HOUR = 60 * 60 * 1000;
const FAR_AGREED = new Date(Date.now() + 24 * HOUR);

/** Female = userA (telegram 100), Male = userB (telegram 200). */
function fakeMatch(over: Record<string, unknown> = {}) {
  return {
    id: "m1",
    status: "scheduled",
    agreedTime: FAR_AGREED,
    venueName: "Old Cafe",
    venueAddress: "Old St",
    venueLat: 50.45,
    venueLng: 30.52,
    venueGoogleMapsUri: "https://maps.google.com/old",
    venueChangeStatus: null,
    venueChangeProposerId: null,
    venueChangeProposedAt: null,
    venueChangeExpiresAt: null,
    venueChangeName: null,
    venueChangeAddress: null,
    venueChangeLat: null,
    venueChangeLng: null,
    venueChangeMapsUri: null,
    venueChangePlaceId: null,
    venueChangeComment: null,
    userAId: "a",
    userBId: "b",
    userA: { id: "a", telegramId: 100n, language: "en", gender: "female", universityDomain: "kyiv.edu" },
    userB: { id: "b", telegramId: 200n, language: "en", gender: "male" },
    ...over,
  };
}

function fakeApi() {
  return { sendMessage: vi.fn().mockResolvedValue(undefined) };
}

function createCtx(over: { callbackData?: string; fromId?: number } = {}) {
  const session: SessionData = { ...DEFAULT_SESSION, language: "en" };
  return {
    session,
    from: { id: over.fromId ?? 200 },
    callbackQuery: over.callbackData ? { data: over.callbackData } : undefined,
    api: fakeApi(),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  mMatch.findUnique.mockReset();
  mMatch.updateMany.mockReset();
  mMatch.findMany.mockReset();
  mProfile.updateMany.mockReset();
});

// ---------------------------------------------------------------------------
// proposeVenueChange
// ---------------------------------------------------------------------------

describe("proposeVenueChange", () => {
  const pick = {
    placeId: "p1",
    name: "New Cafe",
    address: "New St",
    lat: 50.451,
    lng: 30.521,
    mapsUri: "https://maps.google.com/new",
    comment: "It is much cozier and closer for me",
  };

  /** Server-built catalog entry the pick resolves to (by placeId). */
  const catalogEntry = {
    source: "places" as const,
    placeId: "p1",
    name: "New Cafe",
    address: "New St",
    lat: 50.451,
    lng: 30.521,
    mapsUri: "https://maps.google.com/new",
    category: "cafe",
    distanceKm: 0.1,
    photoUrl: null,
    photoRefs: [],
    rating: 4.5,
    userRatingCount: 120,
    editorialSummary: null,
  };
  // Injected catalog loader so the test needs no DB / Places network.
  const loadCatalog = async () => [catalogEntry];

  it("claims the one-shot and DMs the male the proposal", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    const api = fakeApi();

    const res = await proposeVenueChange(api as never, 100n, "m1", pick, { loadCatalog });
    expect(res).toEqual({ ok: true });

    const update = mMatch.updateMany.mock.calls[0][0];
    expect(update.where).toMatchObject({ status: "scheduled", venueChangeProposedAt: null });
    expect(update.data).toMatchObject({
      venueChangeStatus: "proposed",
      venueChangeProposerId: "a",
      venueChangeName: "New Cafe",
    });
    // DM goes to the male (telegram 200) with accept/decline buttons.
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
    const markup = api.sendMessage.mock.calls[0][2].reply_markup;
    const flat = JSON.stringify(markup.inline_keyboard);
    expect(flat).toContain("vchg:accept:m1");
    expect(flat).toContain("vchg:decline:m1");
  });

  it("persists the catalog's fields, never the client's spoofed name / maps link", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    const api = fakeApi();

    // Client lies about the venue label + ships a phishing maps link, but keeps
    // a real catalog placeId + coords. The server must ignore the spoofed fields.
    const spoofed = {
      ...pick,
      name: "Come to my place 😈",
      address: "123 Private Rd",
      mapsUri: "https://evil.example/phish",
    };
    const res = await proposeVenueChange(api as never, 100n, "m1", spoofed, { loadCatalog });
    expect(res).toEqual({ ok: true });

    const update = mMatch.updateMany.mock.calls[0][0];
    expect(update.data).toMatchObject({
      venueChangeName: "New Cafe",
      venueChangeAddress: "New St",
      venueChangeMapsUri: "https://maps.google.com/new",
    });
    // The relayed DM must carry the catalog label/link, not the phishing one.
    const dmText = api.sendMessage.mock.calls[0][1] as string;
    expect(dmText).not.toContain("evil.example");
    expect(dmText).toContain("New Cafe");
  });

  it("rejects a pick that is not in the catalog (no matching id / coords)", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await proposeVenueChange(fakeApi() as never, 100n, "m1", pick, {
      loadCatalog: async () => [],
    });
    expect(res).toEqual({ ok: false, reason: "invalid-venue" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("rejects the male side (not the female initiator)", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await proposeVenueChange(fakeApi() as never, 200n, "m1", pick, { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "not-female-initiator" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a too-short comment", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await proposeVenueChange(fakeApi() as never, 100n, "m1", { ...pick, comment: "short" }, { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "comment-too-short" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a pick outside the 3 km radius", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await proposeVenueChange(fakeApi() as never, 100n, "m1", {
      ...pick,
      lat: 50.6,
      lng: 30.9,
    }, { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "out-of-range" });
  });

  it("rejects when already used (lost the atomic claim)", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    const res = await proposeVenueChange(fakeApi() as never, 100n, "m1", pick, { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "race-lost" });
  });
});

// ---------------------------------------------------------------------------
// handleVenueChangeAccept
// ---------------------------------------------------------------------------

describe("handleVenueChangeAccept", () => {
  it("copies the proposed venue onto the canonical fields and DMs both", async () => {
    const proposed = fakeMatch({
      venueChangeStatus: "proposed",
      venueChangeProposerId: "a",
      venueChangeName: "New Cafe",
      venueChangeAddress: "New St",
      venueChangeLat: 50.451,
      venueChangeLng: 30.521,
      venueChangeMapsUri: "https://maps.google.com/new",
    });
    mMatch.findUnique.mockResolvedValue(proposed);
    mMatch.updateMany.mockResolvedValue({ count: 1 });

    const ctx = createCtx({ callbackData: "vchg:accept:m1", fromId: 200 });
    await handleVenueChangeAccept(ctx);

    const update = mMatch.updateMany.mock.calls[0][0];
    expect(update.data).toMatchObject({
      venueChangeStatus: "accepted",
      venueName: "New Cafe",
      venueGoogleMapsUri: "https://maps.google.com/new",
    });
    // female (100) + male actor (200) both get an updated card.
    const targets = ctx.api.sendMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(targets).toContain(100);
    expect(targets).toContain(200);
  });

  it("no-ops with an 'already decided' toast when not proposed", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch({ venueChangeStatus: "accepted", venueChangeProposerId: "a" }));
    const ctx = createCtx({ callbackData: "vchg:accept:m1", fromId: 200 });
    await handleVenueChangeAccept(ctx);
    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// handleVenueChangeConfirmCancel
// ---------------------------------------------------------------------------

describe("handleVenueChangeConfirmCancel", () => {
  it("cancels the match, boosts the female, and notifies both", async () => {
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({ venueChangeStatus: "proposed", venueChangeProposerId: "a" }),
    );
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mProfile.updateMany.mockResolvedValue({ count: 1 });

    const ctx = createCtx({ callbackData: "vchg:cancel_confirm:m1", fromId: 200 });
    await handleVenueChangeConfirmCancel(ctx);

    const update = mMatch.updateMany.mock.calls[0][0];
    expect(update.data).toMatchObject({ status: "cancelled", venueChangeStatus: "rejected" });
    // C4: female (proposer "a") gets a standby/priority comp boost, no Elo penalty.
    expect(mProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "a" } }),
    );
    expect(ctx.api.sendMessage.mock.calls[0][0]).toBe(100); // female notified
    expect(ctx.reply).toHaveBeenCalled(); // male acked
  });
});

// ---------------------------------------------------------------------------
// sweepExpiredVenueChanges
// ---------------------------------------------------------------------------

describe("sweepExpiredVenueChanges", () => {
  it("cancels a stalled proposal, boosts the female, DMs both", async () => {
    mMatch.findMany.mockResolvedValue([
      fakeMatch({ venueChangeStatus: "proposed", venueChangeProposerId: "a" }),
    ]);
    mMatch.updateMany.mockResolvedValue({ count: 1 });
    mProfile.updateMany.mockResolvedValue({ count: 1 });
    const api = fakeApi();

    const cancelled = await sweepExpiredVenueChanges(api as never, new Date());
    expect(cancelled).toBe(1);
    expect(mMatch.updateMany.mock.calls[0][0].data).toMatchObject({
      status: "cancelled",
      venueChangeStatus: "expired",
    });
    expect(mProfile.updateMany).toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(2); // both sides
  });

  it("returns 0 when nothing is due", async () => {
    mMatch.findMany.mockResolvedValue([]);
    const cancelled = await sweepExpiredVenueChanges(fakeApi() as never, new Date());
    expect(cancelled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// buildVenueChangeProposalNotice
// ---------------------------------------------------------------------------

describe("buildVenueChangeProposalNotice", () => {
  it("wraps the comment verbatim in a blockquote at the right offset", () => {
    const comment = "Cozier and closer to my metro";
    const notice = buildVenueChangeProposalNotice("en", "New Cafe — New St", comment);
    expect(notice.entities).toHaveLength(1);
    const ent = notice.entities[0];
    expect(ent.type).toBe("blockquote");
    expect(notice.text.slice(ent.offset, ent.offset + ent.length)).toBe(comment);
  });
});
