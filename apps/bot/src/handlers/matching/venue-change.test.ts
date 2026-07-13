import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    VENUE_CHANGE_FEATURE_ENABLED: true,
    VENUE_CHANGE_STARS: 150,
    WEBAPP_URL: "https://app.test",
  },
}));

// The PNG render has its own module; here we exercise the text fallback so the
// unit test stays fast and deterministic (no satori raster in this suite).
vi.mock("../../services/venue-wish-card.js", () => ({
  renderVenueWishCard: vi.fn().mockResolvedValue(null),
}));

import { prisma } from "@gennety/db";
import {
  submitVenueLikes,
  confirmVenueAgreement,
  getVenueBoardState,
  offerPartnerPay,
  declineVenuePay,
  settleVenuePayment,
  sweepExpiredVenueChanges,
  mintExpressChange,
  keepOriginalVenue,
  venueKeyOf,
  KEEP_KEY,
} from "./venue-change.js";
import type { CatalogVenue } from "../../services/venue-change.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  updateMany: MockFn;
  findMany: MockFn;
  update: MockFn;
};
const mUpdate = mMatch.update;

const HOUR = 60 * 60 * 1000;
const FAR_AGREED = new Date(Date.now() + 24 * HOUR);

function catalogVenue(placeId: string, name: string): CatalogVenue {
  return {
    source: "places",
    placeId,
    name,
    address: `${name} St`,
    lat: 50.451,
    lng: 30.521,
    mapsUri: `https://maps.google.com/${placeId}`,
    category: "cafe",
    distanceKm: 0.3,
    photoUrl: null,
    photoRefs: [`places/${placeId}/photos/x`],
    rating: 4.5,
    userRatingCount: 100,
    editorialSummary: null,
  };
}

const CATALOG = [catalogVenue("p1", "New Cafe"), catalogVenue("p2", "Park Spot")];
const loadCatalog = async () => CATALOG;

function likeOf(placeId: string, name: string) {
  const v = catalogVenue(placeId, name);
  return {
    key: venueKeyOf(v),
    placeId: v.placeId,
    name: v.name,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    mapsUri: v.mapsUri,
    category: v.category,
    photoUrl: null,
    photoRef: v.photoRefs[0],
  };
}

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
    venueChangeResolvedAt: null,
    venueChangeName: null,
    venueChangeAddress: null,
    venueChangeLat: null,
    venueChangeLng: null,
    venueChangeMapsUri: null,
    venueChangePlaceId: null,
    venueChangePhotoUrl: null,
    venueChangePhotoName: null,
    venueChangePaidById: null,
    venueChangePaidAt: null,
    venueChangePayDeclinedAt: null,
    venueChangeOfferPaySentAt: null,
    venueChangePingSentToAAt: null,
    venueChangePingSentToBAt: null,
    venueChangeExpressAt: null,
    venueLikesA: [] as unknown[],
    venueLikesB: [] as unknown[],
    userAId: "a",
    userBId: "b",
    userA: {
      id: "a",
      telegramId: 100n,
      language: "en",
      gender: "female",
      firstName: "Alina",
      universityDomain: "kyiv.edu",
    },
    userB: { id: "b", telegramId: 200n, language: "en", gender: "male", firstName: "Max" },
    ...over,
  };
}

/** Agreed-state row: she initiated, "New Cafe" agreed, payment pending. */
function agreedMatch(over: Record<string, unknown> = {}) {
  return fakeMatch({
    venueChangeStatus: "agreed",
    venueChangeProposerId: "a",
    venueChangeProposedAt: new Date(),
    venueChangeExpiresAt: new Date(Date.now() + 12 * HOUR),
    venueChangeName: "New Cafe",
    venueChangeAddress: "New Cafe St",
    venueChangeLat: 50.451,
    venueChangeLng: 30.521,
    venueChangeMapsUri: "https://maps.google.com/p1",
    venueChangePlaceId: "p1",
    venueChangePhotoName: "places/p1/photos/x",
    ...over,
  });
}

function fakeApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 555 }),
    deleteMessage: vi.fn().mockResolvedValue(true),
    sendPhoto: vi.fn().mockResolvedValue(undefined),
    createInvoiceLink: vi.fn().mockResolvedValue("https://t.me/invoice/test"),
    refundStarPayment: vi.fn().mockResolvedValue(true),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

/** updateMany calls whose data matched a predicate. */
function updateCalls(pred: (data: Record<string, unknown>) => boolean) {
  return mMatch.updateMany.mock.calls.filter((c) => pred(c[0]?.data ?? {}));
}

beforeEach(() => {
  mMatch.findUnique.mockReset();
  mMatch.updateMany.mockReset();
  mMatch.findMany.mockReset();
  mMatch.update.mockReset();
  mMatch.updateMany.mockResolvedValue({ count: 1 });
  mMatch.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// submitVenueLikes
// ---------------------------------------------------------------------------

describe("submitVenueLikes", () => {
  it("stores resolved likes, claims the initiator, and pings the partner once", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(fakeMatch());

    const res = await submitVenueLikes(api, 100n, "m1", ["p1"], { loadCatalog });
    expect(res).toEqual({ ok: true, agreed: false, kept: false, overlapCandidates: [] });

    // Likes written with server-resolved snapshots (never client data).
    const likeWrites = updateCalls((d) => Array.isArray(d.venueLikesA));
    expect(likeWrites.length).toBe(1);
    const snapshots = likeWrites[0][0].data.venueLikesA as Array<{ key: string; name: string }>;
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toMatchObject({ key: "p1", name: "New Cafe" });

    // Initiator claim CAS on the null stamp.
    expect(updateCalls((d) => d.venueChangeProposerId === "a").length).toBe(1);

    // Board-invite ping to the male, and its message id is remembered so the
    // next submission can replace it rather than stack a second one.
    expect(mUpdate.mock.calls.some((c) => c[0]?.data?.venueChangePingMsgIdB === 555)).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
  });

  it("rejects a key that is not in the server catalog", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await submitVenueLikes(fakeApi(), 100n, "m1", ["evil"], { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "invalid-venue" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("both marking KEEP → agree to keep the original: no payment, session closes", async () => {
    const api = fakeApi();
    // He already marked "keep the original"; she now marks it too → they agree
    // to stay put. Nobody pays.
    const keepLike = {
      key: KEEP_KEY,
      placeId: null,
      name: "Old Cafe",
      address: "Old St",
      lat: 50.45,
      lng: 50.52,
      mapsUri: "https://maps.google.com/old",
      category: "cafe",
      photoUrl: null,
      photoRef: null,
    };
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({
        venueChangeStatus: "liking",
        venueChangeProposerId: "b",
        venueChangeProposedAt: new Date(),
        venueLikesB: [keepLike],
      }),
    );

    const res = await submitVenueLikes(api, 100n, "m1", [KEEP_KEY], { loadCatalog });
    expect(res).toEqual({ ok: true, agreed: true, kept: true, overlapCandidates: [] });

    // Session closed back to no-session; never routed to payment.
    const close = updateCalls((d) => d.venueChangeStatus === null);
    expect(close.length).toBeGreaterThan(0);
    expect(api.createInvoiceLink).not.toHaveBeenCalled();
    // Both told they're keeping the original.
    const chats = api.sendMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(chats).toContain(100);
    expect(chats).toContain(200);
  });

  it("single overlap auto-agrees; the male initiator gets the pay-prompt DM", async () => {
    const api = fakeApi();
    // He liked p1 first (initiator = male); she now hearts p1 → agreement.
    // (She already has an unrelated like, so no first-like ping fires here.)
    const row = fakeMatch({
      venueChangeStatus: "liking",
      venueChangeProposerId: "b",
      venueChangeProposedAt: new Date(),
      venueChangePingSentToAAt: new Date(),
      venueChangePingSentToBAt: new Date(),
      venueLikesA: [likeOf("p2", "Park Spot")],
      venueLikesB: [likeOf("p1", "New Cafe")],
    });
    mMatch.findUnique.mockResolvedValue(row);

    const res = await submitVenueLikes(api, 100n, "m1", ["p1"], { loadCatalog });
    expect(res).toEqual({ ok: true, agreed: true, kept: false, overlapCandidates: [] });

    const agree = updateCalls((d) => d.venueChangeStatus === "agreed");
    expect(agree.length).toBe(1);
    expect(agree[0][0].data).toMatchObject({ venueChangeName: "New Cafe" });

    // Payer (he, the initiator) wasn't the finalizer → invoice DM to him.
    expect(api.createInvoiceLink).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
  });

  it("she initiated + he finalizes → agreement with NO DM (his in-app fork)", async () => {
    const api = fakeApi();
    const row = fakeMatch({
      venueChangeStatus: "liking",
      venueChangeProposerId: "a",
      venueChangeProposedAt: new Date(),
      venueChangePingSentToAAt: new Date(),
      venueChangePingSentToBAt: new Date(),
      venueLikesA: [likeOf("p1", "New Cafe")],
      venueLikesB: [likeOf("p2", "Park Spot")],
    });
    mMatch.findUnique.mockResolvedValue(row);

    const res = await submitVenueLikes(api, 200n, "m1", ["p1"], { loadCatalog });
    expect(res).toEqual({ ok: true, agreed: true, kept: false, overlapCandidates: [] });
    expect(updateCalls((d) => d.venueChangeStatus === "agreed").length).toBe(1);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.createInvoiceLink).not.toHaveBeenCalled();
  });

  it("multiple overlaps do NOT auto-agree — the actor picks one", async () => {
    const api = fakeApi();
    const row = fakeMatch({
      venueChangeStatus: "liking",
      venueChangeProposerId: "b",
      venueChangeProposedAt: new Date(),
      venueChangePingSentToAAt: new Date(),
      venueChangePingSentToBAt: new Date(),
      venueLikesB: [likeOf("p1", "New Cafe"), likeOf("p2", "Park Spot")],
    });
    mMatch.findUnique.mockResolvedValue(row);

    const res = await submitVenueLikes(api, 100n, "m1", ["p1", "p2"], { loadCatalog });
    expect(res).toEqual({ ok: true, agreed: false, kept: false, overlapCandidates: ["p1", "p2"] });
    expect(updateCalls((d) => d.venueChangeStatus === "agreed").length).toBe(0);
  });

  it("refuses while a (possibly hidden express) agreement is pending", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeExpressAt: new Date() }));
    const res = await submitVenueLikes(fakeApi(), 200n, "m1", ["p1"], { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "wrong-state" });
  });
});

// ---------------------------------------------------------------------------
// confirmVenueAgreement
// ---------------------------------------------------------------------------

describe("confirmVenueAgreement", () => {
  it("agrees on a venue both sides liked", async () => {
    const row = fakeMatch({
      venueChangeStatus: "liking",
      venueChangeProposerId: "a",
      venueChangeProposedAt: new Date(),
      venueLikesA: [likeOf("p1", "New Cafe"), likeOf("p2", "Park Spot")],
      venueLikesB: [likeOf("p1", "New Cafe"), likeOf("p2", "Park Spot")],
    });
    mMatch.findUnique.mockResolvedValue(row);

    const res = await confirmVenueAgreement(fakeApi(), 100n, "m1", "p2");
    expect(res).toEqual({ ok: true, kept: false });
    const agree = updateCalls((d) => d.venueChangeStatus === "agreed");
    expect(agree.length).toBe(1);
    expect(agree[0][0].data).toMatchObject({ venueChangeName: "Park Spot" });
  });

  it("rejects a venue only one side liked", async () => {
    const row = fakeMatch({
      venueChangeStatus: "liking",
      venueChangeProposerId: "a",
      venueChangeProposedAt: new Date(),
      venueLikesA: [likeOf("p1", "New Cafe")],
      venueLikesB: [],
    });
    mMatch.findUnique.mockResolvedValue(row);
    const res = await confirmVenueAgreement(fakeApi(), 100n, "m1", "p1");
    expect(res).toEqual({ ok: false, reason: "not-overlapping" });
  });
});

// ---------------------------------------------------------------------------
// Board state (payment matrix views)
// ---------------------------------------------------------------------------

describe("getVenueBoardState", () => {
  it("her fork: she initiated → pay_or_offer with price", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    const res = await getVenueBoardState(100n, "m1");
    if (!res.ok) throw new Error("expected ok");
    expect(res.state.myAction).toBe("pay_or_offer");
    expect(res.state.priceStars).toBe(150);
    expect(res.state.canOfferPartner).toBe(true);
    expect(res.state.agreed?.name).toBe("New Cafe");
  });

  it("his fork: she initiated → pay_or_decline for the male payer", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    const res = await getVenueBoardState(200n, "m1");
    if (!res.ok) throw new Error("expected ok");
    expect(res.state.myAction).toBe("pay_or_decline");
    expect(res.state.priceStars).toBe(150);
  });

  it("he initiated → he pays without a decline fork; she waits with NO price", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeProposerId: "b" }));
    const him = await getVenueBoardState(200n, "m1");
    const her = await getVenueBoardState(100n, "m1");
    if (!him.ok || !her.ok) throw new Error("expected ok");
    expect(him.state.myAction).toBe("pay");
    expect(her.state.myAction).toBe("wait");
    expect(her.state.priceStars).toBeNull();
  });

  it("an express mint is invisible to the partner", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeExpressAt: new Date() }));
    const him = await getVenueBoardState(200n, "m1");
    const her = await getVenueBoardState(100n, "m1");
    if (!him.ok || !her.ok) throw new Error("expected ok");
    expect(him.state.agreed).toBeNull();
    expect(him.state.myAction).toBeNull();
    expect(her.state.agreed?.name).toBe("New Cafe");
    expect(her.state.myAction).toBe("pay");
  });

  it("his decline hides her offer option and his own actions", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePayDeclinedAt: new Date() }));
    const her = await getVenueBoardState(100n, "m1");
    const him = await getVenueBoardState(200n, "m1");
    if (!her.ok || !him.ok) throw new Error("expected ok");
    expect(her.state.canOfferPartner).toBe(false);
    expect(her.state.myAction).toBe("pay_or_offer"); // pay-self path stays
    expect(him.state.myAction).toBeNull();
  });

  it("express is offered to her (hetero) while the board is open", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const her = await getVenueBoardState(100n, "m1");
    const him = await getVenueBoardState(200n, "m1");
    if (!her.ok || !him.ok) throw new Error("expected ok");
    expect(her.state.expressAvailable).toBe(true);
    expect(him.state.expressAvailable).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Offer-partner-pay + his final decline
// ---------------------------------------------------------------------------

describe("offerPartnerPay / declineVenuePay", () => {
  it("sends the wish card to him exactly once", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    const res = await offerPartnerPay(api, 100n, "m1");
    expect(res).toEqual({ ok: true });
    expect(updateCalls((d) => d.venueChangeOfferPaySentAt != null).length).toBe(1);
    expect(api.createInvoiceLink).toHaveBeenCalledTimes(1);
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
    expect(String(api.sendMessage.mock.calls[0][1])).toContain("Alina");
  });

  it("refuses the offer from the male / after his decline / when already sent", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    expect((await offerPartnerPay(fakeApi(), 200n, "m1")).ok).toBe(false);

    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePayDeclinedAt: new Date() }));
    expect(await offerPartnerPay(fakeApi(), 100n, "m1")).toEqual({
      ok: false,
      reason: "pay-declined",
    });

    mMatch.findUnique.mockResolvedValue(agreedMatch());
    mMatch.updateMany.mockResolvedValue({ count: 0 }); // guard already stamped
    expect(await offerPartnerPay(fakeApi(), 100n, "m1")).toEqual({
      ok: false,
      reason: "already-offered",
    });
  });

  it("his decline ENDS the change (keeps original) and never pushes her to pay", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    const res = await declineVenuePay(api, 200n, "m1");
    expect(res.ok).toBe(true);

    // The session is closed back to the assigned venue — no agreed venue left.
    const data = updateCalls((d) => d.venueChangeStatus === null)[0][0].data;
    expect(data).toMatchObject({ venueChangeName: null });
    expect(data.venueLikesA).toEqual([]);

    // She gets a neutral notice — NO invoice link, NO pay button.
    expect(api.createInvoiceLink).not.toHaveBeenCalled();
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(100);
    // Plain text DM (chatId, text) — no options object, so no pay CTA.
    expect(api.sendMessage.mock.calls[0][2]).toBeUndefined();
  });

  it("only the payer may decline; express/settled states refuse", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    expect((await declineVenuePay(fakeApi(), 100n, "m1")).ok).toBe(false);

    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeExpressAt: new Date() }));
    expect((await declineVenuePay(fakeApi(), 200n, "m1")).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Keep the original venue (the way back)
// ---------------------------------------------------------------------------

describe("keepOriginalVenue", () => {
  it("calls off an agreement, clears my marks, and tells the partner", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(
      agreedMatch({ venueLikesA: [likeOf("p1", "New Cafe")], venueLikesB: [likeOf("p1", "New Cafe")] }),
    );

    const res = await keepOriginalVenue(api, 100n, "m1");
    expect(res).toEqual({ ok: true, toldPartner: true });

    const back = updateCalls((d) => "venueLikesA" in d);
    expect(back.length).toBe(1);
    const data = back[0][0].data;
    // Agreement dropped, my marks gone, the partner's kept → session stays open.
    expect(data).toMatchObject({
      venueChangeStatus: "liking",
      venueChangeName: null,
      venueChangeExpressAt: null,
    });
    expect(data.venueLikesA).toEqual([]);
    // The match itself is never touched.
    expect(data.status).toBeUndefined();

    // The partner is told we'd rather keep the original.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
  });

  it("does NOT silently override a partner who is still suggesting — it voices a preference", async () => {
    const api = fakeApi();
    // He proposed places (has marks); she has none and taps "keep".
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({
        venueChangeStatus: "liking",
        venueChangeProposerId: "b",
        venueChangeProposedAt: new Date(),
        venueLikesB: [likeOf("p1", "New Cafe")],
      }),
    );

    const res = await keepOriginalVenue(api, 100n, "m1");
    // toldPartner → the client shows "we let them know", not "locked in".
    expect(res).toEqual({ ok: true, toldPartner: true });

    // The board stays open (his suggestion is still live), never auto-locked.
    const data = updateCalls((d) => "venueLikesA" in d)[0][0].data;
    expect(data.venueChangeStatus).toBe("liking");
    expect(data.status).toBeUndefined();

    // He gets the single "would like to keep" note in his chat.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);
  });

  it("retires the whole session, silently, when neither side has marks left", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({
        venueChangeStatus: "liking",
        venueChangeProposerId: "a",
        venueChangeProposedAt: new Date(),
        venueLikesA: [likeOf("p1", "New Cafe")],
      }),
    );

    const res = await keepOriginalVenue(api, 100n, "m1");
    expect(res).toEqual({ ok: true, toldPartner: false });
    const data = updateCalls((d) => "venueLikesA" in d)[0][0].data;
    expect(data).toMatchObject({
      venueChangeStatus: null,
      venueChangeProposerId: null,
      venueChangePayDeclinedAt: null,
    });
    // Nothing was pending for the partner, so they are not pinged.
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("stays silent when calling off her own hidden express mint", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(
      agreedMatch({ venueChangeExpressAt: new Date(), venueLikesB: [likeOf("p2", "Park Spot")] }),
    );

    const res = await keepOriginalVenue(api, 100n, "m1");
    // The partner never saw the express mint, so there is no one to tell.
    expect(res).toEqual({ ok: true, toldPartner: false });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Express mint
// ---------------------------------------------------------------------------

describe("mintExpressChange", () => {
  it("stamps the express pick for the female (hetero)", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await mintExpressChange(100n, "m1", "p1", { loadCatalog });
    expect(res).toEqual({ ok: true, venueName: "New Cafe" });
    const mint = updateCalls((d) => d.venueChangeExpressAt != null);
    expect(mint.length).toBe(1);
    expect(mint[0][0].data).toMatchObject({
      venueChangeStatus: "agreed",
      venueChangeName: "New Cafe",
      venueChangeProposerId: "a",
    });
  });

  it("refuses the male in a hetero pair", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await mintExpressChange(200n, "m1", "p1", { loadCatalog });
    expect(res).toEqual({ ok: false, reason: "not-allowed" });
  });
});

// ---------------------------------------------------------------------------
// Settle (successful_payment)
// ---------------------------------------------------------------------------

describe("settleVenuePayment", () => {
  it("copies the agreed venue onto the canonical fields and notifies both", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    const res = await settleVenuePayment(api, 200n, "m1", "charge-1");
    expect(res).toEqual({ ok: true });

    const settle = updateCalls((d) => d.venueChangeStatus === "settled");
    expect(settle.length).toBe(1);
    expect(settle[0][0].data).toMatchObject({
      venueName: "New Cafe",
      venuePhotoName: "places/p1/photos/x",
      venueChangePaidById: "b",
    });

    // Payer card + her reveal ("{name} covered it ❤️") card.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const chats = api.sendMessage.mock.calls.map((c: unknown[]) => c[0]);
    expect(chats).toContain(200);
    expect(chats).toContain(100);
    const herText = String(
      api.sendMessage.mock.calls.find((c: unknown[]) => c[0] === 100)?.[1] ?? "",
    );
    expect(herText).toContain("Max");
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });

  it("express settle sends the partner the positive-frame surprise card", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeExpressAt: new Date() }));

    const res = await settleVenuePayment(api, 100n, "m1", "charge-2");
    expect(res).toEqual({ ok: true });
    const hisText = String(
      api.sendMessage.mock.calls.find((c: unknown[]) => c[0] === 200)?.[1] ?? "",
    );
    expect(hisText).toContain("Alina");
    expect(hisText).toContain("New Cafe");
  });

  it("refunds a payment that lost the parallel-pay race", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePaidById: "a" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 });

    const res = await settleVenuePayment(api, 200n, "m1", "charge-3");
    expect(res.ok).toBe(false);
    expect(api.refundStarPayment).toHaveBeenCalledWith(200, "charge-3");
  });

  it("treats a redelivered payment from the same payer as a no-op (no refund)", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePaidById: "b" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 });

    const res = await settleVenuePayment(api, 200n, "m1", "charge-4");
    expect(res.ok).toBe(false);
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Expiry sweep
// ---------------------------------------------------------------------------

describe("sweepExpiredVenueChanges", () => {
  it("lapses an unpaid board agreement with a neutral notice to both (match untouched)", async () => {
    const api = fakeApi();
    mMatch.findMany.mockResolvedValue([agreedMatch()]);

    const n = await sweepExpiredVenueChanges(api, new Date());
    expect(n).toBe(1);

    const lapse = updateCalls((d) => d.venueChangeStatus === "lapsed");
    expect(lapse.length).toBe(1);
    // The match status is never part of the write — no cancellation, ever.
    expect(lapse[0][0].data.status).toBeUndefined();
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("quietly reverts an abandoned express mint (no DMs, board reopens)", async () => {
    const api = fakeApi();
    mMatch.findMany.mockResolvedValue([
      agreedMatch({ venueChangeExpressAt: new Date(), venueLikesA: [likeOf("p2", "Park Spot")] }),
    ]);

    const n = await sweepExpiredVenueChanges(api, new Date());
    expect(n).toBe(1);
    const revert = updateCalls((d) => d.venueChangeStatus === "liking");
    expect(revert.length).toBe(1);
    expect(revert[0][0].data).toMatchObject({ venueChangeName: null, venueChangeExpressAt: null });
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
