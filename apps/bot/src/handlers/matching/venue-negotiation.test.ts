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

// The locked-time card rasterizes real fonts through satori — stub it so these
// unit tests stay fast and offline. The renderer has its own smoke test.
vi.mock("../../services/time-card.js", () => ({
  renderTimeCard: vi.fn().mockResolvedValue(Buffer.from("png")),
}));

// The waiting-on-peer ACK plays a ~2.5s shimmer before persisting its final
// line. Stub it so these tests assert WHICH ack fired (and with what copy)
// without burning real timers; the shimmer itself is covered in peer-wait.test.ts.
vi.mock("../../services/peer-wait.js", () => ({
  startPeerWaitShimmer: vi.fn(),
}));

import { prisma } from "@gennety/db";
import {
  startVenueNegotiation,
  handleVenueVibe,
  resolveVenueRoutingState,
} from "./venue-negotiation.js";
import { parseVibe } from "../../services/vibe-parser.js";
import { runVenueFinalizationOnce } from "../../services/venue-finalization-flight.js";
import { renderTimeCard } from "../../services/time-card.js";
import { startPeerWaitShimmer } from "../../services/peer-wait.js";

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
const mRenderTimeCard = renderTimeCard as unknown as MockFn;
const mPeerWaitShimmer = startPeerWaitShimmer as unknown as MockFn;

function createApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ message_id: 1 }),
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 2 }),
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
  mRenderTimeCard.mockReset().mockResolvedValue(Buffer.from("png"));
  mPeerWaitShimmer.mockReset();
});

describe("startVenueNegotiation — location-first intro", () => {
  it("opens with the departure-point ask and the map button only", async () => {
    mMatch.findUnique.mockResolvedValue({
      id: "m1",
      status: "negotiating",
      userA: { telegramId: 111n, language: "en", theme: "dark" },
      userB: { telegramId: 222n, language: "en", theme: "light" },
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
    expect(button.web_app.url).toContain("lang=en");
    expect(button.web_app.url).toContain("theme=dark");
    const secondButton = api.sendMessage.mock.calls[1]![2].reply_markup.inline_keyboard[0][0];
    expect(secondButton.web_app.url).toContain("theme=light");
  });

  it("announces the locked time as a card before the departure-point ask", async () => {
    mMatch.findUnique.mockResolvedValue({
      id: "m1",
      status: "negotiating",
      userA: { telegramId: 111n, language: "ru", theme: "dark" },
      userB: { telegramId: 222n, language: "en", theme: "light" },
    });

    const api = createApi();
    const agreed = new Date("2026-06-20T16:00:00Z");
    await startVenueNegotiation(api, "m1", agreed);

    // One card per side, rendered in that side's own language + theme.
    expect(api.sendPhoto).toHaveBeenCalledTimes(2);
    expect(mRenderTimeCard).toHaveBeenCalledTimes(2);
    expect(mRenderTimeCard.mock.calls[0]![0]).toMatchObject({
      agreedTime: agreed,
      language: "ru",
      theme: "dark",
    });
    expect(mRenderTimeCard.mock.calls[1]![0]).toMatchObject({
      language: "en",
      theme: "light",
    });

    // The caption is framing only: no repeated date phrase and no add-to-calendar
    // entity — the card renders the time and the final scheduled card owns the
    // tappable `date_time` affordance.
    const [chatId, , photoOpts] = api.sendPhoto.mock.calls[0]!;
    expect(chatId).toBe(111);
    expect(photoOpts.caption).toBe(t("ru", "venueTimeLockedCaption"));
    expect(photoOpts.caption_entities).toBeUndefined();
    expect(photoOpts.caption).not.toContain("📅");

    // The card frames the prompt that follows, so it must land first.
    const cardOrder = api.sendPhoto.mock.invocationCallOrder[0]!;
    const introOrder = api.sendMessage.mock.invocationCallOrder[0]!;
    expect(cardOrder).toBeLessThan(introOrder);
  });

  it("falls back to a text confirmation when the card cannot be rendered", async () => {
    mMatch.findUnique.mockResolvedValue({
      id: "m1",
      status: "negotiating",
      userA: { telegramId: 111n, language: "en", theme: "dark" },
      userB: { telegramId: -5n, language: "en", theme: "dark" }, // mobile-only
    });
    mRenderTimeCard.mockResolvedValue(null);

    const api = createApi();
    const agreed = new Date("2026-06-20T16:00:00Z");
    await startVenueNegotiation(api, "m1", agreed);

    expect(api.sendPhoto).not.toHaveBeenCalled();
    // Mobile-only side is skipped entirely: one text confirmation + one intro.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    const [, text, opts] = api.sendMessage.mock.calls[0]!;
    expect(text).toContain(t("en", "venueTimeLockedCaption"));
    expect(opts.entities[0]).toMatchObject({ type: "date_time" });
    expect(api.sendMessage.mock.calls[1]![1]).toBe(t("en", "venueConciergeIntro"));
  });

  it("still sends the concierge prompt when the card send fails", async () => {
    mMatch.findUnique.mockResolvedValue({
      id: "m1",
      status: "negotiating",
      userA: { telegramId: 111n, language: "en", theme: "dark" },
      userB: { telegramId: -5n, language: "en", theme: "dark" },
    });

    const api = createApi();
    api.sendPhoto.mockRejectedValue(new Error("telegram down"));
    await startVenueNegotiation(api, "m1", new Date("2026-06-20T16:00:00Z"));

    // Photo failed → text fallback, and the departure-point ask still goes out.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    expect(api.sendMessage.mock.calls[1]![1]).toBe(t("en", "venueConciergeIntro"));
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
        userAId: "uid-A",
        userBId: "uid-B",
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

    // Both sets present for side A → waiting-on-peer. That branch sends NO
    // message any more: the shimmer replaces the `venueWaitingPeer` line and is
    // then held for the whole wait (PRODUCT_SPEC §3.6b). The other two branches
    // still send their plain message — they hand the turn straight back.
    expect(mPeerWaitShimmer).toHaveBeenCalledWith(ctx.api, "m1", { userId: "uid-A" });
    expect(ctx.api.sendMessage).not.toHaveBeenCalled();
    // No redirect this time.
    expect(ctx.reply).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// resolveVenueRoutingState — who still owes the venue stage an answer
//
// The routing gate behind the "my picks got reset" bug: the venue stage used to
// claim EVERY plain message while the match sat in `negotiating_venue`, so a
// user who had already confirmed their departure point and vibe and asked a
// question ("what happens now?") was answered with the fixed "mark where you're
// setting off from" card + Mini App button. Nothing was written — the branch
// only replied — but the chat read as a reset, and the question never reached
// the concierge agent.
// ---------------------------------------------------------------------------
describe("resolveVenueRoutingState", () => {
  const ROW = {
    id: "m1",
    userAId: "u1",
    vibeTextA: null as string | null,
    vibeLatA: null as number | null,
    vibeLngA: null as number | null,
    vibeTextB: null as string | null,
    vibeLatB: null as number | null,
    vibeLngB: null as number | null,
  };

  it("returns null when the user has no venue negotiation", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue(null);

    expect(await resolveVenueRoutingState(111n)).toBeNull();
  });

  it("returns null for an unknown Telegram id", async () => {
    mUser.findUnique.mockResolvedValue(null);

    expect(await resolveVenueRoutingState(111n)).toBeNull();
    expect(mMatch.findFirst).not.toHaveBeenCalled();
  });

  it("marks a side that has submitted nothing as still owing an answer", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ ...ROW });

    expect(await resolveVenueRoutingState(111n)).toEqual({
      matchId: "m1",
      side: "A",
      submitted: false,
    });
  });

  it("still owes an answer with a departure point but no vibe", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ ...ROW, vibeLatA: 50.45, vibeLngA: 30.52 });

    expect((await resolveVenueRoutingState(111n))?.submitted).toBe(false);
  });

  it("still owes an answer with a vibe but no departure point", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({ ...ROW, vibeTextA: "quiet cafe" });

    expect((await resolveVenueRoutingState(111n))?.submitted).toBe(false);
  });

  it("reports a complete submission as submitted, so text falls through to the agent", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u1" });
    mMatch.findFirst.mockResolvedValue({
      ...ROW,
      vibeTextA: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
    });

    expect(await resolveVenueRoutingState(111n)).toEqual({
      matchId: "m1",
      side: "A",
      submitted: true,
    });
  });

  it("reads the caller's OWN side — a submitted partner does not count", async () => {
    // Caller is side B; side A is complete, B has nothing.
    mUser.findUnique.mockResolvedValue({ id: "u2" });
    mMatch.findFirst.mockResolvedValue({
      ...ROW,
      userAId: "u1",
      vibeTextA: "quiet cafe",
      vibeLatA: 50.45,
      vibeLngA: 30.52,
    });

    expect(await resolveVenueRoutingState(222n)).toEqual({
      matchId: "m1",
      side: "B",
      submitted: false,
    });
  });

  it("resolves side B's own complete submission", async () => {
    mUser.findUnique.mockResolvedValue({ id: "u2" });
    mMatch.findFirst.mockResolvedValue({
      ...ROW,
      userAId: "u1",
      vibeTextB: "park walk",
      vibeLatB: 50.45,
      vibeLngB: 30.52,
    });

    expect((await resolveVenueRoutingState(222n))?.submitted).toBe(true);
  });
});
