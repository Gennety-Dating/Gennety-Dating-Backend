import { AsyncLocalStorage } from "node:async_hooks";

/**
 * How many admin analytics queries may be out at the database at once,
 * process-wide.
 *
 * The admin API shares ONE Prisma pool with the iOS/Mini App API, the bot and
 * every cron job, and in production that pool is 3 connections. A dashboard
 * load used to start ~21 queries in one `Promise.all` (a founder-digest cache
 * miss ~34), so every connection — and the pool's wait queue — filled with
 * admin work, and a user's request that arrived next waited behind all of it.
 * Prisma serves its wait queue in arrival order, so the admin side now keeps
 * at most this many queries in that queue and holds the rest here, where only
 * admin requests wait.
 *
 * Only the scheduling changes: every query still runs, with the same
 * arguments, and the response is assembled from the same results. With a pool
 * of 3 the admin side never had more than 3 queries running anyway; what it
 * gives up is only the pool's queue position, so the founder-facing latency of
 * a heavy page rises only where the pool would have let more than 3 run at once
 * (the pending 10-connection pool).
 */
export const ADMIN_DB_CONCURRENCY = 3;

export interface ConcurrencyGate {
  /**
   * Run `task` once `weight` slots are free, in arrival order. A task started
   * from inside another task of the same gate runs at once, without waiting —
   * see `insideTask` below.
   */
  run<T>(task: () => PromiseLike<T>, weight?: number): Promise<T>;
  /** Slots currently held. */
  readonly inUse: number;
  /** Tasks waiting for a slot. */
  readonly waiting: number;
}

interface Waiter {
  weight: number;
  start: () => void;
}

/**
 * Weighted FIFO semaphore.
 *
 * Strictly first-in-first-out: a heavy task at the head of the line is not
 * overtaken by light ones behind it, so it cannot starve.
 *
 * Deadlock-free by construction: a task that holds slots and, directly or
 * through a helper, asks the same gate for more would wait for its own slots
 * forever. The `AsyncLocalStorage` marker makes such a nested call run inline
 * instead, so it does not matter which helpers a gated loader happens to call.
 */
export function createConcurrencyGate(capacity: number): ConcurrencyGate {
  const size = Math.max(1, Math.floor(capacity));
  const insideTask = new AsyncLocalStorage<true>();
  const queue: Waiter[] = [];
  let free = size;

  const release = (weight: number): void => {
    free += weight;
    while (queue.length > 0 && free >= queue[0]!.weight) {
      const next = queue.shift()!;
      free -= next.weight;
      next.start();
    }
  };

  return {
    async run<T>(task: () => PromiseLike<T>, weight = 1): Promise<T> {
      if (insideTask.getStore()) return task();
      const need = Math.min(size, Math.max(1, Math.floor(weight)));
      if (queue.length === 0 && free >= need) {
        free -= need;
      } else {
        await new Promise<void>((start) => queue.push({ weight: need, start }));
      }
      try {
        return await insideTask.run(true, task);
      } finally {
        release(need);
      }
    },
    get inUse(): number {
      return size - free;
    },
    get waiting(): number {
      return queue.length;
    },
  };
}

const adminGate = createConcurrencyGate(ADMIN_DB_CONCURRENCY);

/**
 * One admin database query, e.g. `adminQuery(() => prisma.user.count())`.
 *
 * Pass the query as a thunk: a Prisma query runs when it is awaited, so the
 * gate decides when that happens. Wrap single queries only — a loader that
 * itself goes through the gate is called directly, never wrapped.
 */
export function adminQuery<T>(query: () => PromiseLike<T>): Promise<T> {
  return adminGate.run(query);
}

/**
 * A loader from outside `admin/` that fans out to several queries of its own
 * (`loadPayerIndex` runs five in parallel). It cannot be gated query by query
 * from here, so it takes every slot and runs alone — the admin side then has
 * that loader's queries out and nothing else.
 */
export function adminQueryExclusive<T>(load: () => PromiseLike<T>): Promise<T> {
  return adminGate.run(load, ADMIN_DB_CONCURRENCY);
}
