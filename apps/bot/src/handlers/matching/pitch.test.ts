/**
 * Integration tests for the welcome-gift pre-roll wired into `sendMatchProposal`.
 * The grant (`grantWelcomeGiftIfEligible`) and the sender (`sendWelcomeGiftPreroll`)
 * are mocked as spies so we assert ONLY the dispatch wiring: that the gift fires
 * before the pitch on a granted first pitch, is skipped when the grant reports
 * "already gifted", and never touches mobile-only (negative telegramId) users.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mFindUnique, mUpdate, mGrant, mPreroll } = vi.hoisted(() => ({
  mFindUnique: vi.fn(),
  mUpdate: vi.fn(),
  mGrant: vi.fn(),
  mPreroll: vi.fn(),
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
    pitchForA: "You two click.",
    pitchForB: "You two click.",
    synergyScore: 87,
    synergyReason: "Aligned values.",
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
});
