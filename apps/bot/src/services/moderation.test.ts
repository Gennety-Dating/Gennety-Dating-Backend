import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — prisma + negative-constraints + the shared cancel-in-flight helper +
// push. The moderation service is pure policy logic; everything it touches is
// injected/mocked so these tests only assert the policy + delegation.
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      update: vi.fn(),
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("./cancel-in-flight-matches.js", () => ({
  cancelInFlightMatchesForUser: vi.fn().mockResolvedValue([]),
}));

vi.mock("./push.js", () => ({
  sendPushToUser: vi.fn().mockResolvedValue(true),
}));

import { prisma } from "@gennety/db";
import { appendNegativeConstraint } from "../handlers/matching/negative-constraints.js";
import { cancelInFlightMatchesForUser } from "./cancel-in-flight-matches.js";
import { sendPushToUser } from "./push.js";
import {
  applyReportAction,
  notifyReportedUser,
  SUSPENSION_DAYS,
} from "./moderation.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUser = prisma.user as unknown as { update: MockFn; findUnique: MockFn };
const mAppend = appendNegativeConstraint as unknown as MockFn;
const mCancel = cancelInFlightMatchesForUser as unknown as MockFn;
const mPush = sendPushToUser as unknown as MockFn;

const REPORTED_ID = "11111111-1111-1111-1111-111111111111";
const REPORTER_ID = "22222222-2222-2222-2222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("applyReportAction — Tier 1 (Product Disappointment)", () => {
  it("appends to reporter's negative constraints without penalizing reported user", async () => {
    const outcome = await applyReportAction({
      tier: 1,
      reporterUserId: REPORTER_ID,
      reportedUserId: REPORTED_ID,
      reasonSummary: "Not my type",
      language: "en",
    });

    expect(outcome).toEqual({ kind: "tier1" });
    expect(mAppend).toHaveBeenCalledWith(REPORTER_ID, "Not my type", "en");
    expect(mUser.update).not.toHaveBeenCalled();
    expect(mCancel).not.toHaveBeenCalled();
  });
});

describe("applyReportAction — Tier 2 (Ethical Violation)", () => {
  it("first Tier 2 report → strikes = 1, warning outcome, no status change", async () => {
    // Simulate the atomic increment: Prisma returns the post-increment value.
    mUser.update.mockResolvedValueOnce({ strikes: 1 });

    const outcome = await applyReportAction({
      tier: 2,
      reporterUserId: REPORTER_ID,
      reportedUserId: REPORTED_ID,
      reasonSummary: "Ghosted at the meeting",
      language: "en",
    });

    expect(outcome).toEqual({ kind: "tier2_warning", strikes: 1 });
    // Only the increment call — no follow-up status update.
    expect(mUser.update).toHaveBeenCalledTimes(1);
    expect(mUser.update).toHaveBeenCalledWith({
      where: { id: REPORTED_ID },
      data: { strikes: { increment: 1 } },
      select: { strikes: true },
    });
    // Strike 1 is a warning only — no matches are cancelled.
    expect(mCancel).not.toHaveBeenCalled();
    expect(mAppend).not.toHaveBeenCalled();
  });

  it("second Tier 2 report → strikes = 2, status becomes suspended with 14-day window", async () => {
    mUser.update
      .mockResolvedValueOnce({ strikes: 2 }) // increment
      .mockResolvedValueOnce({}); // status update

    const before = Date.now();
    const outcome = await applyReportAction({
      tier: 2,
      reporterUserId: REPORTER_ID,
      reportedUserId: REPORTED_ID,
      reasonSummary: "Showed up 50 min late, rude",
      language: "en",
    });
    const after = Date.now();

    expect(outcome.kind).toBe("tier2_suspended");
    if (outcome.kind !== "tier2_suspended") throw new Error("type narrowing");
    expect(outcome.strikes).toBe(2);

    const expectedLowerBound = before + SUSPENSION_DAYS * 24 * 60 * 60 * 1000;
    const expectedUpperBound = after + SUSPENSION_DAYS * 24 * 60 * 60 * 1000;
    expect(outcome.until.getTime()).toBeGreaterThanOrEqual(expectedLowerBound);
    expect(outcome.until.getTime()).toBeLessThanOrEqual(expectedUpperBound);

    // Confirm the second update call applied suspended status + suspendedUntil.
    expect(mUser.update).toHaveBeenCalledTimes(2);
    const secondCall = mUser.update.mock.calls[1][0];
    expect(secondCall.where).toEqual({ id: REPORTED_ID });
    expect(secondCall.data.status).toBe("suspended");
    expect(secondCall.data.suspendedUntil).toBeInstanceOf(Date);

    // In-flight matches for the suspended user are cancelled via the shared
    // helper (which covers proposed/negotiating/negotiating_venue/scheduled and
    // notifies + comps the partner). `api` is null in these unit calls.
    expect(mCancel).toHaveBeenCalledWith(REPORTED_ID, null);
  });

  it("third Tier 2 report → strikes = 3, status becomes banned", async () => {
    mUser.update
      .mockResolvedValueOnce({ strikes: 3 })
      .mockResolvedValueOnce({});

    const outcome = await applyReportAction({
      tier: 2,
      reporterUserId: REPORTER_ID,
      reportedUserId: REPORTED_ID,
      reasonSummary: "Pattern of rude behavior",
      language: "en",
    });

    expect(outcome).toEqual({ kind: "tier2_banned", strikes: 3 });
    const secondCall = mUser.update.mock.calls[1][0];
    expect(secondCall.data.status).toBe("banned");
    expect(mCancel).toHaveBeenCalledWith(REPORTED_ID, null);
  });
});

describe("applyReportAction — Tier 3 (Safety Threat)", () => {
  it("immediately freezes account with pending_investigation status and cancels dates", async () => {
    mUser.update.mockResolvedValueOnce({});

    const outcome = await applyReportAction({
      tier: 3,
      reporterUserId: REPORTER_ID,
      reportedUserId: REPORTED_ID,
      reasonSummary: "Harassment after the date",
      language: "en",
    });

    expect(outcome).toEqual({ kind: "tier3_frozen" });
    expect(mUser.update).toHaveBeenCalledTimes(1);
    expect(mUser.update).toHaveBeenCalledWith({
      where: { id: REPORTED_ID },
      data: { status: "pending_investigation" },
    });
    // In-flight matches (including negotiating_venue / scheduled) cancelled —
    // the safety-critical fix: a flagged user's booked date must not proceed.
    expect(mCancel).toHaveBeenCalledWith(REPORTED_ID, null);
    // Strikes are NOT touched — this is a direct-freeze path.
    expect(mAppend).not.toHaveBeenCalled();
  });

  it("forwards the bot api to the cancellation helper when provided", async () => {
    mUser.update.mockResolvedValueOnce({});
    const api = { sendMessage: vi.fn() } as unknown as Parameters<typeof applyReportAction>[2];

    await applyReportAction(
      {
        tier: 3,
        reporterUserId: REPORTER_ID,
        reportedUserId: REPORTED_ID,
        reasonSummary: "Threat",
        language: "en",
      },
      undefined,
      api,
    );

    expect(mCancel).toHaveBeenCalledWith(REPORTED_ID, api);
  });
});

describe("notifyReportedUser — DM delivery", () => {
  it("skips Tier 1 outcomes entirely (reported user gets no DM)", async () => {
    const api = { sendMessage: vi.fn().mockResolvedValue({}) } as unknown as Parameters<
      typeof notifyReportedUser
    >[0];
    await notifyReportedUser(api, REPORTED_ID, { kind: "tier1" });
    expect((api as unknown as { sendMessage: MockFn }).sendMessage).not.toHaveBeenCalled();
    expect(mUser.findUnique).not.toHaveBeenCalled();
  });

  it("sends the suspension DM in the reported user's language", async () => {
    mUser.findUnique.mockResolvedValueOnce({ telegramId: 9999n, language: "ru" });
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof notifyReportedUser>[0];

    await notifyReportedUser(api, REPORTED_ID, {
      kind: "tier2_suspended",
      strikes: 2,
      until: new Date(),
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [chatId, body] = sendMessage.mock.calls[0];
    expect(chatId).toBe(9999);
    expect(typeof body).toBe("string");
    expect(body).toContain("14");
    expect(mPush).not.toHaveBeenCalled();
  });

  it("sends the pending-investigation DM for Tier 3", async () => {
    mUser.findUnique.mockResolvedValueOnce({ telegramId: 1234n, language: "en" });
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof notifyReportedUser>[0];

    await notifyReportedUser(api, REPORTED_ID, { kind: "tier3_frozen" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [, body] = sendMessage.mock.calls[0];
    expect(body).toContain("frozen");
  });

  it("delivers the outcome to a mobile-only user via push, not DM", async () => {
    // Synthetic negative telegramId → mobile-only account; can't be DM'd.
    mUser.findUnique.mockResolvedValueOnce({ telegramId: -5n, language: "en" });
    const sendMessage = vi.fn().mockResolvedValue({});
    const api = { sendMessage } as unknown as Parameters<typeof notifyReportedUser>[0];

    await notifyReportedUser(api, REPORTED_ID, { kind: "tier2_banned", strikes: 3 });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(mPush).toHaveBeenCalledTimes(1);
    const [userId, payload] = mPush.mock.calls[0];
    expect(userId).toBe(REPORTED_ID);
    expect(typeof payload.body).toBe("string");
    expect(payload.data).toEqual({ type: "moderation" });
  });

  it("swallows sendMessage errors (reporter outcome must not surface)", async () => {
    mUser.findUnique.mockResolvedValueOnce({ telegramId: 1n, language: "en" });
    const sendMessage = vi.fn().mockRejectedValueOnce(new Error("blocked"));
    const api = { sendMessage } as unknown as Parameters<typeof notifyReportedUser>[0];

    await expect(
      notifyReportedUser(api, REPORTED_ID, { kind: "tier2_warning", strikes: 1 }),
    ).resolves.toBeUndefined();
  });
});

describe("escalation integration — two Tier 2 reports in sequence", () => {
  it("first report leaves user active; second suspends them", async () => {
    // First report → strikes: 1 → warning
    mUser.update.mockResolvedValueOnce({ strikes: 1 });
    const first = await applyReportAction({
      tier: 2,
      reporterUserId: "reporter-1",
      reportedUserId: REPORTED_ID,
      reasonSummary: "Ghosting",
      language: "en",
    });
    expect(first).toEqual({ kind: "tier2_warning", strikes: 1 });

    // Second report from a different reporter → strikes: 2 → suspended
    mUser.update
      .mockResolvedValueOnce({ strikes: 2 })
      .mockResolvedValueOnce({});
    const second = await applyReportAction({
      tier: 2,
      reporterUserId: "reporter-2",
      reportedUserId: REPORTED_ID,
      reasonSummary: "Very late no apology",
      language: "en",
    });
    expect(second.kind).toBe("tier2_suspended");
  });
});
