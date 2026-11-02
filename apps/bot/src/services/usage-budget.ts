import { env } from "../config.js";
import { userUsageKey } from "./usage-context.js";
import { usageLimiter } from "./usage-limiter.js";

/**
 * Over the person's daily budget, or the global breaker is open. Lives in the
 * services layer so a service can ask without importing the HTTP middleware;
 * `public/usage-middleware.ts` re-exports it for the routes.
 */
export function isOverTokenBudget(userId: string): boolean {
  const overUserBudget =
    env.LLM_TOKEN_BUDGET_ENABLED && usageLimiter.isOverDailyBudget(userUsageKey(userId));
  return overUserBudget || usageLimiter.isGlobalBudgetExceeded();
}
