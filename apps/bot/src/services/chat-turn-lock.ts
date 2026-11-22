/**
 * One person's chat work, one piece at a time: the agent's turns
 * (`chat-agent.ts`) and the deletion of a chat (`chat-session-delete.ts`). A
 * turn in flight would otherwise write its reply into a chat being erased.
 *
 * In memory, like the turn lock it was cut out of: the app runs on one process.
 */
const locks = new Map<string, Promise<unknown>>();

export async function withChatLock<T>(userId: string, work: () => Promise<T>): Promise<T> {
  const next = (locks.get(userId) ?? Promise.resolve()).then(work);
  // Swallow rejection on the chain — the caller sees the original error.
  const chain = next.catch(() => undefined);
  locks.set(userId, chain);
  try {
    return await next;
  } finally {
    if (locks.get(userId) === chain) locks.delete(userId);
  }
}
