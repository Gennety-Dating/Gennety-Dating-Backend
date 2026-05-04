import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    profile: { findUnique: vi.fn() },
  },
}));

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { prisma } from "@gennety/db";
import { handleEmergencyStart, handleEmergencyReason } from "./emergency.js";
import { handleFeedbackStart, handleFeedbackText } from "./feedback.js";
import { runDateLifecycleTick } from "../../services/date-lifecycle.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as {
  findUnique: MockFn;
  findMany: MockFn;
  update: MockFn;
};
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mProfile = prisma.profile as unknown as { findUnique: MockFn };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  messageText?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    onboardingStep: "completed",
    pendingPhotos: [],
    ...overrides.session,
  };
  return {
    session,
    from: { id: overrides.fromId ?? 1001 },
    chat: { id: overrides.fromId ?? 1001 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message: overrides.messageText ? { text: overrides.messageText } : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

function matchRow(partial: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "match-1",
    userAId: "uid-A",
    userBId: "uid-B",
    status: "scheduled",
    agreedTime: new Date("2026-04-10T19:00:00Z"),
    icebreakersSentAt: null,
    emergencyCancelledBy: null,
    feedbackByA: null,
    feedbackByB: null,
    userA: { telegramId: 1001n, language: "en" },
    userB: { telegramId: 1002n, language: "en" },
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// Emergency cancellation handler
// ---------------------------------------------------------------------------

describe("emergency cancellation", () => {
  beforeEach(() => vi.resetAllMocks());

  it("handleEmergencyStart sets session to awaiting_emergency_reason", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({ callbackData: "emerg:start:match-1", fromId: 1001 });
    await handleEmergencyStart(ctx);

    expect(ctx.session.matchFlow).toBe("awaiting_emergency_reason");
    expect(ctx.session.activeMatchId).toBe("match-1");
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("handleEmergencyStart ignores non-scheduled matches", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "cancelled" }));
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({ callbackData: "emerg:start:match-1", fromId: 1001 });
    await handleEmergencyStart(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
  });

  it("handleEmergencyStart ignores already-cancelled matches", async () => {
    mMatch.findUnique.mockResolvedValueOnce(
      matchRow({ emergencyCancelledBy: "uid-B" }),
    );
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({ callbackData: "emerg:start:match-1", fromId: 1001 });
    await handleEmergencyStart(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
  });

  it("handleEmergencyReason cancels match and forwards exact text to peer", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(matchRow());
    mMatch.update.mockResolvedValueOnce({});

    const ctx = createCtx({
      session: {
        matchFlow: "awaiting_emergency_reason",
        activeMatchId: "match-1",
      },
      messageText: "Family emergency, so sorry!",
      fromId: 1001,
    });

    await handleEmergencyReason(ctx);

    // Session reset
    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();

    // Match updated
    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: {
          status: "cancelled",
          emergencyCancelledBy: "uid-A",
          emergencyReason: "Family emergency, so sorry!",
        },
      }),
    );

    // Confirmation to canceller
    expect(ctx.reply).toHaveBeenCalled();

    // Exact text forwarded to the other person
    expect(ctx.api.sendMessage).toHaveBeenCalledWith(
      1002,
      expect.stringContaining("Family emergency, so sorry!"),
    );
  });

  it("handleEmergencyReason no-ops when match is not scheduled", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "cancelled" }));

    const ctx = createCtx({
      session: {
        matchFlow: "awaiting_emergency_reason",
        activeMatchId: "match-1",
      },
      messageText: "reason",
      fromId: 1001,
    });

    await handleEmergencyReason(ctx);
    expect(mMatch.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Feedback handler
// ---------------------------------------------------------------------------

describe("post-date feedback", () => {
  beforeEach(() => vi.resetAllMocks());

  it("handleFeedbackStart sets session to awaiting_feedback", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "completed" }));
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({ callbackData: "feedback:start:match-1", fromId: 1001 });
    await handleFeedbackStart(ctx);

    expect(ctx.session.matchFlow).toBe("awaiting_feedback");
    expect(ctx.session.activeMatchId).toBe("match-1");
  });

  it("handleFeedbackStart ignores non-completed matches", async () => {
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "scheduled" }));

    const ctx = createCtx({ callbackData: "feedback:start:match-1", fromId: 1001 });
    await handleFeedbackStart(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
  });

  it("handleFeedbackText saves feedback for userA and resets session", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "completed" }));
    mMatch.update.mockResolvedValueOnce({});

    const ctx = createCtx({
      session: { matchFlow: "awaiting_feedback", activeMatchId: "match-1" },
      messageText: "Great date, we clicked!",
      fromId: 1001,
    });

    await handleFeedbackText(ctx);

    expect(ctx.session.matchFlow).toBe("idle");
    expect(ctx.session.activeMatchId).toBeNull();
    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: { feedbackByA: "Great date, we clicked!" },
      }),
    );
    expect(ctx.reply).toHaveBeenCalled();
  });

  it("handleFeedbackText saves feedback for userB", async () => {
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-B" });
    mMatch.findUnique.mockResolvedValueOnce(matchRow({ status: "completed" }));
    mMatch.update.mockResolvedValueOnce({});

    const ctx = createCtx({
      session: { matchFlow: "awaiting_feedback", activeMatchId: "match-1" },
      messageText: "Not bad, a bit awkward at first.",
      fromId: 1002,
    });

    await handleFeedbackText(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: { feedbackByB: "Not bad, a bit awkward at first." },
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Date lifecycle cron
// ---------------------------------------------------------------------------

describe("date-lifecycle tick", () => {
  beforeEach(() => vi.resetAllMocks());

  it("sends ice-breakers and emergency buttons for matches within 3h window", async () => {
    const agreedTime = new Date("2026-04-10T19:00:00Z");
    // now = 2h45m before the date → inside the 3h alert window
    const now = new Date(agreedTime.getTime() - 2.75 * 60 * 60 * 1000);

    mMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-1",
          agreedTime,
          userA: { id: "ua-1", telegramId: 1001n, language: "en", firstName: "Alice" },
          userB: { id: "ub-1", telegramId: 1002n, language: "ru", firstName: "Boris" },
        },
      ])
      // wingman query returns empty (T-1h hasn't fired)
      .mockResolvedValueOnce([])
      // feedback query returns empty
      .mockResolvedValueOnce([]);
    mMatch.update.mockResolvedValue({});
    // Profile lookups for personalised ice-breakers
    mProfile.findUnique.mockResolvedValue({ psychologicalSummary: null });

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await runDateLifecycleTick(api, now);

    expect(result.icebreakers).toBe(1);
    expect(result.emergencies).toBe(1);
    // 4 messages: icebreaker A, icebreaker B, emergency A, emergency B
    expect(api.sendMessage).toHaveBeenCalledTimes(4);
    // Mark as sent (icebreakers + topic arrays — order-independent shape match)
    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: expect.objectContaining({ icebreakersSentAt: now }),
      }),
    );
  });

  it("sends feedback prompts for dates 24h+ in the past", async () => {
    const agreedTime = new Date("2026-04-08T19:00:00Z");
    // now = 25h after the date
    const now = new Date(agreedTime.getTime() + 25 * 60 * 60 * 1000);

    mMatch.findMany
      // icebreaker query returns empty
      .mockResolvedValueOnce([])
      // wingman query returns empty
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "match-2",
          userA: { telegramId: 2001n, language: "en" },
          userB: { telegramId: 2002n, language: "uk" },
        },
      ]);
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    const result = await runDateLifecycleTick(api, now);

    expect(result.feedbacks).toBe(1);
    // 2 messages: feedback A, feedback B
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Transition to completed AND stamp feedbackPromptedAt (C-1 dedup marker).
    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-2" },
        data: { status: "completed", feedbackPromptedAt: now },
      }),
    );
  });

  it("does NOT re-prompt feedback once feedbackPromptedAt is set (C-1)", async () => {
    // Regression: previously the cron used null `feedbackByA/B` as the dedup
    // signal, which kept matching every 2 minutes until both users replied.
    // Now we filter on `feedbackPromptedAt: null` so a one-shot prompt is
    // truly one-shot.
    mMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]); // feedback query, filtered to feedbackPromptedAt: null

    const api = { sendMessage: vi.fn() } as any;
    const result = await runDateLifecycleTick(api, new Date());

    expect(result.feedbacks).toBe(0);
    // Verify the query filter — should require feedbackPromptedAt: null
    expect(mMatch.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ feedbackPromptedAt: null }),
      }),
    );
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("C-3: ice-breaker batch survives a Telegram send failure", async () => {
    // Regression: a single 403/blocked send used to abort the for-loop
    // before icebreakersSentAt was stamped, so the next 2-min tick re-fired
    // the batch and the survivor got duplicates.
    const agreedTime = new Date("2026-04-10T19:00:00Z");
    const now = new Date(agreedTime.getTime() - 2.75 * 60 * 60 * 1000);

    mMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-1",
          agreedTime,
          userA: { id: "ua-1", telegramId: 1001n, language: "en", firstName: "Alice" },
          userB: { id: "ub-1", telegramId: 1002n, language: "ru", firstName: "Boris" },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mMatch.update.mockResolvedValue({});
    mProfile.findUnique.mockResolvedValue({ psychologicalSummary: null });

    const api = {
      sendMessage: vi
        .fn()
        // First send to A throws — must NOT abort the rest of the batch
        .mockRejectedValueOnce(new Error("Forbidden: bot was blocked by the user"))
        .mockResolvedValue(undefined),
    } as any;

    const result = await runDateLifecycleTick(api, now);

    expect(result.icebreakers).toBe(1);
    // The other 3 sends still happen
    expect(api.sendMessage).toHaveBeenCalledTimes(4);
    // CRITICAL: idempotency marker stamped despite the failure
    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "match-1" },
        data: expect.objectContaining({ icebreakersSentAt: now }),
      }),
    );
  });

  it("C-3: ice-breaker skips mobile-only users (telegramId <= 0n)", async () => {
    // Mobile-first synthetic users have negative telegramIds. Sending to a
    // negative chat id throws "chat not found" and used to abort the batch.
    const agreedTime = new Date("2026-04-10T19:00:00Z");
    const now = new Date(agreedTime.getTime() - 2.75 * 60 * 60 * 1000);

    mMatch.findMany
      .mockResolvedValueOnce([
        {
          id: "match-3",
          agreedTime,
          userA: { id: "ua-3", telegramId: 1001n, language: "en", firstName: "Alice" },
          userB: { id: "ub-3", telegramId: -42n, language: "en", firstName: "MobileBob" },
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    mMatch.update.mockResolvedValue({});
    mProfile.findUnique.mockResolvedValue({ psychologicalSummary: null });

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await runDateLifecycleTick(api, now);

    // Only Alice (positive id) gets ice-breaker + emergency = 2 sends.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Bob (-42n) is never sent to.
    for (const call of (api.sendMessage as any).mock.calls) {
      expect(call[0]).toBe(1001);
    }
  });

  it("returns zeros when there are no matches to process", async () => {
    mMatch.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const api = { sendMessage: vi.fn() } as any;
    const result = await runDateLifecycleTick(api, new Date());

    expect(result.icebreakers).toBe(0);
    expect(result.emergencies).toBe(0);
    expect(result.feedbacks).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });
});
