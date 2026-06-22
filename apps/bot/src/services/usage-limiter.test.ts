import { describe, it, expect, beforeEach } from "vitest";
import { createUsageLimiter, type UsageLimiterConfig } from "./usage-limiter.js";

let clock = 0;
const now = (): number => clock;

function make(overrides: Partial<UsageLimiterConfig> = {}) {
  return createUsageLimiter({
    burstLimit: 3,
    burstWindowMs: 1_000,
    sustainedLimit: 5,
    sustainedWindowMs: 10_000,
    dailyTokenBudget: 100,
    tokenWindowMs: 60_000,
    globalTokenBudget: 0,
    globalWindowMs: 60_000,
    noticeCooldownMs: 500,
    sweepIntervalMs: 1_000_000,
    now,
    ...overrides,
  });
}

beforeEach(() => {
  clock = 0;
});

describe("usage-limiter flood guard", () => {
  it("allows messages up to the burst limit, trips on the next", () => {
    const limiter = make();
    for (let i = 0; i < 3; i++) limiter.recordMessage("tg:1");
    expect(limiter.checkFlood("tg:1").flooded).toBe(false);

    limiter.recordMessage("tg:1"); // 4th in the window
    expect(limiter.checkFlood("tg:1").flooded).toBe(true);
  });

  it("resets the burst window after it elapses", () => {
    const limiter = make();
    for (let i = 0; i < 4; i++) limiter.recordMessage("tg:1");
    expect(limiter.checkFlood("tg:1").flooded).toBe(true);

    clock += 1_001; // past burstWindowMs; sustained (4 < 5) still fine
    expect(limiter.checkFlood("tg:1").flooded).toBe(false);
  });

  it("trips the sustained window even under the burst cap", () => {
    const limiter = make({ burstLimit: 100, sustainedLimit: 5 });
    for (let i = 0; i < 6; i++) limiter.recordMessage("tg:1");
    expect(limiter.checkFlood("tg:1").flooded).toBe(true);
  });

  it("gates repeat notices by the cooldown", () => {
    const limiter = make();
    for (let i = 0; i < 4; i++) limiter.recordMessage("tg:1");

    expect(limiter.checkFlood("tg:1").shouldNotify).toBe(true);
    expect(limiter.checkFlood("tg:1").shouldNotify).toBe(false); // within cooldown

    clock += 501; // past noticeCooldownMs
    expect(limiter.checkFlood("tg:1").shouldNotify).toBe(true);
  });

  it("isolates counters per key", () => {
    const limiter = make();
    for (let i = 0; i < 4; i++) limiter.recordMessage("tg:1");
    expect(limiter.checkFlood("tg:1").flooded).toBe(true);
    expect(limiter.checkFlood("tg:2").flooded).toBe(false);
  });
});

describe("usage-limiter daily token budget", () => {
  it("trips once the rolling budget is reached", () => {
    const limiter = make();
    limiter.recordTokens("tg:1", 60);
    expect(limiter.isOverDailyBudget("tg:1")).toBe(false);

    limiter.recordTokens("tg:1", 40); // 100 >= budget
    expect(limiter.isOverDailyBudget("tg:1")).toBe(true);
  });

  it("rolls the token window over after 24h", () => {
    const limiter = make();
    limiter.recordTokens("tg:1", 100);
    expect(limiter.isOverDailyBudget("tg:1")).toBe(true);

    clock += 60_001; // past tokenWindowMs
    expect(limiter.isOverDailyBudget("tg:1")).toBe(false);
  });

  it("never trips when the budget is disabled (0)", () => {
    const limiter = make({ dailyTokenBudget: 0 });
    limiter.recordTokens("tg:1", 10_000);
    expect(limiter.isOverDailyBudget("tg:1")).toBe(false);
  });
});

describe("usage-limiter global breaker", () => {
  it("trips the global hourly budget across all keys", () => {
    const limiter = make({ globalTokenBudget: 50 });
    limiter.recordTokens("tg:1", 30);
    expect(limiter.isGlobalBudgetExceeded()).toBe(false);
    limiter.recordTokens("tg:2", 30); // 60 >= 50, different key
    expect(limiter.isGlobalBudgetExceeded()).toBe(true);
  });

  it("counts keyless (worker) spend toward the global budget only", () => {
    const limiter = make({ globalTokenBudget: 50 });
    limiter.recordTokens(undefined, 50);
    expect(limiter.isGlobalBudgetExceeded()).toBe(true);
    expect(limiter.isOverDailyBudget("tg:1")).toBe(false);
  });

  it("is inert when the global budget is 0", () => {
    const limiter = make({ globalTokenBudget: 0 });
    limiter.recordGlobalTokens(1_000_000);
    expect(limiter.isGlobalBudgetExceeded()).toBe(false);
  });
});
