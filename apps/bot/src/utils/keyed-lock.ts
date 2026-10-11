/**
 * One-at-a-time per key (audit B-06).
 *
 * An agent turn reads the person's history and progress, spends seconds in the
 * model, then writes them back. Two turns for the same person running at once
 * — a double tap, the app and Telegram together, a retry over a slow turn —
 * each write over the other's history. `run` chains calls with the same key so
 * the second starts when the first settles; different keys never wait on each
 * other. A failed call does not poison the chain: its error goes to its own
 * caller, and the next call still runs.
 *
 * Process-local, like the rest of the per-user state here: production is one
 * PM2 process. Never call `run` for a key from inside a `run` for the same key
 * — that waits on itself.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    // The chain only orders calls; each caller sees its own outcome above.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      // Idle again: drop the key so the map holds only people mid-turn.
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }

  /** Keys with a call queued or running — tests only. */
  get size(): number {
    return this.tails.size;
  }
}
