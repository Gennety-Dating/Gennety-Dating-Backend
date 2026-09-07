/**
 * A `Map` that forgets its least recently written key instead of growing
 * forever.
 *
 * Every in-process cache keyed by *person* is a leak with a slow fuse: the
 * process lives for weeks, the key space is the user base, and nothing ever
 * removes the entry of someone who simply stopped being served. The pattern
 * already exists twice inline (`public/routes/ticket.ts` avatar bytes,
 * `services/referral-card/index.ts` encoded cards); this is the same idea
 * behind a type, so a call site keeps writing plain `.set` and cannot forget
 * the sweep.
 *
 * Least recently **written**, not created: re-inserting an existing key moves
 * it to the end of the iteration order, so a key touched every minute is never
 * the one evicted. Plain FIFO would evict exactly the people currently being
 * served.
 *
 * Eviction must be harmless by construction — this is a cache, and every
 * caller has to treat a miss as "recompute", never as "absent".
 */
export class BoundedMap<K, V> extends Map<K, V> {
  private readonly max: number;

  constructor(max: number) {
    super();
    this.max = Math.max(1, Math.floor(max));
  }

  override set(key: K, value: V): this {
    // Drop first so the re-insert lands at the newest end of the order.
    this.delete(key);
    if (this.size >= this.max) {
      // Insertion-ordered, so the first key is the oldest write.
      const oldest = this.keys().next().value;
      if (oldest !== undefined) this.delete(oldest);
    }
    return super.set(key, value);
  }
}
