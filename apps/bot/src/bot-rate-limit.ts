import type { MiddlewareFn } from "grammy";
import { DEFAULT_SESSION, SUPPORTED_LANGUAGES, t, type Language } from "@gennety/shared";
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
 * write. Two middlewares are the bot-side chokepoint:
 *
 *   - `botFloodGate` (layer 1, flood): drop a scripted message flood *before*
 *     it is enqueued on the chat queue — so before any session read, LLM call
 *     or DB write. Thresholds are deliberately loose (config.ts) so a human
 *     filling the questionnaire fast never trips them.
 *   - `botRateLimit` (layers 2/3, token budget): defer a user who has burned
 *     their daily OpenAI token budget, and trip the global hourly breaker under
 *     a coordinated attack. Spend is attributed by wrapping the rest of the
 *     update in the usage context, which `openaiFetch` reads.
 *
 * Why the split (audit B-23). `sequentializeByChat` detaches every update onto
 * its chat's queue and acks it to the polling loop at once (A13-H9, accepted
 * design). The flood meter used to run INSIDE the queued task, because its
 * notice reads `ctx.session.language` — so a flooding chat was metered only as
 * fast as its queue drained, and the queue itself grew without bound. The gate
 * now runs before the queue and resolves the notice language from Telegram's
 * own `from.language_code` instead of the session. The budget layers stay
 * behind the queue: `runWithUsage` must wrap the handler that actually runs,
 * and their notice keeps the user's chosen language.
 *
 * Only text/voice messages are metered. Inline-button callbacks, edited service
 * messages, etc. always pass — tapping Accept/Decline must never be throttled.
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
  } catch (err) {
    // A failed notice must not break the drop path.
    console.warn("[bot-rate-limit] notice failed", { fromId: ctx.from?.id, err });
  }
}

/** The metering key for a text/voice message, or null for anything unmetered. */
function meteredKey(ctx: BotContext): string | null {
  const fromId = ctx.from?.id;
  const msg = ctx.message;
  if (!fromId || !msg || !(msg.text || msg.voice)) return null;
  return telegramUsageKey(fromId);
}

/**
 * The flood notice's language without a session: Telegram's IETF tag
 * (`ru`, `uk`, `pt-br`, …) reduced to its primary subtag and matched against
 * the languages we ship, else the session default.
 */
export function languageFromTelegramCode(code: string | undefined): Language {
  const primary = code?.toLowerCase().split("-")[0];
  const match = SUPPORTED_LANGUAGES.find((lang) => lang === primary);
  return match ?? DEFAULT_SESSION.language;
}

/**
 * Layer 1 — mounted BEFORE `sequentializeByChat`, so a dropped message is never
 * enqueued. Reads nothing but `ctx.from` and `ctx.message`.
 */
export function createBotFloodGate(
  overrides: Partial<Pick<BotRateLimitDeps, "limiter" | "rateLimitEnabled">> = {},
): MiddlewareFn<BotContext> {
  const deps = { ...defaultDeps(), ...overrides };

  return async (ctx, next) => {
    if (!deps.rateLimitEnabled) return next();
    const key = meteredKey(ctx);
    if (!key) return next();

    deps.limiter.recordMessage(key);
    const flood = deps.limiter.checkFlood(key);
    if (flood.flooded) {
      if (flood.shouldNotify) {
        await replySafely(
          ctx,
          t(languageFromTelegramCode(ctx.from?.language_code), "rateLimitFloodNotice"),
        );
      }
      return; // dropped: not enqueued, no session, no LLM, no DB write
    }
    return next();
  };
}

/**
 * Layers 2/3 — mounted after `sessionMiddleware` (the notice speaks the user's
 * chosen language) and before the handler routers, so a deferred update
 * reaches nothing downstream.
 */
export function createBotRateLimit(
  overrides: Partial<BotRateLimitDeps> = {},
): MiddlewareFn<BotContext> {
  const deps = { ...defaultDeps(), ...overrides };

  return async (ctx, next) => {
    const key = meteredKey(ctx);
    if (!key) return next();

    // Per-user daily budget + global hourly breaker. The global check is
    // self-gating (off unless a budget is configured), so it stands
    // independent of the per-user flag.
    const overUserBudget = deps.tokenBudgetEnabled && deps.limiter.isOverDailyBudget(key);
    if (overUserBudget || deps.limiter.isGlobalBudgetExceeded()) {
      if (deps.limiter.shouldNotifyBudget(key)) {
        await replySafely(ctx, t(ctx.session.language, "rateLimitDailyBudgetNotice"));
      }
      return; // dropped
    }

    // Attribute any OpenAI tokens spent while handling this update.
    return deps.runWithUsage(key, () => Promise.resolve(next()));
  };
}

/** Process-wide instances wired into `bot.ts`. */
export const botFloodGate = createBotFloodGate();
export const botRateLimit = createBotRateLimit();
