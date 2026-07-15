import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { t, setVariantRng } from "@gennety/shared";

// Pin the variant picker to the canonical i18n string for exact-match asserts.
setVariantRng(() => 0);
afterAll(() => setVariantRng(null));

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    WEBAPP_URL: "https://test.invalid",
  },
}));

// parseVibe / mergeParsed pull in the OpenAI wrapper — stub them so the
// vibe-save path is deterministic and offline.
vi.mock("../../services/vibe-parser.js", () => ({
  parseVibe: vi.fn().mockResolvedValue({ category: "cafe", keywords: [], safe: true }),
  mergeParsed: vi.fn().mockReturnValue({ category: "cafe", keywords: [] }),
}));

// Short-circuit finalisation so handleVenueVibe's trailing tryFinalize is a
// no-op in these unit tests (the Places pipeline is covered elsewhere).
vi.mock("../../services/venue-finalization-flight.js", () => ({
  runVenueFinalizationOnce: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import {
  startVenueNegotiation,
  handleVenueVibe,
} from "./venue-negotiation.js";
import { parseVibe } from "../../services/vibe-parser.js";
import { runVenueFinalizationOnce } from "../../services/venue-finalization-flight.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  findFirst: MockFn;
  update: MockFn;
  updateMany: MockFn;
};
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mParseVibe = parseVibe as unknown as MockFn;
const mFinalize = runVenueFinalizationOnce as unknown as MockFn;

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
  } as any;
}

beforeEach(() => {
  mMatch.findUnique.mockReset();
  mMatch.findFirst.mockReset();
  mMatch.update.mockReset().mockResolvedValue(undefined);
  mMatch.updateMany.mockReset().mockResolvedValue({ count: 1 });
  mUser.findUnique.mockReset();
  mParseVibe.mockReset().mockResolvedValue({ category: "cafe", keywords: [], safe: true });
  mFinalize.mockReset().mockResolvedValue(undefined);
});

describe("startVenueNegotiation — location-first intro", () => {
  it("opens with the departure-point ask and the map button only", async () => {
    mMatch.findUnique.mockResolvedValue({
      id: "m1",
      status: "negotiating",
      userA: { telegramId: 111n, language: "en" },
      userB: { telegramId: 222n, language: "en" },
    });

    const api = createApi();
    await startVenueNegotiation(api, "m1", new Date("2026-06-20T16:00:00Z"));

    // Atomic claim transitions to negotiating_venue and clears stale calendar
    // cards (updateMany-with-count guard so concurrent picks fire prompts once).
    expect(mMatch.updateMany).toHaveBeenCalledTimes(1);
    expect(mMatch.updateMany.mock.calls[0]![0]).toMatchObject({
      where: { status: "negotiating" },
      data: { status: "negotiating_venue" },
    });

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [, text, opts] = api.sendMessage.mock.calls[0]!;
    // The intro is the location-only copy …
    expect(text).toBe(t("en", "venueConciergeIntro"));
    // … and it does NOT pre-ask for the vibe (that's a separate, later msg).
    expect(text.toLowerCase()).not.toContain("vibe");
    // … surfaced with the Mini App map button.
    const button = opts.reply_markup.inline_keyboard[0][0];
    expect(button.web_app.url).toContain("/location.html?match=m1");
  });
});

describe("handleVenueVibe — location-first ordering", () => {
  function ctxFor(text: string) {
    return {
      message: { text },
      from: { id: 111 },
      session: { language: "en" as const },
      reply: vi.fn().mockResolvedValue(undefined),
      api: createApi(),
    } as any;
  }

  function wireSide(side: "A" | "B") {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({
      id: "m1",
      userAId: side === "A" ? "u1" : "uX",
    });
  }

  it("redirects free text to the map when no departure point is set yet", async () => {
    wireSide("A");
    // locState read: A has no pin.
    mMatch.findUnique.mockResolvedValue({
      vibeLatA: null,
      vibeLngA: null,
      vibeLatB: null,
      vibeLngB: null,
    });

    const ctx = ctxFor("quiet cafe");
    await handleVenueVibe(ctx);

    // No vibe saved, no parse, no finalisation — just a redirect.
    expect(mMatch.update).not.toHaveBeenCalled();
    expect(mParseVibe).not.toHaveBeenCalled();
    expect(mFinalize).not.toHaveBeenCalled();

    expect(ctx.reply).toHaveBeenCalledTimes(1);
    const [redirectText, opts] = ctx.reply.mock.calls[0]!;
    expect(redirectText).toBe(t("en", "venueLocationFirst"));
    expect(opts.reply_markup.inline_keyboard[0][0].web_app.url).toContain(
      "/location.html?match=m1",
    );
  });

  it("saves the vibe once the departure point is on file", async () => {
    wireSide("A");
    // First findUnique = locState (pin present); second = the post-save ACK read.
    mMatch.findUnique
      .mockResolvedValueOnce({
        vibeLatA: 50.45,
        vibeLngA: 30.52,
        vibeLatB: null,
        vibeLngB: null,
      })
      .mockResolvedValueOnce({
        vibeTextA: "quiet cafe",
        vibeTextB: null,
        vibeLatA: 50.45,
        vibeLngA: 30.52,
        vibeLatB: null,
        vibeLngB: null,
      });

    const ctx = ctxFor("quiet cafe");
    await handleVenueVibe(ctx);

    expect(mParseVibe).toHaveBeenCalledWith("quiet cafe");
    expect(mMatch.update).toHaveBeenCalledTimes(1);
    expect(mMatch.update.mock.calls[0]![0].data).toMatchObject({
      vibeTextA: "quiet cafe",
      parsedCategoryA: "cafe",
    });
    expect(mFinalize).toHaveBeenCalledTimes(1);

    // ACK fired: both sets present for side A → waiting-on-peer.
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      111,
      t("en", "venueWaitingPeer"),
      expect.any(Object),
    );
    // No redirect this time.
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});
