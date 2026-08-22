/**
 * First tests for the match-card album sender.
 *
 * This module had no coverage at all while it was the pitch's leading visual:
 * `pitch.test.ts` mocks it wholesale and `matching.test.ts` leaves
 * `MATCH_CARD_FEATURE_ENABLED` unset, so both exercise the classic fallback
 * instead. The album now also carries the partner's motion, which is exactly
 * the kind of change that wants a net underneath it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mDownload, mTexts, mRender, mFlag } = vi.hoisted(() => ({
  mDownload: vi.fn(),
  mTexts: vi.fn(),
  mRender: vi.fn(),
  mFlag: { value: true },
}));

vi.mock("../../config.js", () => ({
  env: {
    get MATCH_CARD_FEATURE_ENABLED() {
      return mFlag.value;
    },
  },
}));
vi.mock("../../demo/config.js", () => ({ PROTECT_PARTNER_MEDIA: true }));
vi.mock("../storage.js", () => ({ downloadProfileImage: mDownload }));
vi.mock("./copy.js", () => ({ generateMatchCardTexts: mTexts }));
vi.mock("./index.js", () => ({ renderMatchCardSet: mRender }));

const { sendPartnerMatchCards } = await import("./send.js");

function makeApi() {
  return { sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 1 }]) } as never;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    matchId: "match-1",
    side: "A" as const,
    partnerFirstName: "Bob",
    partnerAge: 24,
    partnerSummary: "curious",
    photos: ["file-b-1", "file-b-2"],
    profileMedia: [
      { type: "photo" as const, photo: "file-b-1" },
      { type: "photo" as const, photo: "file-b-2" },
    ],
    language: "en" as const,
    theme: "dark" as const,
    caption: { caption: "Bob, 24" },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mFlag.value = true;
  mDownload.mockResolvedValue(Buffer.from("photo-bytes"));
  mTexts.mockResolvedValue({ headline: "h", vibe: "v", body: "b" });
  mRender.mockResolvedValue([Buffer.from("card-1"), Buffer.from("card-2")]);
});

describe("sendPartnerMatchCards", () => {
  it("appends the partner's video to the card album instead of a second message", async () => {
    const api = makeApi();

    const result = await sendPartnerMatchCards(api, 1001, {
      ...input({
        profileMedia: [
          { type: "photo", photo: "file-b-1" },
          { type: "video", video: "video-b" },
        ],
      }),
    } as never);

    expect(result).toEqual({ sent: true, motionOverflow: [] });
    const [, media] = (api as unknown as { sendMediaGroup: { mock: { calls: unknown[][] } } })
      .sendMediaGroup.mock.calls[0]!;
    const items = media as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3); // 2 rendered cards + the video
    expect(items[0]!.type).toBe("photo");
    expect(items[1]!.type).toBe("photo");
    expect(items[2]).toEqual({ type: "video", media: "video-b" });
  });

  it("carries the static frame only inside the cards, never re-sent as a photo", async () => {
    const api = makeApi();

    // A Live Photo contributes its MOTION to the album; its poster frame is
    // already rendered into the PNGs, so re-sending it would duplicate the
    // profile — the whole reason `motionOnlyProfileMedia` exists.
    await sendPartnerMatchCards(api, 1001, {
      ...input({
        profileMedia: [{ type: "live_photo", photo: "poster-b", livePhoto: "motion-b" }],
      }),
    } as never);

    const [, media] = (api as unknown as { sendMediaGroup: { mock: { calls: unknown[][] } } })
      .sendMediaGroup.mock.calls[0]!;
    const items = media as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    expect(items[2]).toEqual({ type: "video", media: "motion-b" });
    expect(items.some((i) => i.media === "poster-b")).toBe(false);
  });

  it("keeps the caption and its entities on the first card only", async () => {
    const api = makeApi();

    await sendPartnerMatchCards(api, 1001, {
      ...input({
        profileMedia: [{ type: "video", video: "video-b" }],
        caption: {
          caption: "Bob, 24\n✓ Verified",
          entities: [{ type: "custom_emoji", offset: 8, length: 1, custom_emoji_id: "x" }],
        },
      }),
    } as never);

    const [, media] = (api as unknown as { sendMediaGroup: { mock: { calls: unknown[][] } } })
      .sendMediaGroup.mock.calls[0]!;
    const items = media as Array<Record<string, unknown>>;
    expect(items[0]!.caption).toBe("Bob, 24\n✓ Verified");
    expect(items[0]!.caption_entities).toHaveLength(1);
    expect(items[1]!.caption).toBeUndefined();
    // The appended video must not steal the caption either.
    expect(items[2]!.caption).toBeUndefined();
  });

  it("protects the album with the shared demo-aware flag", async () => {
    const api = makeApi();

    await sendPartnerMatchCards(api, 1001, input() as never);

    const [, , opts] = (api as unknown as { sendMediaGroup: { mock: { calls: unknown[][] } } })
      .sendMediaGroup.mock.calls[0]!;
    expect(opts).toEqual({ protect_content: true });
  });

  it("never exceeds Telegram's 10-item cap and reports what did not fit", async () => {
    // Exceeding the cap fails the WHOLE send, which would cost the user the
    // photos as well as the video — so the surplus steps out instead.
    mRender.mockResolvedValue(Array.from({ length: 5 }, (_, i) => Buffer.from(`card-${i}`)));
    const api = makeApi();

    const result = await sendPartnerMatchCards(api, 1001, {
      ...input({
        profileMedia: Array.from({ length: 7 }, (_, i) => ({
          type: "video" as const,
          video: `video-${i}`,
        })),
      }),
    } as never);

    const [, media] = (api as unknown as { sendMediaGroup: { mock: { calls: unknown[][] } } })
      .sendMediaGroup.mock.calls[0]!;
    expect(media as unknown[]).toHaveLength(10);
    expect(result).toMatchObject({ sent: true });
    expect((result as { motionOverflow: readonly unknown[] }).motionOverflow).toEqual([
      { type: "video", video: "video-5" },
      { type: "video", video: "video-6" },
    ]);
  });

  it("tells the caller to fall back when the feature flag is off", async () => {
    mFlag.value = false;
    const api = makeApi();

    expect(await sendPartnerMatchCards(api, 1001, input() as never)).toEqual({ sent: false });
    expect(
      (api as unknown as { sendMediaGroup: { mock: { calls: unknown[] } } }).sendMediaGroup.mock
        .calls,
    ).toHaveLength(0);
  });

  it("tells the caller to fall back when the render produces nothing", async () => {
    mRender.mockResolvedValue(null);

    expect(await sendPartnerMatchCards(makeApi(), 1001, input() as never)).toEqual({
      sent: false,
    });
  });

  it("tells the caller to fall back when the album send is rejected", async () => {
    const api = { sendMediaGroup: vi.fn().mockRejectedValue(new Error("nope")) } as never;

    expect(await sendPartnerMatchCards(api, 1001, input() as never)).toEqual({ sent: false });
  });
});
