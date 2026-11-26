import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * «Только мои свидания» (agent concept phase 4 item 6): the flag itself, and
 * that the senders with no test file of their own honour it.
 */

const db = {
  user: { findUnique: vi.fn(), findMany: vi.fn() },
  profile: { findMany: vi.fn().mockResolvedValue([]), updateMany: vi.fn() },
  memoryReminder: { findMany: vi.fn(), updateMany: vi.fn().mockResolvedValue({ count: 1 }), count: vi.fn().mockResolvedValue(0) },
  match: { findUnique: vi.fn().mockResolvedValue(null) },
  userBlock: { count: vi.fn().mockResolvedValue(0) },
};
vi.mock("@gennety/db", () => ({ prisma: db }));
vi.mock("../config.js", () => ({ env: { WISHLIST_FEATURE_ENABLED: true } }));
const sendPushToUser = vi.fn().mockResolvedValue(true);
vi.mock("./push.js", () => ({ sendPushToUser: (...a: unknown[]) => sendPushToUser(...a) }));
vi.mock("./wishlist-lookup.js", () => ({ warmWishlistCatalog: vi.fn().mockResolvedValue(0), sweepWebLookupCache: vi.fn().mockResolvedValue(0) }));
vi.mock("./wishlist.js", () => ({ openWishlistSession: vi.fn(), wishlistSessionEligible: vi.fn() }));
vi.mock("./profiler.js", () => ({ hasActiveDatePlanning: vi.fn().mockResolvedValue(false) }));
const grant = vi.fn();
vi.mock("./referral.js", () => ({ grantReferralRewardsForVerifiedInvitee: (...a: unknown[]) => grant(...a) }));
vi.mock("./memory-ideas.js", () => ({ dropScreenshotSources: vi.fn() }));
vi.mock("./memory-planning.js", () => ({ reconcilePlans: vi.fn() }));
vi.mock("./feature-preview.js", () => ({ memoryIdeasUsers: () => null }));

const { mutedByOnlyMyDates, NOT_ONLY_MY_DATES, ONLY_MY_DATES_MUTED_KINDS } = await import("./notification-mute.js");
const { wishlistSessionTick } = await import("../workers/wishlist-session.js");
const { sendDueReminders } = await import("../workers/memory-ideas.js");
const { settleReferralOnVerified } = await import("./referral-notify.js");

const NOW = new Date("2026-11-26T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("mutedByOnlyMyDates", () => {
  it("reads User.notifyOnlyDates", async () => {
    db.user.findUnique.mockResolvedValueOnce({ notifyOnlyDates: true });
    expect(await mutedByOnlyMyDates("u1", "announcement")).toBe(true);
    db.user.findUnique.mockResolvedValueOnce({ notifyOnlyDates: false });
    expect(await mutedByOnlyMyDates("u1", "announcement")).toBe(false);
    db.user.findUnique.mockResolvedValueOnce(null);
    expect(await mutedByOnlyMyDates("u1", "announcement")).toBe(false);
  });

  it("mutes exactly the senders the founder's item names, none about the person's own dates", () => {
    expect(NOT_ONLY_MY_DATES).toEqual({ notifyOnlyDates: false });
    expect([...ONLY_MY_DATES_MUTED_KINDS]).toEqual([
      "profiler", "re_engagement", "announcement", "waiting_notice",
      "rematch_offer", "wishlist_session", "idea_reminder", "referral_reward",
      "place_tip",
    ]);
  });
});

describe("senders honour it", () => {
  it("wishlist session push: the audience query leaves muted people out", async () => {
    db.profile.findMany.mockResolvedValueOnce([]);
    await wishlistSessionTick(NOW);
    expect(db.profile.findMany.mock.calls[0]![0].where.user).toMatchObject({ notifyOnlyDates: false });
  });

  it("idea reminder: cancelled for a muted person when the idea is not tied to a match", async () => {
    db.memoryReminder.findMany.mockResolvedValueOnce([
      { id: "rem-1", userId: "u1", idea: { id: "idea-1", plannedMatchId: null, eventAt: new Date(NOW.getTime() + 86_400_000) } },
    ]);
    db.user.findUnique.mockResolvedValueOnce({ notifyOnlyDates: true });
    const sent = await sendDueReminders(NOW, { quiet: () => false, send: sendPushToUser });
    expect(sent).toBe(0);
    expect(sendPushToUser).not.toHaveBeenCalled();
    expect(db.memoryReminder.updateMany).toHaveBeenCalledWith({ where: { id: "rem-1", state: "pending" }, data: { state: "cancelled" } });
  });

  it("idea reminder for a planned date is never asked about the mute", async () => {
    db.memoryReminder.findMany.mockResolvedValueOnce([
      { id: "rem-2", userId: "u1", idea: { id: "idea-2", plannedMatchId: "m1", eventAt: new Date(NOW.getTime() + 86_400_000) } },
    ]);
    db.match.findUnique.mockResolvedValueOnce({ userAId: "u1", userBId: "u2" });
    await sendDueReminders(NOW, { quiet: () => false, send: sendPushToUser });
    expect(db.user.findUnique).not.toHaveBeenCalledWith(expect.objectContaining({ select: { notifyOnlyDates: true } }));
  });

  it("referral reward: tickets settle, the message is skipped", async () => {
    grant.mockResolvedValueOnce({ referrerId: "ref-1", referrerTicketsApplied: 1, rewardsLeft: 2 });
    db.user.findUnique.mockImplementation(async (args: { select: Record<string, boolean> }) =>
      args.select.notifyOnlyDates ? { notifyOnlyDates: true } : { telegramId: 10n, language: "en", platform: "both", firstName: "A" },
    );
    const api = { sendMessage: vi.fn().mockResolvedValue({}) };
    await settleReferralOnVerified("inv-1", api as never);
    expect(grant).toHaveBeenCalled();
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(sendPushToUser).not.toHaveBeenCalled();
    db.user.findUnique.mockReset();
  });
});
