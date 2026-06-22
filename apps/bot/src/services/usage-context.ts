import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Ambient "who is spending OpenAI tokens right now" context.
 *
 * Entry points (the Telegram rate-limit middleware, the public-API LLM
 * routers) wrap downstream handling in `runWithUsage(key, fn)`. The low-level
 * `openaiFetch` wrapper (services/openai-fetch.ts) then reads `currentUsageKey`
 * after every call and attributes the `usage.total_tokens` OpenAI returns to
 * that key — without every scattered call site having to thread a userId.
 *
 * Keys are namespaced so the bot and mobile surfaces never collide:
 *   - `tg:<telegramId>`  — Telegram bot updates
 *   - `user:<userId>`    — authenticated mobile `/v1/*` requests
 *
 * Built on `node:async_hooks` (no new dependency). When no context is active
 * (e.g. a cron worker), `currentUsageKey()` is `undefined` and the spend is
 * counted only against the global budget, not any user.
 */

interface UsageContext {
  key: string;
}

const storage = new AsyncLocalStorage<UsageContext>();

/** Run `fn` with `key` as the ambient spender for any OpenAI calls inside it. */
export function runWithUsage<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return storage.run({ key }, fn);
}

/** The current ambient spender key, or `undefined` outside any context. */
export function currentUsageKey(): string | undefined {
  return storage.getStore()?.key;
}

/** Build the canonical key for a Telegram user. */
export function telegramUsageKey(telegramId: number | bigint | string): string {
  return `tg:${telegramId}`;
}

/** Build the canonical key for an authenticated mobile user. */
export function userUsageKey(userId: string): string {
  return `user:${userId}`;
}
