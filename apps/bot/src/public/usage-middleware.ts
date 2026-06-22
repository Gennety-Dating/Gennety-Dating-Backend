import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";
import { runWithUsage, userUsageKey } from "../services/usage-context.js";
import { usageLimiter } from "../services/usage-limiter.js";

/**
 * Token-budget guard for the JWT-authed LLM routers (`/v1/chat`,
 * `/v1/assistant`, `/v1/onboarding`). Mount **after** `requireAuth` so
 * `req.userId` is set.
 *
 * The existing `express-rate-limit` limiters cap *requests*; this caps *tokens*.
 * A user over the daily OpenAI token budget (or the global hourly breaker) gets
 * a 429; otherwise the request is wrapped in the usage context so `openaiFetch`
 * attributes the spend to this user. The Telegram bot has the equivalent guard
 * in `bot-rate-limit.ts`, keyed `user:`/`tg:` so the two surfaces never collide.
 */
export function usageGuard(req: Request, res: Response, next: NextFunction): void {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }

  const key = userUsageKey(userId);
  const overUserBudget = env.LLM_TOKEN_BUDGET_ENABLED && usageLimiter.isOverDailyBudget(key);
  if (overUserBudget || usageLimiter.isGlobalBudgetExceeded()) {
    res.status(429).json({
      error: "daily_token_budget",
      message: "You've reached today's usage limit — please try again tomorrow.",
    });
    return;
  }

  // Attribute any OpenAI tokens spent downstream to this user. `next()` runs
  // synchronously inside the context, so async handlers inherit it.
  runWithUsage(key, () => Promise.resolve(next()));
}
