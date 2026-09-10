import { readResponseBuffer } from "../utils/bounded-response.js";

/**
 * One Google Places photo, fetched for a client — the half two proxies share.
 *
 * `GET /v1/venue-change/photo` (the Mini App board, initData in the query) and
 * `GET /v1/venues/:id/photo` (the iOS standby canvas, a signed link) decide who
 * may ask and which photograph is meant in different ways, but once they hold a
 * Places media URL the job is identical: a short attempt, a retry only for what
 * is worth retrying, and a reason in the log when it gives up. That loop lived
 * inline in the venue-change route; a second copy would have been a second
 * place for the next retry fix to be forgotten.
 */

/**
 * Total budget for one proxied photo, retries included — deliberately the same
 * 10s the single-attempt version spent, so the retry below cannot make an
 * `<img>` wait any longer than it already could.
 */
const PHOTO_PROXY_TIMEOUT_MS = 10_000;
/**
 * Per-attempt ceiling. Google's photo endpoint answers in ~250ms warm, and the
 * failure this exists for is a TCP *connect* timeout that resolves in well
 * under a second — so a short attempt plus a retry beats one long wait.
 */
const PHOTO_PROXY_ATTEMPT_TIMEOUT_MS = 4_000;
const PHOTO_PROXY_MAX_ATTEMPTS = 3;
const PHOTO_PROXY_RETRY_DELAY_MS = 150;
const PHOTO_PROXY_MAX_BYTES = 10 * 1024 * 1024;

/**
 * One attempt at the upstream photo, classified into the only three answers the
 * caller can act on.
 *
 * The split between `transient` and `permanent` is the whole point: a connect
 * timeout to Google's CDN is worth another go, while a 403, a non-image body or
 * an oversized file will fail identically however many times we ask. Before
 * this, `readResponseBuffer` throwing on an oversized image landed in the same
 * `catch` as a network error, so a retry loop would have re-downloaded it.
 */
type PhotoAttempt =
  | { kind: "image"; contentType: string; body: Buffer }
  | { kind: "transient"; reason: string }
  | { kind: "permanent"; reason: string };

async function fetchPhotoOnce(url: string, timeoutMs: number): Promise<PhotoAttempt> {
  let upstream: Response;
  try {
    upstream = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    // Network-shaped: DNS, TCP connect, TLS, or our own abort.
    return { kind: "transient", reason: describeFetchError(err) };
  }

  if (!upstream.ok) {
    await upstream.body?.cancel().catch(() => undefined);
    const reason = `HTTP ${upstream.status}`;
    // 5xx / 429 / 408 are the upstream saying "not now"; a 4xx is a verdict.
    const retryable = upstream.status >= 500 || upstream.status === 429 || upstream.status === 408;
    return retryable ? { kind: "transient", reason } : { kind: "permanent", reason };
  }

  const contentType = upstream.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    await upstream.body?.cancel().catch(() => undefined);
    return { kind: "permanent", reason: `content-type ${contentType || "(none)"}` };
  }

  try {
    return { kind: "image", contentType, body: await readResponseBuffer(upstream, PHOTO_PROXY_MAX_BYTES) };
  } catch (err) {
    // Oversized, or the body died mid-stream. Either way, asking again for the
    // same bytes is not a fix.
    return { kind: "permanent", reason: describeFetchError(err) };
  }
}

/** Compact one-line cause, so a flaky day doesn't fill the log with stacks. */
function describeFetchError(err: unknown): string {
  const cause = (err as { cause?: unknown } | undefined)?.cause;
  const code = (cause as { code?: string } | undefined)?.code;
  if (code) return code;
  if (err instanceof Error) return err.name === "TimeoutError" ? "timeout" : err.message;
  return String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export interface PhotoBytes {
  contentType: string;
  body: Buffer;
}

export type PlacesPhotoResult =
  | ({ ok: true } & PhotoBytes)
  | { ok: false; attempts: number; reason: string };

/**
 * Fetch one Places photo, retrying a transient upstream failure within the
 * same overall budget.
 *
 * The board opens ~13 tiles at once and the client replaces a failed tile
 * with the category glyph, so a single dropped connection used to leave a
 * permanent hole in the gallery for the rest of the session. Measured on the
 * droplet (2026-08-08): occasional `ETIMEDOUT` connecting to Google's photo
 * CDN, roughly one request in ten under a parallel burst, in BOTH
 * deployments.
 *
 * `logTag` prefixes both log lines, so each proxy still says which surface
 * lost (or rescued) a photo.
 */
export async function fetchPlacesPhoto(url: string, logTag: string): Promise<PlacesPhotoResult> {
  const deadline = Date.now() + PHOTO_PROXY_TIMEOUT_MS;
  let attempts = 0;
  let lastReason = "no attempt";

  while (attempts < PHOTO_PROXY_MAX_ATTEMPTS) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    attempts += 1;

    const result = await fetchPhotoOnce(url, Math.min(remaining, PHOTO_PROXY_ATTEMPT_TIMEOUT_MS));

    if (result.kind === "image") {
      if (attempts > 1) {
        // Rare by definition, so one line per rescue is cheap — and it is the
        // only signal that the upstream path is degrading before it starts
        // costing users actual photos.
        console.warn(`${logTag} photo recovered on attempt ${attempts} (last: ${lastReason})`);
      }
      return { ok: true, contentType: result.contentType, body: result.body };
    }

    lastReason = result.reason;
    if (result.kind === "permanent") break;
    if (Date.now() + PHOTO_PROXY_RETRY_DELAY_MS >= deadline) break;
    await sleep(PHOTO_PROXY_RETRY_DELAY_MS);
  }

  // Always logged. Until 2026-08-08 the two non-throwing failures here (a
  // non-OK upstream and a non-image body) answered 502 in complete silence,
  // so a systematic upstream problem — a quota, a revoked key, a 429 storm —
  // was invisible in the logs and looked exactly like "photos just don't
  // work". Whatever the cause, it now says so.
  console.warn(`${logTag} photo proxy failed after ${attempts} attempt(s): ${lastReason}`);
  return { ok: false, attempts, reason: lastReason };
}

/**
 * The only widths either proxy will ask Google for.
 *
 * The width is part of the upstream URL, so **each distinct width is a
 * separately billed Place Photo request** — and it used to be a free parameter
 * clamped to anything in 200…1600. Any authenticated caller could therefore
 * multiply our Places bill by 1400× for the same photograph, one pixel at a
 * time, and the client's own retry (`photo-retry.ts`) would have looked exactly
 * the same in the logs.
 *
 * These two are what the Mini App actually renders — the 240px card tile and
 * the shared gallery/fullscreen width. The iOS canvas deliberately asks for the
 * same two (pin and card), so a photo either surface fetched shares its bill
 * with the other rather than adding a third width.
 */
export const ALLOWED_PHOTO_WIDTHS = [240, 1200] as const;

/**
 * Snap a requested width to the nearest allowed one.
 *
 * Snapping rather than rejecting, because an older cached Mini App bundle asks
 * for widths this list does not contain (1000 in the gallery, 1600 fullscreen,
 * before they were unified). Those must keep getting a picture; they just get
 * it at a width that shares a cache entry — and a bill — with everyone else's.
 */
export function snapWidth(raw: unknown): number {
  const n = typeof raw === "string" ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return ALLOWED_PHOTO_WIDTHS[1];
  return ALLOWED_PHOTO_WIDTHS.reduce((best, candidate) =>
    Math.abs(candidate - n) < Math.abs(best - n) ? candidate : best,
  );
}

/**
 * In-process cache of proxied photo bytes, keyed by whatever names one
 * photograph at one width.
 *
 * The venue-change board never needed one: its galleries are per match, and
 * two people rarely open the same board. The standby canvas is the opposite —
 * everyone in a city is shown the same two dozen places — so without it every
 * canvas open would be two dozen separately billed Place Photo requests for
 * pictures this process fetched a minute earlier for somebody else.
 *
 * Bounded by count AND by bytes: a 1200 px photo is ~150 KB, and a count limit
 * alone would let an unusually heavy set of pictures grow the process.
 * Least-recently-used goes first; a `Map` keeps insertion order, so
 * re-inserting on a hit is the whole of the LRU.
 */
export function createPhotoCache(opts: {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
  now?: () => number;
}) {
  const now = opts.now ?? Date.now;
  const store = new Map<string, PhotoBytes & { at: number }>();
  let bytes = 0;

  function drop(key: string): void {
    const hit = store.get(key);
    if (!hit) return;
    store.delete(key);
    bytes -= hit.body.length;
  }

  return {
    get(key: string): PhotoBytes | null {
      const hit = store.get(key);
      if (!hit) return null;
      if (now() - hit.at > opts.ttlMs) {
        drop(key);
        return null;
      }
      store.delete(key);
      store.set(key, hit);
      return { contentType: hit.contentType, body: hit.body };
    },
    set(key: string, photo: PhotoBytes): void {
      drop(key);
      if (photo.body.length > opts.maxBytes) return;
      store.set(key, { contentType: photo.contentType, body: photo.body, at: now() });
      bytes += photo.body.length;
      while (store.size > opts.maxEntries || bytes > opts.maxBytes) {
        const oldest = store.keys().next().value;
        if (oldest === undefined) break;
        drop(oldest);
      }
    },
    clear(): void {
      store.clear();
      bytes = 0;
    },
    get size(): number {
      return store.size;
    },
  };
}
