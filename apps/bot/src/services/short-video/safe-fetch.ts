import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isPosterHost, isShortVideoHost } from "./links.js";

/**
 * The only place in this codebase that opens a URL a user typed.
 *
 * Everything else the bot fetches is an address we wrote ourselves (OpenAI,
 * Telegram, the weather API), so none of it ever needed an SSRF perimeter.
 * This does: a share link is attacker-controlled by construction, and the
 * poster URL is worse — it is read out of a page body, which is a value a
 * third party writes.
 *
 * Four walls, outermost first:
 *
 *  1. **Host allowlist**, re-checked at EVERY redirect hop. `vm.tiktok.com`
 *     redirecting to `169.254.169.254` fails here, not later.
 *  2. **Address check** before each hop: every address the hostname resolves
 *     to must be public unicast. Loopback, RFC1918, link-local (incl. the
 *     cloud metadata address), CGNAT, multicast and the documentation ranges
 *     are all refused, on both IPv4 and IPv6.
 *  3. **HTTPS only**, so a downgrade cannot be used to reach something the
 *     TLS name would have prevented.
 *  4. **Byte cap while streaming**, so a hostile or broken endpoint cannot
 *     make us buffer an unbounded body.
 *
 * On the DNS check being advisory: we resolve, verify, then let `fetch`
 * resolve again, so a record that changes in between is not caught (classic
 * rebinding). Pinning would mean connecting by IP with a custom dispatcher and
 * hand-managed SNI. Given wall 1 narrows the input to hostnames under
 * tiktok.com / instagram.com and their CDNs, rebinding here requires control
 * of those zones — at which point the attacker has better options than our
 * bot. The check stays because it is what catches a *legitimately* resolving
 * name that points somewhere internal.
 */

export type SafeFetchError =
  | "blocked" // host or address refused by the perimeter
  | "not_found" // 404/410 — the post is gone
  | "private" // 401/403 — the account went private
  | "rate_limited"
  | "timeout"
  | "network"
  | "too_large";

export type SafeFetchResult<T> =
  | ({ ok: true } & T)
  | { ok: false; error: SafeFetchError };

const MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 8_000;
const MAX_PAGE_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/**
 * A browser-shaped UA. Both platforms serve a stub — or nothing — to an
 * unrecognised agent, so this is what makes the metadata path work at all. It
 * is not an attempt to defeat a block: we send no cookies, no token, and we
 * only ever read what a logged-out browser would be served.
 */
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/* ── address classification ─────────────────────────────────────────────── */

function ipv4Bytes(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/** Expand an IPv6 literal (including `::` compression and a trailing dotted
 *  IPv4 tail) into its 16 bytes. Null when it is not a valid literal. */
function ipv6Bytes(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf("%");
  if (zone !== -1) text = text.slice(0, zone);

  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  const maybeV4 = text.slice(lastColon + 1);
  if (maybeV4.includes(".")) {
    const v4 = ipv4Bytes(maybeV4);
    if (!v4) return null;
    tail = v4;
    text = text.slice(0, lastColon + 1) + "0:0";
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const toGroups = (part: string): number[][] | null => {
    if (!part) return [];
    const groups: number[][] = [];
    for (const group of part.split(":")) {
      if (!/^[0-9a-fA-F]{1,4}$/u.test(group)) return null;
      const value = Number.parseInt(group, 16);
      groups.push([(value >> 8) & 0xff, value & 0xff]);
    }
    return groups;
  };

  const head = toGroups(halves[0] ?? "");
  const rest = toGroups(halves[1] ?? "");
  if (!head || !rest) return null;

  let groups: number[][];
  if (halves.length === 2) {
    // No allowance for `tail` here: a dotted IPv4 suffix was already rewritten
    // above into the two zero groups it occupies, so it is counted in `rest`.
    // Subtracting for it again shifts every byte one group left, which is how
    // `::ffff:127.0.0.1` reads as public — the exact bypass this guards.
    const missing = 8 - head.length - rest.length;
    if (missing < 0) return null;
    groups = [...head, ...Array.from({ length: missing }, () => [0, 0]), ...rest];
  } else {
    groups = head;
  }

  const bytes = groups.flat();
  const full = tail.length ? [...bytes.slice(0, 12), ...tail] : bytes;
  return full.length === 16 ? full : null;
}

function isPrivateIpv4(bytes: readonly number[]): boolean {
  const [a, b] = bytes as [number, number, number, number];
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments + TEST-NET-1
  if (a === 192 && b === 88) return true; // 6to4 relay anycast
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51) return true; // TEST-NET-2
  if (a === 203 && b === 0) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast + reserved + broadcast
  return false;
}

/**
 * True when an address is a public unicast address we are willing to connect
 * to. Exported for its own tests: this predicate is the whole perimeter, and a
 * quiet mistake in it (a range typo, a v4-mapped v6 slipping past) is exactly
 * the kind of bug that only shows up as an incident.
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return bytes !== null && !isPrivateIpv4(bytes);
  }
  if (family !== 6) return false;

  const bytes = ipv6Bytes(address);
  if (!bytes) return false;

  // ::ffff:a.b.c.d (v4-mapped) and 64:ff9b::/96 (NAT64) both carry a v4
  // address in the low 32 bits — judge them by that, or ::ffff:127.0.0.1
  // walks straight through an IPv6-shaped check.
  const mappedV4 =
    bytes.slice(0, 10).every((byte) => byte === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (mappedV4 || nat64) return !isPrivateIpv4(bytes.slice(12));

  if (bytes.every((byte) => byte === 0)) return false; // ::
  if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) {
    return false; // ::1
  }
  if ((bytes[0]! & 0xfe) === 0xfc) return false; // fc00::/7 unique-local
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) return false; // fe80::/10
  if (bytes[0] === 0xff) return false; // ff00::/8 multicast
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) {
    return false; // 2001:db8::/32 documentation
  }
  if (bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0)) {
    return false; // 100::/64 discard-only
  }
  return true;
}

/** Every address this hostname resolves to must be public. A hostname that is
 *  already a literal is checked directly — `lookup` would happily echo it. */
async function hostnameResolvesPublicly(
  hostname: string,
  resolver: typeof lookup,
): Promise<boolean> {
  const bare = hostname.replace(/^\[|\]$/gu, "");
  if (isIP(bare)) return isPublicAddress(bare);
  try {
    const addresses = await resolver(bare, { all: true, verbatim: true });
    if (addresses.length === 0) return false;
    return addresses.every((entry) => isPublicAddress(entry.address));
  } catch {
    return false;
  }
}

/* ── the guarded request ────────────────────────────────────────────────── */

export interface SafeFetchOptions {
  timeoutMs?: number;
  fetchFn?: typeof fetch;
  resolver?: typeof lookup;
  /** Extra request headers. Never carries credentials — see the module note. */
  headers?: Record<string, string>;
}

interface HopResult {
  response: Response;
  finalUrl: string;
}

/**
 * Walk the redirect chain by hand, re-checking the perimeter at every hop.
 * `allow` decides which allowlist applies, so a page fetch can never be
 * redirected into fetching from a CDN host and vice versa.
 */
async function requestWithGuard(
  startUrl: string,
  allow: (hostname: string) => boolean,
  options: SafeFetchOptions,
): Promise<SafeFetchResult<HopResult>> {
  const fetchFn = options.fetchFn ?? fetch;
  const resolver = options.resolver ?? lookup;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  let current = startUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let url: URL;
    try {
      url = new URL(current);
    } catch {
      return { ok: false, error: "blocked" };
    }
    // Upgrade rather than reject: people paste `http://vm.tiktok.com/…` and
    // both platforms are HTTPS-only anyway, so the upgrade loses nothing and
    // keeps the "https only past this point" rule absolute.
    if (url.protocol === "http:") url.protocol = "https:";
    if (url.protocol !== "https:") return { ok: false, error: "blocked" };
    if (!allow(url.hostname)) return { ok: false, error: "blocked" };
    if (!(await hostnameResolvesPublicly(url.hostname, resolver))) {
      return { ok: false, error: "blocked" };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) return { ok: false, error: "timeout" };

    let response: Response;
    try {
      response = await fetchFn(url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: AbortSignal.timeout(remaining),
        headers: {
          "User-Agent": USER_AGENT,
          "Accept-Language": "en;q=0.9",
          ...options.headers,
        },
      });
    } catch (error) {
      const name = (error as { name?: string }).name;
      return {
        ok: false,
        error: name === "AbortError" || name === "TimeoutError" ? "timeout" : "network",
      };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { ok: false, error: "network" };
      // Relative Locations are resolved against the hop we are on, then run
      // through the same walls on the next pass.
      try {
        current = new URL(location, url).toString();
      } catch {
        return { ok: false, error: "blocked" };
      }
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      return { ok: false, error: "not_found" };
    }
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: "private" };
    }
    if (response.status === 429) return { ok: false, error: "rate_limited" };
    if (!response.ok) return { ok: false, error: "network" };

    return { ok: true, response, finalUrl: url.toString() };
  }

  return { ok: false, error: "blocked" };
}

/**
 * Read a body with a hard byte cap, aborting the stream the moment it is
 * exceeded rather than after the fact. `Content-Length` is a hint we honour
 * when present but never trust on its own.
 */
async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Buffer | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) return null;

  const body = response.body;
  if (!body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.byteLength > maxBytes ? null : buffer;
  }

  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch {
    return null;
  }
  return Buffer.concat(chunks);
}

/** Fetch an HTML/JSON page from an allowlisted platform host. */
export async function fetchPlatformPage(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<{ body: string; finalUrl: string }>> {
  const hop = await requestWithGuard(url, isShortVideoHost, options);
  if (!hop.ok) return hop;
  const buffer = await readCapped(hop.response, MAX_PAGE_BYTES);
  if (!buffer) return { ok: false, error: "too_large" };
  return { ok: true, body: buffer.toString("utf8"), finalUrl: hop.finalUrl };
}

/**
 * Resolve a share stub to the URL it lands on, without reading the body.
 *
 * Still a GET: both platforms answer HEAD on their short hosts inconsistently,
 * and the body is capped anyway.
 */
export async function resolveRedirect(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<{ finalUrl: string }>> {
  const hop = await requestWithGuard(url, isShortVideoHost, options);
  if (!hop.ok) return hop;
  await hop.response.body?.cancel().catch(() => {});
  return { ok: true, finalUrl: hop.finalUrl };
}

/** Fetch a poster image from an allowlisted CDN host. */
export async function fetchPosterImage(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<{ buffer: Buffer }>> {
  const hop = await requestWithGuard(url, isPosterHost, options);
  if (!hop.ok) return hop;
  const buffer = await readCapped(hop.response, MAX_IMAGE_BYTES);
  if (!buffer) return { ok: false, error: "too_large" };
  return { ok: true, buffer };
}
