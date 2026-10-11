import type { Request, Response, NextFunction } from "express";
import { env } from "../config.js";
import { runWithUsage, userUsageKey } from "../services/usage-context.js";
import { usageLimiter } from "../services/usage-limiter.js";

/**
 * Token-budget guard for the JWT-authed routes that spend OpenAI tokens
 * (`/v1/chat` turns, `/v1/assistant`, the `/v1/onboarding` turns). Mount
 * **after** `requireAuth` so `req.userId` is set, and only on routes that
 * actually reach the model: a read behind it answers 429 to someone who is
 * merely looking at what they already have (audit C-05).
 *
 * The existing `express-rate-limit` limiters cap *requests*; this caps *tokens*.
 * A user over the daily OpenAI token budget (or the global hourly breaker) gets
 * a 429; otherwise the request is wrapped in the usage context so `openaiFetch`
 * attributes the spend to this user. The Telegram bot has the equivalent guard
 * in `bot-rate-limit.ts`, keyed `user:`/`tg:` so the two surfaces never collide.
 */
/** The 429 body every token-budget refusal answers with, middleware or inline. */
export const TOKEN_BUDGET_REFUSAL = {
  error: "daily_token_budget",
  message: "You've reached today's usage limit — please try again tomorrow.",
} as const;

export function usageGuard(req: Request, res: Response, next: NextFunction): void {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }

  if (isOverTokenBudget(userId)) {
    res.status(429).json(TOKEN_BUDGET_REFUSAL);
    return;
  }

  // Attribute any OpenAI tokens spent downstream to this user. `next()` runs
  // synchronously inside the context, so async handlers inherit it.
  runWithUsage(userUsageKey(userId), () => Promise.resolve(next()));
}

/** Over the person's daily budget, or the global breaker is open. */
export function isOverTokenBudget(userId: string): boolean {
  const overUserBudget =
    env.LLM_TOKEN_BUDGET_ENABLED && usageLimiter.isOverDailyBudget(userUsageKey(userId));
  return overUserBudget || usageLimiter.isGlobalBudgetExceeded();
}

/**
 * Attribution without the refusal — for a route whose model call is optional
 * (a cache refresh) and which has something to show without it. The handler
 * checks `isOverTokenBudget` itself and skips the call instead of answering 429.
 */
export function usageAttribution(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.userId;
  if (!userId) {
    next();
    return;
  }
  runWithUsage(userUsageKey(userId), () => Promise.resolve(next()));
}
