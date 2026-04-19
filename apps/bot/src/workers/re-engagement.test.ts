import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "test-key",
    SMTP_HOST: "test",
    SMTP_PORT: 587,
    SMTP_USER: "test",
    SMTP_PASS: "test",
    SMTP_FROM: "test@test.com",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
  },
}));

import { prisma } from "@gennety/db";
import { reEngagementTick, getFallbackMessage } from "./re-engagement.js";
import { MAX_RE_ENGAGEMENT_STEP } from "./re-engagement-schedule.js";

function createMockApi() {
  return {
    sendMessage: vi.fn().mockResolvedValue({}),
  } as any;
}

function openaiTextResponse(content: string) {
  return {
    ok: true,
    json: async () => ({
      choices: [{ message: { content } }],
    }),
    text: async () => "",
  };
}

/** 11:00 UTC = 14:00 Kyiv (summer) — firmly inside the free window. */
const DAY_TIME = new Date("2024-06-15T11:00:00Z");
/** Drop-off 3 hours earlier (08:00 UTC = 11:00 Kyiv). */
const DROPOFF_TIME = new Date("2024-06-15T08:00:00Z");

describe("re-engagement worker", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
  });

  it("queries users with due reEngagementNextAt, not a staleness cutoff", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const api = createMockApi();
    await reEngagementTick(api, { now: DAY_TIME });

    const call = (prisma.user.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe("onboarding");
    expect(call.where.reEngagementNextAt).toEqual({ not: null, lte: DAY_TIME });
    expect(call.where.lastMessageAt).toBeUndefined();
  });

  it("returns 0 when nothing is due", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const api = createMockApi();
    const count = await reEngagementTick(api, { now: DAY_TIME });
    expect(count).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
  });

  it("sends touch 1 hook and schedules touch 2 following it", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        telegramId: BigInt(111),
        onboardingStep: "conversational",
        messageHistory: [{ role: "user", content: "hi" }],
        language: "en",
        firstName: "Alice",
        lastMessageAt: DROPOFF_TIME,
        reEngagementStep: 0,
      },
    ]);

    const mockFetch = vi
      .fn()
      .mockResolvedValue(openaiTextResponse("Hey Alice! Let's finish your profile!"));
    const api = createMockApi();

    const count = await reEngagementTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(count).toBe(1);
    expect(api.sendMessage).toHaveBeenCalledWith(
      111,
      "Hey Alice! Let's finish your profile!",
      { parse_mode: "Markdown" },
    );

    const updateArgs = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.where).toEqual({ telegramId: BigInt(111) });
    expect(updateArgs.data.reEngagementStep).toBe(1);
    expect(updateArgs.data.reEngagementNextAt).toBeInstanceOf(Date);
    // Next touch (step 2, +2h anchor) should be ~2h after DROPOFF_TIME (10:00 UTC).
    // But current step-1 is being delivered at 11:00 UTC, so next-at may be floored to now+1min.
    expect(updateArgs.data.reEngagementNextAt!.getTime()).toBeGreaterThan(DAY_TIME.getTime());
    // Never mutate lastMessageAt from the worker — the bot's own sends aren't user activity.
    expect(updateArgs.data.lastMessageAt).toBeUndefined();
  });

  it("nulls reEngagementNextAt after delivering the final (step 5) touch", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        telegramId: BigInt(222),
        onboardingStep: "conversational",
        messageHistory: [],
        language: "en",
        firstName: null,
        lastMessageAt: DROPOFF_TIME,
        reEngagementStep: MAX_RE_ENGAGEMENT_STEP - 1, // delivering the last touch
      },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiTextResponse("last one"));
    const api = createMockApi();

    await reEngagementTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    const updateArgs = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.data.reEngagementStep).toBe(MAX_RE_ENGAGEMENT_STEP);
    expect(updateArgs.data.reEngagementNextAt).toBeNull();
  });

  it("still advances the step when sendMessage fails (avoids hammering blocked users)", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        telegramId: BigInt(444),
        onboardingStep: "language",
        messageHistory: [],
        language: "en",
        firstName: null,
        lastMessageAt: DROPOFF_TIME,
        reEngagementStep: 0,
      },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiTextResponse("Come back!"));
    const api = createMockApi();
    api.sendMessage.mockRejectedValue(new Error("Forbidden: bot was blocked by the user"));

    const count = await reEngagementTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    expect(count).toBe(0);
    const updateArgs = (prisma.user.update as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.data.reEngagementStep).toBe(1);
  });

  it("includes per-touch tone hint in the LLM prompt", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        telegramId: BigInt(777),
        onboardingStep: "conversational",
        messageHistory: [],
        language: "en",
        firstName: "Eve",
        lastMessageAt: DROPOFF_TIME,
        reEngagementStep: 2, // delivering touch 3
      },
    ]);

    const mockFetch = vi.fn().mockResolvedValue(openaiTextResponse("evening nudge"));
    const api = createMockApi();

    await reEngagementTick(api, { fetchFn: mockFetch, now: DAY_TIME });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toContain("Touch 3 of 5");
    expect(body.messages[0].content).toContain("Evening nudge");
  });

  it("respects batchSize limit", async () => {
    const users = Array.from({ length: 5 }, (_, i) => ({
      telegramId: BigInt(100 + i),
      onboardingStep: "conversational",
      messageHistory: [],
      language: "en",
      firstName: `User${i}`,
      lastMessageAt: DROPOFF_TIME,
      reEngagementStep: 0,
    }));
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(users);

    const mockFetch = vi.fn().mockResolvedValue(openaiTextResponse("Come back!"));
    const api = createMockApi();

    const count = await reEngagementTick(api, {
      fetchFn: mockFetch,
      batchSize: 5,
      now: DAY_TIME,
    });

    expect(count).toBe(5);
    const findCall = (prisma.user.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(findCall.take).toBe(5);
  });
});

describe("getFallbackMessage", () => {
  it("returns English touch-1 fallback", () => {
    const msg = getFallbackMessage("Alice", "en", 1);
    expect(msg).toContain("Alice");
    expect(msg).toMatch(/still with us/i);
  });

  it("softens tone at the final touch", () => {
    const enFinal = getFallbackMessage("Alice", "en", MAX_RE_ENGAGEMENT_STEP);
    expect(enFinal.toLowerCase()).toContain("last");
    const ruFinal = getFallbackMessage("Иван", "ru", MAX_RE_ENGAGEMENT_STEP);
    expect(ruFinal).toContain("последнее");
  });

  it("supports Ukrainian", () => {
    const msg = getFallbackMessage("", "uk", 1);
    expect(msg).toMatch(/Гей/);
  });
});
