/**
 * Concurrent callers asking for the same thing share one load.
 *
 * Strictly in-flight de-duplication, never a memo: the entry is removed before
 * the load's result reaches anyone, so a caller that arrives after a load has
 * finished always starts a new one. What a caller who joins gets is therefore
 * exactly what the load already running for it returns — it started at most one
 * load-duration before the joiner asked, which is the same answer the joiner's
 * own load would have produced had it arrived that much earlier.
 *
 * A failure is shared the same way: everyone waiting on the load sees its error.
 */
export interface SingleFlight<K, V> {
  /** The load in flight for `key`, or a new one started from `load`. */
  join(key: K, load: () => Promise<V>): { result: Promise<V>; joined: boolean };
  /** Loads currently in flight. */
  readonly size: number;
}

export function createSingleFlight<K, V>(): SingleFlight<K, V> {
  const flights = new Map<K, Promise<V>>();
  return {
    join(key: K, load: () => Promise<V>): { result: Promise<V>; joined: boolean } {
      const current = flights.get(key);
      if (current) return { result: current, joined: true };
      const entry: { result?: Promise<V> } = {};
      let settled = false;
      const result = (async (): Promise<V> => {
        try {
          return await load();
        } finally {
          // Before the result settles, so nobody can join a finished load. A
          // `load` that throws before returning a promise lands here
          // synchronously, while `entry.result` is still unset — and is then
          // simply never registered.
          settled = true;
          if (entry.result !== undefined && flights.get(key) === entry.result) {
            flights.delete(key);
          }
        }
      })();
      entry.result = result;
      if (!settled) flights.set(key, result);
      return { result, joined: false };
    },
    get size(): number {
      return flights.size;
    },
  };
}
