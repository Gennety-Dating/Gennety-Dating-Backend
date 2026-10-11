import { BoundedMap } from "./bounded-map.js";

/**
 * Idempotent sends keyed by a client-minted `clientMessageId` (audit B-09 /
 * I-12, contract decision 2026-10-11 #4).
 *
 * A send whose response was lost — a dropped connection, a timeout on a slow
 * turn — is retried by the client, and without this the retry relays the
 * message twice (proxy chat) or runs and bills a second agent turn (assistant
 * chat). With an id, the same person + the same id within `ttlMs` gets the
 * FIRST call's result back; a duplicate arriving while the first is still in
 * flight awaits that same promise instead of starting another.
 *
 * Only results `keep` accepts are remembered. A refusal (the window just
 * closed, a 4xx) or a thrown error is forgotten as soon as it settles, so a
 * retry asks again rather than replaying a failure the person can no longer
 * act on.
 *
 * In process memory: production is one PM2 process, and a restart in between
 * costs at most one duplicate. Bounded, so a client minting a fresh id per
 * request cannot grow it without limit.
 */
export const CLIENT_MESSAGE_ID_MIN = 8;
export const CLIENT_MESSAGE_ID_MAX = 64;

/**
 * The optional body field, or null when absent or not shaped like one. A
 * malformed id is ignored rather than refused: the field is a retry aid, and
 * the message itself is still worth sending.
 */
export function parseClientMessageId(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim();
  return id.length >= CLIENT_MESSAGE_ID_MIN && id.length <= CLIENT_MESSAGE_ID_MAX ? id : null;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

export class SendDedupe<T> {
  private readonly entries: BoundedMap<string, Entry<T>>;
  private readonly ttlMs: number;
  private readonly keep: (value: T) => boolean;

  constructor(options: { keep: (value: T) => boolean; ttlMs?: number; maxEntries?: number }) {
    this.keep = options.keep;
    this.ttlMs = options.ttlMs ?? 10 * 60 * 1000;
    this.entries = new BoundedMap(options.maxEntries ?? 5_000);
  }

  /** Run `send` once per (user, id); without an id it simply runs. */
  run(
    userId: string,
    clientMessageId: string | null,
    send: () => Promise<T>,
    now = Date.now(),
  ): Promise<T> {
    if (!clientMessageId) return send();
    const key = `${userId}\u0000${clientMessageId}`;
    const seen = this.entries.get(key);
    if (seen && seen.expiresAt > now) return seen.promise;

    const promise = send();
    this.entries.set(key, { promise, expiresAt: now + this.ttlMs });
    const forget = (): void => {
      if (this.entries.get(key)?.promise === promise) this.entries.delete(key);
    };
    // The caller handles the outcome; this branch only decides what to keep.
    promise.then((value) => {
      if (!this.keep(value)) forget();
    }, forget);
    return promise;
  }

  /** Tests only. */
  clear(): void {
    this.entries.clear();
  }
}
