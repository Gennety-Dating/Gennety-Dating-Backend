import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Guards the ordering that keeps the venue photo ON the date card.
 *
 * Both sides of a match show the same venue, and both cards are rendered under
 * one `Promise.all`. A card's rasterize (satori → resvg, plus the canvas
 * duotone/grain) is synchronous native work that blocks the event loop for tens
 * of seconds — so a venue-photo fetch started INSIDE a render cannot progress
 * while the other side rasterizes, and its wall-clock `AbortSignal.timeout`
 * runs out. Measured on a real match: the fetch takes ~2.5s on a free loop and
 * returns null when the loop is blocked for 9s. Both delivered cards then fell
 * back to the branded gradient, indistinguishable from a venue that simply has
 * no picture — which is why this needs a test rather than a comment.
 */

// `vi.hoisted` — a `vi.mock` factory is lifted above ordinary top-level
// declarations, so plain consts would be in the TDZ when it runs.
const { renderDateCard, prepareVenuePhoto } = vi.hoisted(() => ({
  renderDateCard: vi.fn(),
  prepareVenuePhoto: vi.fn(),
}));

vi.mock("./date-card/index.js", () => ({
  renderDateCard,
  prepareVenuePhoto,
  buildShareButton: () => ({ text: "share", callback_data: "datecard:share:m1" }),
}));

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: { DATE_CARD_FEATURE_ENABLED: true },
}));

vi.mock("./venue-blurb.js", () => ({
  generateVenueBlurb: vi.fn().mockResolvedValue("A quiet corner cafe."),
}));

vi.mock("./founder-notify.js", () => ({
  notifyFounderDateScheduled: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../handlers/matching/venue-change.js", () => ({
  shouldOfferVenueChange: () => false,
  buildVenueChangeButton: () => ({ text: "change", callback_data: "x" }),
}));

vi.mock("./ai-stream.js", () => ({
  runStatusSequence: vi.fn().mockResolvedValue(undefined),
  NEVER_CUT_SHORT: -1,
  dateCardSteps: () => [],
}));

vi.mock("./status-banner-refresh.js", () => ({
  refreshStatusBanners: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import { deliverScheduledConfirmation } from "./scheduled-confirmation.js";
import { type Venue } from "./venue.js";

// Typed as the real `Venue` rather than cast away, so `VENUE.photoName` below is
// the field the code actually reads — an `as never` fixture cannot be asserted
// against at all (its properties do not exist to the compiler).
const VENUE: Venue = {
  name: "Lviv Coffee",
  address: "Khreshchatyk 14, Kyiv",
  googleMapsUri: "https://maps.google.com/?cid=1",
  lat: 50.45,
  lng: 30.52,
  photoName: "places/ChIJ/photos/abc",
};

function stubMatch() {
  const side = (id: string, tg: bigint, name: string) => ({
    id,
    telegramId: tg,
    language: "en",
    theme: "dark",
    gender: "male",
    age: 28,
    firstName: name,
    profile: { photos: [], homeCity: "Kyiv" },
  });
  (prisma.match.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "m1",
    agreedTime: new Date("2026-05-16T16:00:00Z"),
    userA: side("ua", 111n, "Anna"),
    userB: side("ub", 222n, "Boris"),
  });
}

function stubApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 2, photo: [{ file_id: "f1" }] }),
  } as never;
}

describe("deliverScheduledConfirmation — venue photo ordering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stubMatch();
    prepareVenuePhoto.mockResolvedValue(Buffer.from("venue-png"));
    renderDateCard.mockResolvedValue(null); // text fallback keeps the test fast
  });

  it("resolves the venue photo ONCE for a pair, not once per side", async () => {
    await deliverScheduledConfirmation(stubApi(), "m1", {
      venue: VENUE,
      category: "cafe" as never,
      keywords: [],
    });

    // Two cards, one fetch. Per side it was two billed Places media requests
    // and two duotones for a byte-identical result.
    expect(renderDateCard).toHaveBeenCalledTimes(2);
    expect(prepareVenuePhoto).toHaveBeenCalledTimes(1);
    expect(prepareVenuePhoto).toHaveBeenCalledWith(VENUE.photoName);
  });

  it("has the photo SETTLED before either render starts", async () => {
    // The load-bearing half, and the flag has to be set after a real tick:
    // an async function's body runs synchronously up to its first `await`, so
    // a flag set on entry would be true even for a promise nobody awaited —
    // i.e. the test would pass while the fetch raced the render, which is the
    // bug itself. Awaiting inside the mock is what makes this falsifiable.
    let photoSettled = false;
    prepareVenuePhoto.mockImplementation(async () => {
      await Promise.resolve();
      photoSettled = true;
      return Buffer.from("venue-png");
    });
    renderDateCard.mockImplementation(async () => {
      expect(photoSettled).toBe(true);
      return null;
    });

    await deliverScheduledConfirmation(stubApi(), "m1", {
      venue: VENUE,
      category: "cafe" as never,
      keywords: [],
    });

    expect(renderDateCard).toHaveBeenCalledTimes(2);
  });

  it("hands BOTH sides the same prepared buffer", async () => {
    await deliverScheduledConfirmation(stubApi(), "m1", {
      venue: VENUE,
      category: "cafe" as never,
      keywords: [],
    });

    const [, optsA] = renderDateCard.mock.calls[0]!;
    const [, optsB] = renderDateCard.mock.calls[1]!;
    // `undefined` would mean "resolve it yourself" — i.e. the fetch is back
    // inside the render, which is the bug.
    expect(optsA.venuePhoto).toBeInstanceOf(Buffer);
    expect(optsB.venuePhoto).toBe(optsA.venuePhoto);
  });

  it("still delivers when the venue has no usable photo", async () => {
    // A missing photo means the branded gradient, never a lost card.
    prepareVenuePhoto.mockResolvedValue(null);

    await deliverScheduledConfirmation(stubApi(), "m1", {
      venue: VENUE,
      category: "cafe" as never,
      keywords: [],
    });

    expect(renderDateCard).toHaveBeenCalledTimes(2);
    const [, optsA] = renderDateCard.mock.calls[0]!;
    expect(optsA.venuePhoto).toBeNull();
  });
});
