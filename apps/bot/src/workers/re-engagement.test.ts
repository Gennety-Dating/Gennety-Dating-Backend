import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: {
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

const { sendVerificationReminderMock } = vi.hoisted(() => ({
  sendVerificationReminderMock: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../handlers/onboarding/verification.js", () => ({
  sendVerificationReminder: sendVerificationReminderMock,
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
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
  });

  it("queries users with due reEngagementNextAt, not a staleness cutoff", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const api = createMockApi();
    await reEngagementTick(api, { now: DAY_TIME });

    const call = (prisma.user.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe("onboarding");
    expect(call.where.onboardingStep).toEqual({ not: "completed" });
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

  it("self-heals completed onboarding rows without sending reminders", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      {
        telegramId: BigInt(333),
        onboardingStep: "completed",
        messageHistory: [],
        language: "ru",
        firstName: "Alice",
        lastMessageAt: DROPOFF_TIME,
        reEngagementStep: 2,
      },
    ]);

    const api = createMockApi();
    const count = await reEngagementTick(api, { now: DAY_TIME });

    expect(count).toBe(0);
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { telegramId: BigInt(333) },
      data: {
        reEngagementStep: 0,
        reEngagementNextAt: null,
      },
    });
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

    const updateArgs = (prisma.user.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(updateArgs.where).toEqual(expect.objectContaining({ telegramId: BigInt(111), reEngagementStep: 0 }));
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

    const updateArgs = (prisma.user.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
    const updateArgs = (prisma.user.updateMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
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
    expect(body.messages[0].content).toContain("Same-day evening");
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
    expect(msg).toMatch(/still there/i);
  });

  it("softens tone at the final touch", () => {
    const enFinal = getFallbackMessage("Alice", "en", MAX_RE_ENGAGEMENT_STEP);
    expect(enFinal.toLowerCase()).toContain("last");
    const ruFinal = getFallbackMessage("Иван", "ru", MAX_RE_ENGAGEMENT_STEP);
    expect(ruFinal).toContain("последнее");
  });

  it("supports Ukrainian", () => {
    const msg = getFallbackMessage("", "uk", 1);
    expect(msg).toMatch(/гей/i);
  });

  it("supports German and Polish", () => {
    expect(getFallbackMessage("Max", "de", 1)).toContain("Profil");
    expect(getFallbackMessage("Ania", "pl", 1)).toContain("profil");
  });
});

// ---------------------------------------------------------------------------
// Registration v2 — verification-stall nudges (MANDATORY_VERIFICATION_ENABLED)
// ---------------------------------------------------------------------------

describe("verification-stall nudges (Registration v2)", () => {
  const cfgPromise = import("../config.js") as unknown as Promise<{
    env: Record<string, unknown>;
  }>;

  beforeEach(async () => {
    vi.clearAllMocks();
    (prisma.user.update as ReturnType<typeof vi.fn>).mockResolvedValue({});
    (prisma.user.updateMany as ReturnType<typeof vi.fn>).mockResolvedValue({ count: 1 });
    (await cfgPromise).env.MANDATORY_VERIFICATION_ENABLED = true;
  });
  afterEach(async () => {
    (await cfgPromise).env.MANDATORY_VERIFICATION_ENABLED = false;
  });

  it("nudges a user stalled at the verification CTA and advances the chain", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([]) // main onboarding chain: nothing due
      .mockResolvedValueOnce([
        { id: "uid-1", telegramId: 42n, language: "ru", reEngagementStep: 0 },
      ]);

    const api = createMockApi();
    const count = await reEngagementTick(api, { now: DAY_TIME });

    expect(count).toBe(1);
    expect(sendVerificationReminderMock).toHaveBeenCalledWith(
      expect.anything(),
      42,
      "ru",
      "uid-1",
    );
    // The stalled sweep targets completed-but-unactivated users only.
    const sweep = (prisma.user.findMany as ReturnType<typeof vi.fn>).mock.calls[1]![0];
    expect(sweep.where.onboardingStep).toBe("completed");
    expect(sweep.where.status).toBe("onboarding");
    expect(sweep.where.verificationStatus).toEqual({ in: ["pending", "unverified"] });
    // CAS claim advances the chain with the standard decaying cadence.
    const claim = (prisma.user.updateMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(claim.data.reEngagementStep).toBe(1);
    expect(claim.data.reEngagementNextAt).toBeInstanceOf(Date);
  });

  it("exhausts the chain after the final step (next-at nulled)", async () => {
    (prisma.user.findMany as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          id: "uid-1",
          telegramId: 42n,
          language: "en",
          reEngagementStep: MAX_RE_ENGAGEMENT_STEP,
        },
      ]);

    const api = createMockApi();
    await reEngagementTick(api, { now: DAY_TIME });

    const claim = (prisma.user.updateMany as ReturnType<typeof vi.fn>).mock.calls.at(-1)![0];
    expect(claim.data.reEngagementStep).toBe(MAX_RE_ENGAGEMENT_STEP + 1);
    expect(claim.data.reEngagementNextAt).toBeNull();
  });

  it("does nothing while the flag is off", async () => {
    (await cfgPromise).env.MANDATORY_VERIFICATION_ENABLED = false;
    (prisma.user.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);

    const api = createMockApi();
    await reEngagementTick(api, { now: DAY_TIME });

    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(sendVerificationReminderMock).not.toHaveBeenCalled();
  });
});
