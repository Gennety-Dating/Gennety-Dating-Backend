/**
 * Integration tests for the welcome-gift pre-roll wired into `sendMatchProposal`.
 * The grant (`grantWelcomeGiftIfEligible`) and the sender (`sendWelcomeGiftPreroll`)
 * are mocked as spies so we assert ONLY the dispatch wiring: that the gift fires
 * before the pitch on a granted first pitch, is skipped when the grant reports
 * "already gifted", and never touches mobile-only (negative telegramId) users.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mFindUnique, mUpdate, mGrant, mPreroll, mCards, mMedia, mMotion } = vi.hoisted(() => ({
  mFindUnique: vi.fn(),
  mUpdate: vi.fn(),
  mGrant: vi.fn(),
  mPreroll: vi.fn(),
  mCards: vi.fn(),
  mMedia: vi.fn(),
  mMotion: vi.fn(),
}));

vi.mock("@gennety/db", () => ({
  prisma: { match: { findUnique: mFindUnique, update: mUpdate } },
}));

vi.mock("../../config.js", () => ({
  env: {
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    CUSTOM_EMOJI_VERIFIED_ID: "",
  },
}));

vi.mock("../../services/ticket-wallet.js", () => ({
  grantWelcomeGiftIfEligible: mGrant,
}));
vi.mock("../../services/welcome-gift.js", () => ({
  sendWelcomeGiftPreroll: mPreroll,
}));
vi.mock("../../services/match-card/send.js", () => ({
  sendPartnerMatchCards: mCards,
}));
vi.mock("../../services/profile-media-dispatch.js", () => ({
  sendProfileMediaCard: mMedia,
  sendMotionProfileMedia: mMotion,
}));

const { sendMatchProposal, sendMatchWelcomeGiftPreroll } = await import("./pitch.js");

function makeApi() {
  return {
    token: "test-bot-token",
    sendPhoto: vi.fn().mockResolvedValue({ message_id: 9001 }),
    sendMediaGroup: vi.fn().mockResolvedValue([{ message_id: 9001 }]),
    sendLivePhoto: vi.fn().mockResolvedValue({ message_id: 9000 }),
    sendMessage: vi.fn().mockResolvedValue({ message_id: 9002 }),
  } as any;
}

function payload(overrides: { telegramIdA?: bigint; telegramIdB?: bigint } = {}) {
  return {
    id: "match-1",
    status: "proposed",
    // Nullable so a test can model an ungenerated / legacy row.
    pitchForA: "You two click." as string | null,
    pitchForB: "You two click." as string | null,
    synergyScore: 87 as number | null,
    synergyReason: "Aligned values." as string | null,
    synergyReasonB: "Aligned values." as string | null,
    pitchMessageIdA: null,
    pitchMessageIdB: null,
    userA: {
      id: "ua",
      telegramId: overrides.telegramIdA ?? 1001n,
      firstName: "Alice",
      age: 22,
      gender: "female",
      language: "en",
      verificationStatus: "unverified",
      profile: { psychologicalSummary: "warm", photos: ["file-a-1"], profileMedia: [] },
    },
    userB: {
      id: "ub",
      telegramId: overrides.telegramIdB ?? 1002n,
      firstName: "Bob",
      age: 24,
      gender: "male",
      language: "en",
      verificationStatus: "unverified",
      profile: { psychologicalSummary: "curious", photos: ["file-b-1"], profileMedia: [] },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mUpdate.mockResolvedValue({ id: "match-1" });
  mCards.mockResolvedValue(false);
  mMedia.mockResolvedValue(undefined);
  mMotion.mockResolvedValue(undefined);
});

describe("sendMatchProposal — welcome-gift pre-roll", () => {
  it("grants + delivers the pre-roll to both sides on a first pitch", async () => {
    mFindUnique.mockResolvedValue(payload());
    mGrant.mockResolvedValue({ granted: true, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    expect(mGrant).toHaveBeenCalledTimes(2);
    expect(mGrant).toHaveBeenCalledWith("ua");
    expect(mGrant).toHaveBeenCalledWith("ub");
    expect(mPreroll).toHaveBeenCalledTimes(2);
    expect(mPreroll).toHaveBeenCalledWith(api, 1001, "en", "female");
    expect(mPreroll).toHaveBeenCalledWith(api, 1002, "en", "male");
  });

  it("does not deliver the pre-roll when the grant reports already-gifted", async () => {
    mFindUnique.mockResolvedValue(payload());
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    expect(mGrant).toHaveBeenCalledTimes(2);
    expect(mPreroll).not.toHaveBeenCalled();
  });

  it("skips mobile-only users and delivers the gift before the pitch stream", async () => {
    mFindUnique.mockResolvedValue(payload({ telegramIdB: -5n }));
    mGrant.mockResolvedValue({ granted: true, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    // Side B is mobile-only — guarded out before the grant is even attempted.
    expect(mGrant).toHaveBeenCalledTimes(1);
    expect(mGrant).toHaveBeenCalledWith("ua");
    expect(mPreroll).toHaveBeenCalledTimes(1);
    expect(mPreroll).toHaveBeenCalledWith(api, 1001, "en", "female");
    // The single telegram side gifts before its pitch streams.
    expect(mPreroll.mock.invocationCallOrder[0]).toBeLessThan(
      stream.mock.invocationCallOrder[0],
    );
  });

  it("can deliver the welcome gift as a standalone pre-roll", async () => {
    mFindUnique.mockResolvedValue(payload());
    mGrant.mockResolvedValue({ granted: true, balance: 1 });
    const api = makeApi();

    const result = await sendMatchWelcomeGiftPreroll(api, "match-1");

    expect(result).toEqual({ sent: 2, sentA: true, sentB: true });
    expect(mGrant).toHaveBeenCalledTimes(2);
    expect(mPreroll).toHaveBeenCalledWith(api, 1001, "en", "female");
    expect(mPreroll).toHaveBeenCalledWith(api, 1002, "en", "male");
  });

  it("skips inline welcome gift delivery after a staged pre-roll", async () => {
    mFindUnique.mockResolvedValue(payload());
    mGrant.mockResolvedValue({ granted: true, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", {
      streamImpl: stream,
      skipWelcomeGiftPreroll: true,
    });

    expect(mGrant).not.toHaveBeenCalled();
    expect(mPreroll).not.toHaveBeenCalled();
    expect(stream).toHaveBeenCalledTimes(2);
  });

  it("sends protected motion media after successful static Match Cards", async () => {
    const row = payload();
    Object.assign(row.userB.profile, {
      profileMedia: [
        { type: "live_photo", photo: "poster-b", livePhoto: "motion-b" },
        { type: "video", video: "video-b" },
      ],
    });
    mFindUnique.mockResolvedValue(row);
    mCards.mockResolvedValue(true);
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    expect(mMotion).toHaveBeenCalledWith(
      api,
      1001,
      expect.arrayContaining([
        expect.objectContaining({ type: "live_photo", livePhoto: "motion-b" }),
        expect.objectContaining({ type: "video", video: "video-b" }),
      ]),
      { protect: true },
    );
    expect(mMedia).not.toHaveBeenCalled();
  });

  it("does not block pitch delivery when a motion follow-up fails", async () => {
    mFindUnique.mockResolvedValue(payload());
    mCards.mockResolvedValue(true);
    mMotion.mockRejectedValue(new Error("motion unavailable"));
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await expect(
      sendMatchProposal(makeApi(), "match-1", { streamImpl: stream }),
    ).resolves.toBeUndefined();
    expect(stream).toHaveBeenCalledTimes(2);
  });
});

/**
 * Regression: the synergy header used to render side A's reason text inside
 * side B's localized template, so a mixed-language pair saw the pitch stream
 * in their own language with one foreign sentence spliced into the header.
 * The reason is now stored + rendered per side.
 */
describe("sendMatchProposal — synergy reason language", () => {
  /** Pull the drafts array the stream received for a given chat id. */
  function draftsFor(stream: ReturnType<typeof vi.fn>, chatId: number): string[] {
    const call = stream.mock.calls.find((c) => c[1] === chatId);
    if (!call) throw new Error(`no stream call for chat ${chatId}`);
    return call[2] as string[];
  }

  it("renders each side's stored reason in that side's own language", async () => {
    const row = payload();
    row.userA.language = "en";
    row.userB.language = "ru";
    row.synergyReason = "Your values line up.";
    row.synergyReasonB = "Ваши ценности совпадают.";
    mFindUnique.mockResolvedValue(row);
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    const finalA = draftsFor(stream, 1001).at(-1)!;
    const finalB = draftsFor(stream, 1002).at(-1)!;
    expect(finalA).toContain("Your values line up.");
    expect(finalA).not.toContain("Ваши ценности совпадают.");
    expect(finalB).toContain("Ваши ценности совпадают.");
    expect(finalB).not.toContain("Your values line up.");
  });

  it("persists a per-side reason from each side's own generation", async () => {
    const row = payload();
    row.userA.language = "en";
    row.userB.language = "ru";
    row.pitchForA = null;
    row.pitchForB = null;
    row.synergyScore = null;
    row.synergyReason = null;
    row.synergyReasonB = null;
    mFindUnique.mockResolvedValue(row);
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });
    const pitchImpl = vi.fn(async (input: { language: string }) => ({
      pitch: input.language === "ru" ? "Вы совпадаете." : "You two click.",
      synergyScore: 87,
      synergyReason: input.language === "ru" ? "Общий ритм." : "Shared rhythm.",
    }));

    await sendMatchProposal(api, "match-1", { streamImpl: stream, pitchImpl });

    expect(mUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          synergyScore: 87,
          synergyReason: "Shared rhythm.",
          synergyReasonB: "Общий ритм.",
        }),
      }),
    );
    expect(draftsFor(stream, 1001).at(-1)).toContain("Shared rhythm.");
    expect(draftsFor(stream, 1002).at(-1)).toContain("Общий ритм.");
  });

  it("falls back to side A's reason for a legacy row without a side-B one", async () => {
    const row = payload();
    row.userA.language = "en";
    row.userB.language = "ru";
    row.synergyReason = "Your values line up.";
    row.synergyReasonB = null;
    mFindUnique.mockResolvedValue(row);
    mGrant.mockResolvedValue({ granted: false, balance: 1 });
    const api = makeApi();
    const stream = vi.fn().mockResolvedValue({ message_id: 7000 });

    await sendMatchProposal(api, "match-1", { streamImpl: stream });

    // Not ideal prose, but strictly better than dropping the header — and the
    // row can't be regenerated (both pitches are already cached).
    expect(draftsFor(stream, 1002).at(-1)).toContain("Your values line up.");
  });
});
