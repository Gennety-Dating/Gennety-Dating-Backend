import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SessionData } from "@gennety/shared";
import { DEFAULT_SESSION } from "@gennety/shared";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
    },
    match: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
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

vi.mock("./venue-negotiation.js", () => ({
  startVenueNegotiation: vi.fn().mockResolvedValue(undefined),
}));

import { prisma } from "@gennety/db";
import {
  generateProposalSlots,
  formatSlotLabel,
  buildProposalKeyboard,
  buildCalendarKeyboard,
  startScheduling,
  handleSchedulePick,
  handleCalendarWebAppData,
  MAX_AI_ITERATIONS,
  PROPOSALS_PER_ROUND,
} from "./scheduler.js";
import { startVenueNegotiation } from "./venue-negotiation.js";

type MockFn = ReturnType<typeof vi.fn>;
const mMatch = prisma.match as unknown as { findUnique: MockFn; update: MockFn };
const mUser = prisma.user as unknown as { findUnique: MockFn };
const mStartVenue = startVenueNegotiation as unknown as MockFn;

function createCtx(overrides: {
  session?: Partial<SessionData>;
  callbackData?: string;
  webAppData?: string;
  fromId?: number;
}) {
  const session: SessionData = {
    ...DEFAULT_SESSION,
    pendingPhotos: [],
    ...overrides.session,
  };
  return {
    session,
    from: { id: overrides.fromId ?? 2001 },
    chat: { id: overrides.fromId ?? 2001 },
    callbackQuery: overrides.callbackData ? { data: overrides.callbackData } : undefined,
    message: overrides.webAppData
      ? { web_app_data: { data: overrides.webAppData } }
      : undefined,
    reply: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    api: {
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  } as any;
}

describe("scheduler: pure slot helpers", () => {
  it("generateProposalSlots returns PROPOSALS_PER_ROUND slots by default", () => {
    const slots = generateProposalSlots(new Date("2026-04-09T12:00:00Z"));
    expect(slots.length).toBe(PROPOSALS_PER_ROUND);
    for (const s of slots) {
      expect(s.getHours()).toBe(19);
      const d = s.getDay();
      expect(d).not.toBe(0); // Sunday excluded
      expect(d).not.toBe(1); // Monday excluded
    }
  });

  it("formatSlotLabel yields a short, non-empty label", () => {
    const label = formatSlotLabel(new Date("2026-04-10T19:00:00Z"), "en");
    expect(label.length).toBeGreaterThan(0);
  });

  it("buildProposalKeyboard contains one button per slot and a callback carrying the ISO timestamp", () => {
    const slots = [
      new Date("2026-04-10T19:00:00.000Z"),
      new Date("2026-04-11T19:00:00.000Z"),
    ];
    const kb = buildProposalKeyboard("match-1", slots, "en");
    expect(kb.inline_keyboard.length).toBe(2);
    for (let i = 0; i < slots.length; i++) {
      const btn = kb.inline_keyboard[i]![0] as { callback_data: string };
      expect(btn.callback_data).toBe(`sched:pick:match-1:${i}`);
      // Telegram caps callback_data at 64 bytes — assert we stay well under it
      // even with a real UUID. Slot index encoding gives us a wide margin.
      expect(Buffer.byteLength(btn.callback_data, "utf8")).toBeLessThanOrEqual(64);
    }
  });

  it("buildCalendarKeyboard emits a web_app button — NOT a plain URL button", () => {
    const kb = buildCalendarKeyboard("https://example.com/calendar?match=abc", "en");
    const btn = kb.inline_keyboard[0]![0] as { web_app?: { url: string } };
    expect(btn.web_app?.url).toBe("https://example.com/calendar?match=abc");
  });
});

describe("scheduler: startScheduling iteration progression", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("iteration 0 -> iteration 1: writes schedulingIteration=1 and sends proposal messages", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce({
        id: "match-1",
        schedulingIteration: 0,
        userA: { telegramId: 1001n, language: "en" },
        userB: { telegramId: 1002n, language: "en" },
      })
      .mockResolvedValueOnce({
        userA: { telegramId: 1001n, language: "en" },
        userB: { telegramId: 1002n, language: "en" },
      });
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await startScheduling(api, "match-1");

    const call = mMatch.update.mock.calls[0]![0] as {
      data: { schedulingIteration: number; proposedTimes: Date[] };
    };
    expect(call.data.schedulingIteration).toBe(1);
    expect(call.data.proposedTimes.length).toBe(PROPOSALS_PER_ROUND);
    // One message per user.
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("iteration 2 -> iteration 3: sends Mini App calendar buttons, sets schedulingIteration=3", async () => {
    mMatch.findUnique
      .mockResolvedValueOnce({
        id: "match-1",
        schedulingIteration: MAX_AI_ITERATIONS,
        userA: { telegramId: 1001n, language: "en" },
        userB: { telegramId: 1002n, language: "en" },
      })
      .mockResolvedValueOnce({
        userA: { telegramId: 1001n, language: "en" },
        userB: { telegramId: 1002n, language: "en" },
      });
    mMatch.update.mockResolvedValue({});

    const api = { sendMessage: vi.fn().mockResolvedValue(undefined) } as any;
    await startScheduling(api, "match-1");

    const updates = mMatch.update.mock.calls.map((c) => c[0]);
    expect(
      updates.some(
        (u) => (u.data as { schedulingIteration?: number }).schedulingIteration === 3,
      ),
    ).toBe(true);
    expect(api.sendMessage).toHaveBeenCalledTimes(2);
  });
});

describe("scheduler: handleSchedulePick overlap detection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a slot not in the current proposedTimes set", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      schedulingIteration: 1,
      proposedTimes: [new Date("2026-04-10T19:00:00.000Z")],
      pickedTimeA: null,
      pickedTimeB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      // Index 99 is out-of-bounds for proposedTimes (length 1).
      callbackData: "sched:pick:match-1:99",
    });
    await handleSchedulePick(ctx);

    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("writes pickedTimeA when user A picks a valid slot and peer hasn't picked yet", async () => {
    const slot = new Date("2026-04-10T19:00:00.000Z");
    mMatch.findUnique
      .mockResolvedValueOnce({
        id: "match-1",
        userAId: "uid-A",
        userBId: "uid-B",
        status: "negotiating",
        schedulingIteration: 1,
        proposedTimes: [slot],
        pickedTimeA: null,
        pickedTimeB: null,
      })
      .mockResolvedValueOnce({ pickedTimeA: slot, pickedTimeB: null });

    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      // Slot index 0 → proposedTimes[0] = slot.
      callbackData: `sched:pick:match-1:0`,
    });
    await handleSchedulePick(ctx);

    const first = mMatch.update.mock.calls[0]![0] as { data: { pickedTimeA?: Date } };
    expect(first.data.pickedTimeA?.getTime()).toBe(slot.getTime());
  });
});

describe("scheduler: overlap hands off to venue negotiation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("when both users pick the same slot, handleSchedulePick triggers startVenueNegotiation (not direct scheduled)", async () => {
    const slot = new Date("2026-04-10T19:00:00.000Z");
    mMatch.findUnique
      .mockResolvedValueOnce({
        id: "match-1",
        userAId: "uid-A",
        userBId: "uid-B",
        status: "negotiating",
        schedulingIteration: 1,
        proposedTimes: [slot],
        pickedTimeA: null,
        pickedTimeB: slot,
      })
      // Reload after update: both picks now match.
      .mockResolvedValueOnce({ pickedTimeA: slot, pickedTimeB: slot });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      callbackData: `sched:pick:match-1:0`,
    });
    await handleSchedulePick(ctx);

    expect(mStartVenue).toHaveBeenCalledTimes(1);
    const [, matchId, agreedTime] = mStartVenue.mock.calls[0]!;
    expect(matchId).toBe("match-1");
    expect((agreedTime as Date).getTime()).toBe(slot.getTime());
  });
});

describe("scheduler: handleCalendarWebAppData (iteration 3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses JSON payload, updates pickedTimeA, and stays open when peer hasn't picked", async () => {
    const slot = new Date("2026-05-01T19:00:00.000Z");
    mMatch.findUnique
      .mockResolvedValueOnce({
        id: "match-1",
        userAId: "uid-A",
        userBId: "uid-B",
        status: "negotiating",
        schedulingIteration: 3,
        proposedTimes: [slot],
        pickedTimeA: null,
        pickedTimeB: null,
      })
      .mockResolvedValueOnce({ pickedTimeA: slot, pickedTimeB: null });
    mUser.findUnique.mockResolvedValueOnce({ id: "uid-A" });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      webAppData: JSON.stringify({
        matchId: "match-1",
        pickedIso: slot.toISOString(),
      }),
    });

    await handleCalendarWebAppData(ctx);

    expect(mMatch.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ pickedTimeA: expect.any(Date) }) }),
    );
  });

  it("ignores malformed JSON payloads", async () => {
    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      webAppData: "not json",
    });
    await handleCalendarWebAppData(ctx);
    expect(mMatch.findUnique).not.toHaveBeenCalled();
  });

  it("ignores payloads referencing a non-iter3 match", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      schedulingIteration: 1,
      proposedTimes: [],
      pickedTimeA: null,
      pickedTimeB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      webAppData: JSON.stringify({
        matchId: "match-1",
        pickedIso: "2026-05-01T19:00:00.000Z",
      }),
    });
    await handleCalendarWebAppData(ctx);
    expect(mMatch.update).not.toHaveBeenCalled();
  });

  it("rejects iter-3 picks outside the current proposedTimes allowlist", async () => {
    mMatch.findUnique.mockResolvedValueOnce({
      id: "match-1",
      userAId: "uid-A",
      userBId: "uid-B",
      status: "negotiating",
      schedulingIteration: 3,
      proposedTimes: [new Date("2026-05-01T19:00:00.000Z")],
      pickedTimeA: null,
      pickedTimeB: null,
    });

    const ctx = createCtx({
      session: { onboardingStep: "completed" },
      webAppData: JSON.stringify({
        matchId: "match-1",
        pickedIso: "2026-07-01T19:00:00.000Z",
      }),
    });
    await handleCalendarWebAppData(ctx);
    expect(mMatch.update).not.toHaveBeenCalled();
  });
});
