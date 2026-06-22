import { describe, it, expect, vi, beforeEach } from "vitest";
import { createBotRateLimit, type BotRateLimitDeps } from "./bot-rate-limit.js";
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

describe("botRateLimit middleware", () => {
  let next: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    next = vi.fn().mockResolvedValue(undefined);
  });

  it("passes a normal message through and attributes spend", async () => {
    const { mw, limiter, runWithUsage } = build();
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(limiter.recordMessage).toHaveBeenCalledWith("tg:1");
    expect(next).toHaveBeenCalledTimes(1);
    expect(runWithUsage).toHaveBeenCalledWith("tg:1", expect.any(Function));
    expect(ctx.reply).not.toHaveBeenCalled();
  });

  it("drops a flood and notifies once", async () => {
    const limiter = fakeLimiter();
    limiter.checkFlood.mockReturnValue({ flooded: true, shouldNotify: true });
    const { mw } = build({ limiter });
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(next).not.toHaveBeenCalled();
    expect(ctx.reply).toHaveBeenCalledTimes(1);
  });

  it("drops a flood without a notice when the cooldown is active", async () => {
    const limiter = fakeLimiter();
    limiter.checkFlood.mockReturnValue({ flooded: true, shouldNotify: false });
    const { mw } = build({ limiter });
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(next).not.toHaveBeenCalled();
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
    const { mw, limiter } = build();
    const ctx = fakeCtx({ message: undefined });
    await mw(ctx, next);

    expect(limiter.recordMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });

  it("skips flood metering when the flag is disabled", async () => {
    const { mw, limiter } = build({ rateLimitEnabled: false });
    const ctx = fakeCtx();
    await mw(ctx, next);

    expect(limiter.recordMessage).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
  });
});
