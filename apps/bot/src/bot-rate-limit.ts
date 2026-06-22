import type { MiddlewareFn } from "grammy";
import { t } from "@gennety/shared";
import type { BotContext } from "./session.js";
import { env } from "./config.js";
import { runWithUsage, telegramUsageKey } from "./services/usage-context.js";
import { usageLimiter, type UsageLimiter } from "./services/usage-limiter.js";

/**
 * Per-user anti-spam guard for the Telegram bot.
 *
 * The public `/v1/*` API is already covered by `express-rate-limit`, but the
 * long-polling bot bypasses Express entirely — every text/voice message that
 * reaches a handler can trigger an OpenAI call and a `messageHistory`/`Message`
 * write. This middleware is the bot-side chokepoint:
 *
 *   - Layer 1 (flood): drop a scripted message flood *before* any LLM call or
 *     DB write. Thresholds are deliberately loose (config.ts) so a human
 *     filling the questionnaire fast never trips them.
 *   - Layer 2 (token budget): defer a user who has burned their daily OpenAI
 *     token budget, and trip the global hourly breaker under a coordinated
 *     attack. Spend is attributed by wrapping the rest of the update in the
 *     usage context, which `openaiFetch` reads.
 *
 * Only text/voice messages are metered. Inline-button callbacks, edited service
 * messages, etc. always pass — tapping Accept/Decline must never be throttled.
 *
 * Registered after `sessionMiddleware` (needs `ctx.session.language`) and before
 * the handler routers, so a dropped update reaches nothing downstream.
 */

export interface BotRateLimitDeps {
  limiter: Pick<
    UsageLimiter,
    "recordMessage" | "checkFlood" | "isOverDailyBudget" | "shouldNotifyBudget" | "isGlobalBudgetExceeded"
  >;
  rateLimitEnabled: boolean;
  tokenBudgetEnabled: boolean;
  runWithUsage: typeof runWithUsage;
}

function defaultDeps(): BotRateLimitDeps {
  return {
    limiter: usageLimiter,
    rateLimitEnabled: env.BOT_RATE_LIMIT_ENABLED,
    tokenBudgetEnabled: env.LLM_TOKEN_BUDGET_ENABLED,
    runWithUsage,
  };
}

async function replySafely(ctx: BotContext, text: string): Promise<void> {
  try {
    await ctx.reply(text);
  } catch {
    // A failed notice must not break the drop path.
  }
}

export function createBotRateLimit(
  overrides: Partial<BotRateLimitDeps> = {},
): MiddlewareFn<BotContext> {
  const deps = { ...defaultDeps(), ...overrides };

  return async (ctx, next) => {
    const fromId = ctx.from?.id;
    const msg = ctx.message;
    const isMetered = Boolean(fromId && msg && (msg.text || msg.voice));
    if (!fromId || !isMetered) return next();

    const key = telegramUsageKey(fromId);
    const lang = ctx.session.language;

    // Layer 1 — flood guard.
    if (deps.rateLimitEnabled) {
      deps.limiter.recordMessage(key);
      const flood = deps.limiter.checkFlood(key);
      if (flood.flooded) {
        if (flood.shouldNotify) await replySafely(ctx, t(lang, "rateLimitFloodNotice"));
        return; // dropped: no handler, no LLM, no DB write
      }
    }

    // Layer 2/3 — per-user daily budget + global hourly breaker. The global
    // check is self-gating (off unless a budget is configured), so it stands
    // independent of the per-user flag.
    const overUserBudget = deps.tokenBudgetEnabled && deps.limiter.isOverDailyBudget(key);
    if (overUserBudget || deps.limiter.isGlobalBudgetExceeded()) {
      if (deps.limiter.shouldNotifyBudget(key)) {
        await replySafely(ctx, t(lang, "rateLimitDailyBudgetNotice"));
      }
      return; // dropped
    }

    // Attribute any OpenAI tokens spent while handling this update.
    return deps.runWithUsage(key, () => Promise.resolve(next()));
  };
}

/** Process-wide instance wired into `bot.ts`. */
export const botRateLimit = createBotRateLimit();
