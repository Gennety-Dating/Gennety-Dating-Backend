/**
 * Whether the bot can actually message a user.
 *
 * `telegramId > 0n` is NOT the test, and has not been since Telegram login
 * shipped: that rail stores a REAL positive id on an app-only account, and a
 * bot cannot open a chat with someone who never pressed Start. `platform` is
 * the canonical reachability check (ARCHITECTURE → `users`). A row predating
 * the column falls back to the id so no existing Telegram user loses anything.
 *
 * This lives in its own module because more than one fan-out needs it and the
 * cost of two copies is silent: the wrong copy does not throw, it addresses a
 * message to someone who will never see it — and then the silence back is read
 * as a choice. `coordination.ts` learned that in §4.5; `date-lifecycle.ts`'s
 * feedback prompt had the same bug.
 */
export function telegramReachable(u: {
  telegramId: bigint;
  /**
   * REQUIRED, and nullable only for rows that predate the column.
   *
   * It used to be optional, and that is what let the bug hide: a query that
   * forgot to `select` it produced `undefined`, which the old body read as
   * "assume Telegram" — exactly the wrong answer for the population this
   * function exists to catch. Required, a forgotten `select` is now a compile
   * error rather than a message addressed to someone who will never see it.
   * That type is the fix; the `undefined` branch below is only what happens if
   * something untyped still reaches here.
   */
  platform: string | null;
}): boolean {
  if (u.telegramId <= 0n) return false;
  // `null` is a row written before the column existed. `undefined` cannot occur
  // in typed code any more, and is treated the same rather than as a refusal:
  // failing closed on an untyped caller would silence a real Telegram user, and
  // the compile-time requirement above is what actually keeps callers honest.
  if (u.platform === null || u.platform === undefined) return true;
  return u.platform === "telegram" || u.platform === "both";
}

/** Whether a push is worth attempting — the app rails. */
export function pushReachable(u: { platform?: string | null }): boolean {
  return u.platform === "mobile" || u.platform === "both";
}
