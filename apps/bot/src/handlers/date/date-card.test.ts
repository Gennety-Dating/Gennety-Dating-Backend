import { describe, it, expect, vi, beforeEach } from "vitest";
import { DEFAULT_SESSION, type SessionData } from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({ env: { DATE_CARD_FEATURE_ENABLED: true } }));

vi.mock("../../services/date-card/index.js", () => ({
  renderDateCard: vi.fn(),
}));

import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { renderDateCard } from "../../services/date-card/index.js";
import { handleDateCardShare } from "./date-card.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mMatch = prisma.match as unknown as { findUnique: MockFn };
const mRender = renderDateCard as unknown as MockFn;
const mEnv = env as unknown as { DATE_CARD_FEATURE_ENABLED: boolean };

function ctx(data = "datecard:share:m-1") {
  const session: SessionData = { ...DEFAULT_SESSION, onboardingStep: "completed", language: "en" };
  return {
    session,
    from: { id: 1001 },
    callbackQuery: { data },
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    reply: vi.fn().mockResolvedValue(undefined),
    api: { sendPhoto: vi.fn().mockResolvedValue(undefined) },
  } as any;
}

const scheduledMatch = {
  status: "scheduled",
  agreedTime: new Date("2026-05-16T16:00:00Z"),
  userAId: "uid-A",
  userBId: "uid-B",
  venueName: "Cafe",
  venueAddress: "1 St",
  venuePhotoUrl: null,
  venuePhotoName: null,
  userA: { firstName: "Alex", profile: { photos: ["fileA"] } },
  userB: { firstName: "Bea", profile: { photos: ["fileB"] } },
};

beforeEach(() => {
  mUser.findUnique.mockReset();
  mMatch.findUnique.mockReset();
  mRender.mockReset();
  mEnv.DATE_CARD_FEATURE_ENABLED = true;
});

describe("handleDateCardShare", () => {
  it("sends the blurred card WITHOUT protect_content", async () => {
    mUser.findUnique.mockResolvedValue({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValue(scheduledMatch);
    mRender.mockResolvedValue(Buffer.from([0x89, 0x50]));

    const c = ctx();
    await handleDateCardShare(c);

    // Side A's card shows partner B, blurred.
    expect(mRender).toHaveBeenCalledTimes(1);
    const [input, opts] = mRender.mock.calls[0]!;
    expect(opts).toEqual({ blur: true });
    expect(input.partnerFirstName).toBe("Bea");
    expect(input.partnerPhotoRef).toBe("fileB");

    expect(c.api.sendPhoto).toHaveBeenCalledTimes(1);
    const sendOpts = c.api.sendPhoto.mock.calls[0]![2];
    expect(sendOpts.protect_content).toBeUndefined();
    expect(sendOpts.caption).toContain("hidden");
  });

  it("replies with a failure message when the card can't be rendered", async () => {
    mUser.findUnique.mockResolvedValue({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValue(scheduledMatch);
    mRender.mockResolvedValue(null);

    const c = ctx();
    await handleDateCardShare(c);

    expect(c.api.sendPhoto).not.toHaveBeenCalled();
    expect(c.reply).toHaveBeenCalledTimes(1);
  });

  it("is inert when the feature flag is off", async () => {
    mEnv.DATE_CARD_FEATURE_ENABLED = false;
    const c = ctx();
    await handleDateCardShare(c);
    expect(mMatch.findUnique).not.toHaveBeenCalled();
    expect(mRender).not.toHaveBeenCalled();
    expect(c.api.sendPhoto).not.toHaveBeenCalled();
  });

  it("ignores a non-participant", async () => {
    mUser.findUnique.mockResolvedValue({ id: "uid-X" });
    mMatch.findUnique.mockResolvedValue(scheduledMatch);
    const c = ctx();
    await handleDateCardShare(c);
    expect(mRender).not.toHaveBeenCalled();
    expect(c.api.sendPhoto).not.toHaveBeenCalled();
  });
});
