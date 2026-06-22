import { env } from "../config.js";

/**
 * In-memory abuse counters for LLM spend protection.
 *
 * Single PM2 process (same model as `express-rate-limit`'s default store), so
 * plain in-memory windows are sufficient. A restart only *resets* the counters
 * — that fails open for legit users and an attacker cannot force restarts. If
 * cross-restart durability or admin telemetry is ever needed, back this with a
 * `usage_ledger` table; the interface here would not change.
 *
 * Three independent mechanisms, all fixed-window counters:
 *   1. Flood — per-key message rate (burst + sustained). Layer 1.
 *   2. Daily token budget — per-key OpenAI tokens / 24h. Layer 2.
 *   3. Global hourly token budget — process-wide kill switch. Layer 3.
 *
 * This module is pure mechanism. Whether to *enforce* a result (i.e. drop the
 * update) is policy, decided by the entry middlewares against the feature
 * flags — the limiter always counts and always answers truthfully.
 */

export interface UsageLimiterConfig {
  /** Max messages per burst window before flood trips. */
  burstLimit: number;
  burstWindowMs: number;
  /** Max messages per sustained window before flood trips. */
  sustainedLimit: number;
  sustainedWindowMs: number;
  /** Per-key OpenAI token budget per rolling window. */
  dailyTokenBudget: number;
  tokenWindowMs: number;
  /** Process-wide token budget per window (0 disables). */
  globalTokenBudget: number;
  globalWindowMs: number;
  /** Min gap between repeated user-facing notices for the same key. */
  noticeCooldownMs: number;
  /** How often to evict idle keys from the map. */
  sweepIntervalMs: number;
  /** Clock injection for deterministic tests. */
  now?: () => number;
}

export interface FloodResult {
  /** The key is currently over a flood limit; the update should be dropped. */
  flooded: boolean;
  /** Whether the caller should send a one-off notice (cooldown-gated). */
  shouldNotify: boolean;
}

interface WindowCounter {
  count: number;
  windowStart: number;
}

interface KeyState {
  burst: WindowCounter;
  sustained: WindowCounter;
  tokens: WindowCounter;
  lastFloodNoticeAt: number;
  lastBudgetNoticeAt: number;
  lastSeen: number;
}

export interface UsageLimiter {
  recordMessage(key: string): void;
  checkFlood(key: string): FloodResult;
  recordTokens(key: string | undefined, tokens: number): void;
  isOverDailyBudget(key: string): boolean;
  shouldNotifyBudget(key: string): boolean;
  recordGlobalTokens(tokens: number): void;
  isGlobalBudgetExceeded(): boolean;
  /** Test helper: drop all state. */
  reset(): void;
}

function freshCounter(now: number): WindowCounter {
  return { count: 0, windowStart: now };
}

/** Bump a fixed-window counter, rolling the window over if it has elapsed. */
function bump(counter: WindowCounter, amount: number, windowMs: number, now: number): void {
  if (now - counter.windowStart >= windowMs) {
    counter.count = 0;
    counter.windowStart = now;
  }
  counter.count += amount;
}

/** Read a fixed-window counter's current value, rolling over a stale window. */
function currentCount(counter: WindowCounter, windowMs: number, now: number): number {
  if (now - counter.windowStart >= windowMs) return 0;
  return counter.count;
}

export function createUsageLimiter(config: UsageLimiterConfig): UsageLimiter {
  const now = config.now ?? Date.now;
  const states = new Map<string, KeyState>();
  const global: WindowCounter = freshCounter(now());
  let lastSweep = now();

  function getState(key: string): KeyState {
    let state = states.get(key);
    const ts = now();
    if (!state) {
      state = {
        burst: freshCounter(ts),
        sustained: freshCounter(ts),
        tokens: freshCounter(ts),
        // -Infinity ⇒ "never notified", so the first notice always fires even
        // at clock 0 (`ts - lastNotice >= cooldown`).
        lastFloodNoticeAt: Number.NEGATIVE_INFINITY,
        lastBudgetNoticeAt: Number.NEGATIVE_INFINITY,
        lastSeen: ts,
      };
      states.set(key, state);
    }
    state.lastSeen = ts;
    return state;
  }

  /** Evict keys idle longer than the widest window, amortized on writes. */
  function maybeSweep(): void {
    const ts = now();
    if (ts - lastSweep < config.sweepIntervalMs) return;
    lastSweep = ts;
    const maxIdle = Math.max(config.sustainedWindowMs, config.tokenWindowMs);
    for (const [key, state] of states) {
      if (ts - state.lastSeen > maxIdle) states.delete(key);
    }
  }

  return {
    recordMessage(key) {
      const state = getState(key);
      const ts = now();
      bump(state.burst, 1, config.burstWindowMs, ts);
      bump(state.sustained, 1, config.sustainedWindowMs, ts);
      maybeSweep();
    },

    checkFlood(key) {
      const state = getState(key);
      const ts = now();
      const flooded =
        currentCount(state.burst, config.burstWindowMs, ts) > config.burstLimit ||
        currentCount(state.sustained, config.sustainedWindowMs, ts) > config.sustainedLimit;
      if (!flooded) return { flooded: false, shouldNotify: false };
      const shouldNotify = ts - state.lastFloodNoticeAt >= config.noticeCooldownMs;
      if (shouldNotify) state.lastFloodNoticeAt = ts;
      return { flooded: true, shouldNotify };
    },

    recordTokens(key, tokens) {
      if (tokens <= 0) return;
      this.recordGlobalTokens(tokens);
      if (!key) return;
      const state = getState(key);
      bump(state.tokens, tokens, config.tokenWindowMs, now());
    },

    isOverDailyBudget(key) {
      if (config.dailyTokenBudget <= 0) return false;
      const state = getState(key);
      return currentCount(state.tokens, config.tokenWindowMs, now()) >= config.dailyTokenBudget;
    },

    shouldNotifyBudget(key) {
      const state = getState(key);
      const ts = now();
      if (ts - state.lastBudgetNoticeAt < config.noticeCooldownMs) return false;
      state.lastBudgetNoticeAt = ts;
      return true;
    },

    recordGlobalTokens(tokens) {
      if (tokens <= 0) return;
      bump(global, tokens, config.globalWindowMs, now());
    },

    isGlobalBudgetExceeded() {
      if (config.globalTokenBudget <= 0) return false;
      return currentCount(global, config.globalWindowMs, now()) >= config.globalTokenBudget;
    },

    reset() {
      states.clear();
      global.count = 0;
      global.windowStart = now();
      lastSweep = now();
    },
  };
}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

/** Process-wide singleton built from env. Imported by the entry middlewares. */
export const usageLimiter: UsageLimiter = createUsageLimiter({
  burstLimit: env.BOT_FLOOD_BURST_LIMIT,
  burstWindowMs: env.BOT_FLOOD_BURST_WINDOW_MS,
  sustainedLimit: env.BOT_FLOOD_SUSTAINED_LIMIT,
  sustainedWindowMs: env.BOT_FLOOD_SUSTAINED_WINDOW_MS,
  dailyTokenBudget: env.LLM_USER_DAILY_TOKEN_BUDGET,
  tokenWindowMs: DAY_MS,
  globalTokenBudget: env.LLM_GLOBAL_HOURLY_TOKEN_BUDGET,
  globalWindowMs: HOUR_MS,
  noticeCooldownMs: 30_000,
  sweepIntervalMs: 600_000,
});
