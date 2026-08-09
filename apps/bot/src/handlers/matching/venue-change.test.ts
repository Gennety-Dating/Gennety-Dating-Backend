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
    venueChangePurchase: {
      create: vi.fn(),
      update: vi.fn(),
      findMany: vi.fn(),
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

// The pinned-banner push has its own suite (services/status-banner-refresh);
// here we only assert that a settled change actually fires it.
vi.mock("../../services/status-banner-refresh.js", () => ({
  refreshStatusBanners: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import {
  submitVenueLikes,
  confirmVenueAgreement,
  getVenueBoardState,
  getVenueChangeCatalog,
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
import { refreshStatusBanners } from "../../services/status-banner-refresh.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  updateMany: MockFn;
  findMany: MockFn;
  update: MockFn;
};
const mUpdate = mMatch.update;
const mPurchase = (prisma as unknown as {
  venueChangePurchase: { create: MockFn; update: MockFn; findMany: MockFn };
}).venueChangePurchase;

/** Prisma unique-constraint violation — a redelivered `successful_payment`. */
function uniqueViolation(): Error & { code: string } {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
}

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
    tier: "base",
    distanceKm: 0.3,
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
    venueChangePhotoName: null,
    venueChangePaidById: null,
    venueChangePaidAt: null,
    venueChangePayDeclinedAt: null,
    venueChangeOfferPaySentAt: null,
    venueChangePingSentToAAt: null,
    venueChangePingSentToBAt: null,
    venueChangeExpressAt: null,
    venueChangeTier: null,
    venueChangeCount: 0,
    venueChangePingMsgIdA: null,
    venueChangePingMsgIdB: null,
    venueLikesA: [] as unknown[],
    venueLikesB: [] as unknown[],
    userAId: "a",
    userBId: "b",
    userA: {
      id: "a",
      telegramId: 100n,
      language: "en",
      theme: "dark",
      gender: "female",
      firstName: "Alina",
      universityDomain: "kyiv.edu",
      profile: { homeCityKey: "ua:kyiv" },
    },
    userB: {
      id: "b",
      telegramId: 200n,
      language: "en",
      theme: "light",
      gender: "male",
      firstName: "Max",
      universityDomain: null,
      profile: { homeCityKey: null },
    },
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
  mPurchase.create.mockReset();
  mPurchase.update.mockReset();
  mPurchase.findMany.mockReset();
  // Default: this charge id is new (no redelivery).
  mPurchase.create.mockResolvedValue({
    id: "vp1",
    status: "processing",
    externalPaymentId: "charge-1",
  });
  mPurchase.update.mockResolvedValue({});
});

// ---------------------------------------------------------------------------
// getVenueChangeCatalog — city/domain scope (regression: userA-only read)
// ---------------------------------------------------------------------------

describe("getVenueChangeCatalog — catalog scope", () => {
  it("scopes by userA's cityKey/domain when present", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const spy = vi.fn().mockResolvedValue([]);

    await getVenueChangeCatalog(100n, "m1", new Date(), spy);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cityKey: "ua:kyiv", universityDomain: "kyiv.edu" }),
    );
  });

  it("falls back to userB's cityKey/domain when userA has neither (general/phone-track userA)", async () => {
    // This is the exact shape that silently emptied the curated catalog
    // (base + premium + alternative) in production: a general-track userA
    // paired with a student userB. Reading only `userA` returned {} scope and
    // the board fell through to the un-tiered Places fallback.
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({
        userA: {
          id: "a",
          telegramId: 100n,
          language: "en",
          theme: "dark",
          gender: "female",
          firstName: "Alina",
          universityDomain: null,
          profile: { homeCityKey: null },
        },
        userB: {
          id: "b",
          telegramId: 200n,
          language: "en",
          theme: "light",
          gender: "male",
          firstName: "Max",
          universityDomain: "kpi.ua",
          profile: { homeCityKey: "ua:kyiv" },
        },
      }),
    );
    const spy = vi.fn().mockResolvedValue([]);

    await getVenueChangeCatalog(100n, "m1", new Date(), spy);

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ cityKey: "ua:kyiv", universityDomain: "kpi.ua" }),
    );
  });

  it("passes null scope through (never crashes) when neither side has a city or domain", async () => {
    mMatch.findUnique.mockResolvedValue(
      fakeMatch({
        userA: {
          id: "a",
          telegramId: 100n,
          language: "en",
          theme: "dark",
          gender: "female",
          firstName: "Alina",
          universityDomain: null,
          profile: { homeCityKey: null },
        },
        userB: {
          id: "b",
          telegramId: 200n,
          language: "en",
          theme: "light",
          gender: "male",
          firstName: "Max",
          universityDomain: null,
          profile: { homeCityKey: null },
        },
      }),
    );
    const spy = vi.fn().mockResolvedValue([]);

    const res = await getVenueChangeCatalog(100n, "m1", new Date(), spy);

    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ cityKey: null, universityDomain: null }));
    expect(res).toEqual({ ok: true, venues: [] });
  });
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

    // Payer (he, the initiator) wasn't the finalizer → prompt DM to him.
    expect(api.sendMessage).toHaveBeenCalledTimes(1);
    expect(api.sendMessage.mock.calls[0][0]).toBe(200);

    // It opens the BOARD, never a bare Stars invoice: this side never saw the
    // agreed screen, so the message is their only route to the venue AND to
    // "keep this place". A url-to-invoice button was a one-way door to the
    // payment sheet.
    expect(api.createInvoiceLink).not.toHaveBeenCalled();
    const kb = api.sendMessage.mock.calls[0][2].reply_markup.inline_keyboard;
    expect(kb[0][0].web_app.url).toContain("venue-change.html");
    expect(kb[0][0].web_app.url).toContain("match=m1");
    expect(kb[0][0].url).toBeUndefined();
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
  // The pinned "keep this place" card was the one card on the board with no
  // picture, because the assigned venue is excluded from the catalog and the
  // state never carried its imagery. The cover stored at assignment is what
  // fixes it — and the client can only draw what this endpoint sends.
  it("carries the assigned venue's stored cover photo", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch({ venuePhotoName: "places/old/photos/a" }));
    const res = await getVenueBoardState(100n, "m1");
    if (!res.ok) throw new Error("expected ok");
    expect(res.state.original.photoRefs).toEqual(["places/old/photos/a"]);
  });

  it("answers with no photo rather than failing when the row carries none", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await getVenueBoardState(100n, "m1");
    if (!res.ok) throw new Error("expected ok");
    expect(res.state.original.photoRefs).toEqual([]);
    expect(res.state.original.name).toBe("Old Cafe");
  });

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

  it("an express mint is invisible to the partner (and flagged to the minter)", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangeExpressAt: new Date() }));
    const him = await getVenueBoardState(200n, "m1");
    const her = await getVenueBoardState(100n, "m1");
    if (!him.ok || !her.ok) throw new Error("expected ok");
    expect(him.state.agreed).toBeNull();
    expect(him.state.myAction).toBeNull();
    expect(him.state.express).toBe(false);
    expect(her.state.agreed?.name).toBe("New Cafe");
    expect(her.state.myAction).toBe("pay");
    // The minter's own view is flagged express so the Mini App drops the
    // "your match chose this too" copy (the partner never saw it).
    expect(her.state.express).toBe(true);
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
    // No card rendered, so the text is the ONLY thing naming the place he is
    // being asked to pay for — it must carry the venue.
    const text = String(api.sendMessage.mock.calls[0][1]);
    expect(text).toContain("Alina");
    expect(text).toContain("New Cafe");
  });

  it("does not repeat the venue in the caption when the card rendered", async () => {
    const api = fakeApi();
    const { renderVenueWishCard } = await import("../../services/venue-wish-card.js");
    vi.mocked(renderVenueWishCard).mockResolvedValueOnce(Buffer.from("png"));
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    expect(await offerPartnerPay(api, 100n, "m1")).toEqual({ ok: true });
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(api.sendPhoto).toHaveBeenCalledTimes(1);
    const caption = String(api.sendPhoto.mock.calls[0][2].caption);
    expect(caption).toContain("Alina");
    // The PNG already shows the name + address.
    expect(caption).not.toContain("New Cafe");
  });

  it("releases the one-shot stamp when the card never reached his chat", async () => {
    const api = fakeApi();
    api.sendMessage.mockRejectedValue(new Error("telegram down"));
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    // The Mini App tells her the card landed, so a failed send must report a
    // failure AND leave the offer retryable rather than burning it.
    expect(await offerPartnerPay(api, 100n, "m1")).toEqual({
      ok: false,
      reason: "send-failed",
    });
    const released = updateCalls((d) => d.venueChangeOfferPaySentAt === null);
    expect(released.length).toBe(1);
    // Scoped to OUR claim, so a concurrent success/settle is never reopened.
    expect(released[0][0].where).toMatchObject({ id: "m1" });
    expect(released[0][0].where.venueChangeOfferPaySentAt).toBeInstanceOf(Date);
  });

  it("refuses the offer from the male / when already sent", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    expect((await offerPartnerPay(fakeApi(), 200n, "m1")).ok).toBe(false);

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
    expect(res).toEqual({ ok: true, venueName: "New Cafe", free: false });
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

  it("pushes the pinned banner so it stops naming the old venue", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    await settleVenuePayment(api, 200n, "m1", "charge-1");

    // Without this the banner keeps the old place for up to a minute, until
    // the next status-timer tick — see services/status-banner-refresh.ts.
    expect(refreshStatusBanners).toHaveBeenCalledTimes(1);
    expect(vi.mocked(refreshStatusBanners).mock.calls[0]![1]).toEqual(["a", "b"]);
  });

  it("a settle survives the banner push failing", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    vi.mocked(refreshStatusBanners).mockRejectedValueOnce(new Error("telegram down"));

    // Cosmetic re-render, irreversible product step: the order matters.
    await expect(
      settleVenuePayment(api, 200n, "m1", "charge-1"),
    ).resolves.toEqual({ ok: true });
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

  it("records the charge BEFORE the settle CAS, then marks it settled", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    await settleVenuePayment(api, 200n, "m1", "charge-1");

    // The durable record is what makes a crash mid-settle recoverable.
    expect(mPurchase.create).toHaveBeenCalledTimes(1);
    expect(mPurchase.create.mock.calls[0][0].data).toMatchObject({
      userId: "b",
      matchId: "m1",
      status: "processing",
      externalPaymentId: "charge-1",
      amountStars: 150,
    });
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "vp1" },
        data: expect.objectContaining({ status: "settled" }),
      }),
    );
  });

  it("treats a redelivered payment (duplicate charge id) as an idempotent no-op", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    mPurchase.create.mockRejectedValue(uniqueViolation());

    const res = await settleVenuePayment(api, 200n, "m1", "charge-4");
    expect(res).toEqual({ ok: true });
    // Nothing is claimed and nothing is refunded — the first delivery did it all.
    expect(mMatch.updateMany).not.toHaveBeenCalled();
    expect(api.refundStarPayment).not.toHaveBeenCalled();
  });

  it("refunds a payment that lost the parallel-pay race", async () => {
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePaidById: "a" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    mPurchase.create.mockResolvedValue({
      id: "vp3",
      status: "processing",
      externalPaymentId: "charge-3",
    });

    const res = await settleVenuePayment(api, 200n, "m1", "charge-3");
    expect(res.ok).toBe(false);
    expect(api.refundStarPayment).toHaveBeenCalledWith(200, "charge-3");
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refunded_race" }),
      }),
    );
  });

  it("refunds a SECOND distinct charge from the same payer (double-pay race)", async () => {
    // The old `venueChangePaidById === payer.id` heuristic read this as a
    // redelivery and silently kept the money. A distinct charge id proves it is
    // a real second payment.
    const api = fakeApi();
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePaidById: "b" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    mPurchase.create.mockResolvedValue({
      id: "vp5",
      status: "processing",
      externalPaymentId: "charge-5",
    });

    const res = await settleVenuePayment(api, 200n, "m1", "charge-5");
    expect(res.ok).toBe(false);
    expect(api.refundStarPayment).toHaveBeenCalledWith(200, "charge-5");
  });

  it("parks a failed refund in refund_failed and never claims it succeeded", async () => {
    const api = fakeApi();
    api.refundStarPayment.mockRejectedValue(new Error("telegram down"));
    mMatch.findUnique.mockResolvedValue(agreedMatch({ venueChangePaidById: "a" }));
    mMatch.updateMany.mockResolvedValue({ count: 0 });
    mPurchase.create.mockResolvedValue({
      id: "vp6",
      status: "processing",
      externalPaymentId: "charge-6",
    });

    const res = await settleVenuePayment(api, 200n, "m1", "charge-6");
    expect(res.ok).toBe(false);
    expect(mPurchase.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "refund_failed" }),
      }),
    );
    // The user is never told their Stars came back when they did not.
    expect(api.sendMessage).not.toHaveBeenCalled();
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

describe("premium venue gating + fee waiver (§Premium)", () => {
  const premiumVenue = (): CatalogVenue => ({ ...catalogVenue("prem1", "Rooftop"), tier: "premium" });
  const premiumUntil = new Date(Date.now() + 30 * 24 * HOUR);

  it("rejects a premium pick when neither participant is premium", async () => {
    mMatch.findUnique.mockResolvedValue(fakeMatch());
    const res = await submitVenueLikes(fakeApi(), 100n, "m1", ["prem1"], {
      loadCatalog: async () => [premiumVenue()],
    });
    expect(res).toEqual({ ok: false, reason: "premium-locked" });
  });

  it("allows a premium pick when either participant is premium", async () => {
    const base = fakeMatch();
    mMatch.findUnique.mockResolvedValue({
      ...base,
      userA: { ...base.userA, premiumUntil },
    });
    const res = await submitVenueLikes(fakeApi(), 100n, "m1", ["prem1"], {
      loadCatalog: async () => [premiumVenue()],
    });
    expect(res.ok).toBe(true);
  });

  it("exposes pairPremiumActive=false + premiumWouldWaive for a non-premium payer", async () => {
    // agreed, base venue, she initiated → the male (userB, non-premium) is the payer.
    mMatch.findUnique.mockResolvedValue(agreedMatch());
    const he = await getVenueBoardState(200n, "m1");
    expect(he.ok).toBe(true);
    if (he.ok) {
      expect(he.state.pairPremiumActive).toBe(false);
      expect(he.state.premiumWouldWaive).toBe(true);
    }
  });

  it("reports pairPremiumActive=true when a participant is premium", async () => {
    const agreed = agreedMatch();
    mMatch.findUnique.mockResolvedValue({
      ...agreed,
      userA: { ...agreed.userA, premiumUntil },
    });
    const she = await getVenueBoardState(100n, "m1");
    expect(she.ok).toBe(true);
    if (she.ok) expect(she.state.pairPremiumActive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Restarting a finished session (PRODUCT_SPEC §3.7b — up to
// VENUE_CHANGE_MAX_PER_DATE settled changes per date)
// ---------------------------------------------------------------------------

/** A date whose first change settled: one allowance spent, one left. */
function settledMatch(over: Record<string, unknown> = {}) {
  return fakeMatch({
    venueChangeStatus: "settled",
    venueChangeCount: 1,
    // The settle copied the new venue onto the canonical fields...
    venueName: "New Cafe",
    venueAddress: "New Cafe St",
    venuePlaceId: "p1",
    // ...and left the whole finished session sitting in its one slot.
    venueChangeProposerId: "a",
    venueChangeProposedAt: new Date(),
    venueChangeResolvedAt: new Date(),
    venueChangePaidById: "b",
    venueChangePaidAt: new Date(),
    venueChangeOfferPaySentAt: new Date(),
    venueChangeName: "New Cafe",
    venueChangePlaceId: "p1",
    venueLikesA: [likeOf("p1", "New Cafe")] as unknown[],
    venueLikesB: [likeOf("p1", "New Cafe")] as unknown[],
    ...over,
  });
}

describe("venue change — a second round on a finished session", () => {
  it("REGRESSION: the partner's round-one hearts cannot agree round two", async () => {
    // The whole reason a restart is a reset and not a flag flip. Both sides
    // hearted "New Cafe" last round; she now hearts it again to start a new
    // one. Reading the pre-write snapshot's peer likes would see an overlap on
    // the venue they ALREADY moved to and lock it in as a fresh (chargeable)
    // change nobody is currently making.
    mMatch.findUnique.mockResolvedValue(settledMatch());

    const res = await submitVenueLikes(fakeApi(), 100n, "m1", [venueKeyOf(CATALOG[0])], {
      loadCatalog,
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.agreed).toBe(false);
      expect(res.overlapCandidates).toEqual([]);
    }
    // Nothing may have been promoted to `agreed`.
    expect(updateCalls((d) => d.venueChangeStatus === "agreed")).toHaveLength(0);
  });

  it("claims FROM the terminal status and wipes the whole session in one write", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch());

    await submitVenueLikes(fakeApi(), 100n, "m1", [venueKeyOf(CATALOG[0])], { loadCatalog });

    const claim = mMatch.updateMany.mock.calls.find(
      (c) => (c[0]?.data ?? {}).venueChangeStatus === "liking",
    );
    expect(claim).toBeDefined();
    // The finished status is the thing being claimed — that is what makes the
    // reset and the claim one atomic statement rather than two.
    expect(claim?.[0].where).toMatchObject({
      venueChangeStatus: { in: ["settled", "lapsed"] },
    });
    const data = claim?.[0].data ?? {};
    // Both like columns, not just the restarter's.
    expect(data.venueLikesB).toEqual([]);
    // Every stamp that would otherwise leak from the finished round.
    expect(data.venueChangeProposerId).toBeNull();
    expect(data.venueChangeProposedAt).toBeNull();
    expect(data.venueChangeOfferPaySentAt).toBeNull();
    expect(data.venueChangePaidAt).toBeNull();
    expect(data.venueChangePaidById).toBeNull();
    expect(data.venueChangeName).toBeNull();
    // NOT reset: the allowance already spent.
    expect(data.venueChangeCount).toBeUndefined();
  });

  it("restarts after a lapse, which costs no allowance", async () => {
    mMatch.findUnique.mockResolvedValue(
      settledMatch({ venueChangeStatus: "lapsed", venueChangeCount: 0 }),
    );

    const res = await submitVenueLikes(fakeApi(), 100n, "m1", [venueKeyOf(CATALOG[0])], {
      loadCatalog,
    });

    expect(res.ok).toBe(true);
    expect(updateCalls((d) => d.venueChangeStatus === "liking")).not.toHaveLength(0);
  });

  it("refuses once every allowed change is spent", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch({ venueChangeCount: 2 }));

    const res = await submitVenueLikes(fakeApi(), 100n, "m1", [venueKeyOf(CATALOG[0])], {
      loadCatalog,
    });

    expect(res).toEqual({ ok: false, reason: "budget-spent" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("treats an empty submission on a finished board as a no-op, not a restart", async () => {
    // Deselecting everything must not wipe the settled record (and its
    // "{name} covered it" reveal) in exchange for a round that never starts.
    mMatch.findUnique.mockResolvedValue(settledMatch());

    const res = await submitVenueLikes(fakeApi(), 100n, "m1", [], { loadCatalog });

    expect(res.ok).toBe(true);
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("resets the session on an express restart too", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch());

    const res = await mintExpressChange(100n, "m1", venueKeyOf(CATALOG[1]), { loadCatalog });

    expect(res.ok).toBe(true);
    const mint = mMatch.updateMany.mock.calls.find(
      (c) => (c[0]?.data ?? {}).venueChangeExpressAt != null,
    );
    expect(mint?.[0].where).toMatchObject({ venueChangeStatus: { in: ["settled", "lapsed"] } });
    // The reset runs first, so the express fields it writes still win.
    expect(mint?.[0].data.venueLikesA).toEqual([]);
    expect(mint?.[0].data.venueLikesB).toEqual([]);
    expect(mint?.[0].data.venueChangeName).toBe("Park Spot");
    expect(mint?.[0].data.venueChangeProposerId).toBe("a");
  });

  it("keep-original still refuses a finished session outright", async () => {
    // The payoff of the two-predicate split: this path never learned about
    // restarts, so it cannot resurrect a `liking` state out of stale likes.
    mMatch.findUnique.mockResolvedValue(settledMatch());

    const res = await keepOriginalVenue(fakeApi(), 100n, "m1");

    expect(res).toEqual({ ok: false, reason: "already-changed" });
    expect(mMatch.updateMany).not.toHaveBeenCalled();
  });

  it("serves the catalog for a restartable session so 'change again' lands on cards", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch());
    const spy = vi.fn().mockResolvedValue(CATALOG);

    const res = await getVenueChangeCatalog(100n, "m1", new Date(), spy);

    expect(res.ok).toBe(true);
    expect(spy).toHaveBeenCalled();
  });

  it("refuses the catalog once the allowance is spent", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch({ venueChangeCount: 2 }));
    const spy = vi.fn().mockResolvedValue(CATALOG);

    const res = await getVenueChangeCatalog(100n, "m1", new Date(), spy);

    expect(res).toEqual({ ok: false, reason: "budget-spent" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("reports a finished session as an EMPTY board with the restart offer", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch());

    const res = await getVenueBoardState(100n, "m1");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.restartable).toBe(true);
      expect(res.state.changesUsed).toBe(1);
      expect(res.state.settled).not.toBeNull();
      // The columns still hold last round's hearts; the client must not see
      // them as live, because the next write deletes them.
      expect(res.state.myLikes).toEqual([]);
      expect(res.state.peerLikes).toEqual([]);
      // Still closed: a restart is an explicit tap, never an auto-reopen under
      // a success screen the user is still reading.
      expect(res.state.open).toBe(false);
    }
  });

  it("stops offering a restart once the allowance is spent", async () => {
    mMatch.findUnique.mockResolvedValue(settledMatch({ venueChangeCount: 2 }));

    const res = await getVenueBoardState(100n, "m1");

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.state.restartable).toBe(false);
      expect(res.state.changesUsed).toBe(2);
    }
  });

  it("spends one allowance per settle, inside the settling CAS", async () => {
    mMatch.findUnique.mockResolvedValue(agreedMatch());

    await settleVenuePayment(fakeApi(), 200n, "m1", "charge-1");

    const settle = mMatch.updateMany.mock.calls.find(
      (c) => (c[0]?.data ?? {}).venueChangeStatus === "settled",
    );
    expect(settle?.[0].data.venueChangeCount).toEqual({ increment: 1 });
  });
});
