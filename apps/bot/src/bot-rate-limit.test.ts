import { describe, it, expect, vi, beforeEach } from "vitest";
import { t } from "@gennety/shared";
import {
  createBotFloodGate,
  createBotRateLimit,
  languageFromTelegramCode,
  type BotRateLimitDeps,
} from "./bot-rate-limit.js";
import { createChatQueue } from "./chat-queue.js";
import { createUsageLimiter } from "./services/usage-limiter.js";
import type { BotContext } from "./session.js";

function fakeLimiter() {
  return {
    recordMessage: vi.fn(),
    checkFlood: vi.fn().mockReturnValue({ flooded: false, shouldNotify: false }),
    isOverDailyBudget: vi.fn().mockReturnValue(false),
    shouldNotifyBudget: vi.fn().mockReturnValue(true),
    isGlobalBudgetExceeded: vi.fn().mockReturnValue(false),
  };
}

function fakeCtx(overrides: Partial<BotContext> = {}): BotContext {
  return {
    from: { id: 1 },
    chat: { id: 1 },
    message: { text: "hello" },
    session: { language: "en" },
    reply: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as BotContext;
}

function build(overrides: Partial<BotRateLimitDeps> = {}) {
  const limiter = overrides.limiter ?? fakeLimiter();
  const runWithUsage = vi.fn(
    (_key: string, fn: () => Promise<unknown>) => fn(),
  ) as unknown as BotRateLimitDeps["runWithUsage"];
  const mw = createBotRateLimit({
    limiter,
    rateLimitEnabled: true,
    tokenBudgetEnabled: true,
    runWithUsage,
    ...overrides,
  });
  return { mw, limiter, runWithUsage };
}

describe("botFloodGate (layer 1, before the chat queue)", () => {
  let next: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined);
  });

  it("meters a normal message and lets it through", async () => {
    const limiter = fakeLimiter();
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: true });
    const ctx = fakeCtx();
    await gate(ctx, next);

    expect(limiter.recordMessage).toHaveBeenCalledWith("tg:1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("drops a flood and notifies once, in Telegram's language — no session needed", async () => {
    const limiter = fakeLimiter();
    limiter.checkFlood.mockReturnValue({ flooded: true, shouldNotify: true });
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: true });
    // No session at all: the gate runs before `sessionMiddleware`.
    const ctx = fakeCtx({
      from: { id: 1, language_code: "uk" },
      session: undefined,
    } as unknown as Partial<BotContext>);
    await gate(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledWith(t("uk", "rateLimitFloodNotice"));
  });

  it("drops a flood without a notice when the cooldown is active", async () => {
    const limiter = fakeLimiter();
    limiter.checkFlood.mockReturnValue({ flooded: true, shouldNotify: false });
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: true });
    const ctx = fakeCtx();
    await gate(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("never throttles non-message updates (e.g. button taps)", async () => {
    const limiter = fakeLimiter();
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: true });
    await gate(fakeCtx({ message: undefined }), next);

    expect(limiter.recordMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips flood metering when the flag is disabled", async () => {
    const limiter = fakeLimiter();
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: false });
    await gate(fakeCtx(), next);

    expect(limiter.recordMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  // B-23: the meter used to run inside the queued task, so a flooding chat was
  // metered only as fast as its queue drained — and the queue grew unbounded.
  it("a flood beyond the limit never reaches the chat queue", async () => {
    const limiter = createUsageLimiter({
      burstLimit: 3,
      burstWindowMs: 60_000,
      sustainedLimit: 100,
      sustainedWindowMs: 600_000,
      dailyTokenBudget: 0,
      tokenWindowMs: 86_400_000,
      globalTokenBudget: 0,
      globalWindowMs: 3_600_000,
      noticeCooldownMs: 30_000,
      sweepIntervalMs: 600_000,
      now: () => 1_000_000,
    });
    const gate = createBotFloodGate({ limiter, rateLimitEnabled: true });
    const queue = createChatQueue({ maxConcurrent: 1 });
    const queued = queue.sequentializeByChat({ onDetachedError: () => {} });
    // The handler never finishes, so every task that got in stays pending.
    const handler = vi.fn(() => new Promise<void>(() => {}));

    for (let i = 0; i < 20; i++) {
      const ctx = fakeCtx();
      await gate(ctx, async () => {
        await queued(ctx, handler);
      });
    }

    expect(queue.pendingTasks()).toBe(3);
  });
});

describe("botRateLimit (layers 2/3, after the session)", () => {
  let next: ReturnType<typeof vi.fn<() => Promise<void>>>;
  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined);
  });

  it("passes a normal message through and attributes spend", async () => {
    const { mw, limiter, runWithUsage } = build();
    const ctx = fakeCtx();
    await mw(ctx, next);

    // Flood metering moved to the gate — it is never counted twice.
    expect(limiter.recordMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(runWithUsage).toHaveBeenCalledWith("tg:1", expect.any(Function));
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("defers a user over the daily token budget", async () => {
    const limiter = fakeLimiter();
    limiter.isOverDailyBudget.mockReturnValue(true);
    const { mw } = build({ limiter });
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("trips the global breaker even when the per-user budget flag is off", async () => {
    const limiter = fakeLimiter();
    limiter.isGlobalBudgetExceeded.mockReturnValue(true);
    const { mw } = build({ limiter, tokenBudgetEnabled: false });
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(next).not.toHaveBeenCalled();
  });

  it("never throttles non-message updates (e.g. button taps)", async () => {
    const limiter = fakeLimiter();
    limiter.isGlobalBudgetExceeded.mockReturnValue(true);
    const { mw } = build({ limiter });
    await mw(fakeCtx({ message: undefined }), next);

    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe("languageFromTelegramCode", () => {
  it("maps a shipped language by its primary subtag, else the default", () => {
    expect(languageFromTelegramCode("ru")).toBe("ru");
    expect(languageFromTelegramCode("de-AT")).toBe("de");
    expect(languageFromTelegramCode("PL")).toBe("pl");
    expect(languageFromTelegramCode("pt-br")).toBe("en");
    expect(languageFromTelegramCode(undefined)).toBe("en");
  });
});
