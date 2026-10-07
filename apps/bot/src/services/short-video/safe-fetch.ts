import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { WISHLIST_IMAGE_MAX_BYTES } from "@gennety/shared";
import { isPosterHost, isShortVideoHost } from "./links.js";

/**
 * The only module in this codebase that opens a URL a user typed — and every
 * caller that does so must come through here.
 *
 * Everything else the bot fetches is an address we wrote ourselves (OpenAI,
 * Telegram, the weather API), so none of it ever needed an SSRF perimeter.
 * Two features do:
 *
 *  - **Short-video links** (`fetchPlatformPage`, `resolveRedirect`,
 *    `fetchPosterImage`): a share link is attacker-controlled by construction,
 *    and the poster URL is worse — it is read out of a page body, which is a
 *    value a third party writes. These are confined to an allowlist of
 *    TikTok / Instagram hosts and their CDNs.
 *  - **Date Wishlist** (`fetchPublicPage`, `fetchPublicImage`): a pasted shop
 *    link, a product URL the search model returned, an `og:image` read out of
 *    that page. Shops are any host on the internet, so there is NO allowlist
 *    here — only a host-shape check (a dotted DNS name: no IP literal, no
 *    `localhost`, no internal-only suffix, default port only).
 *
 * The walls, outermost first:
 *
 *  1. **Host check**, re-run at EVERY redirect hop: the allowlist for the
 *     short-video callers, the host-shape check for the wishlist ones. A
 *     redirect to `169.254.169.254` fails here, not later. URLs carrying
 *     credentials (`user:pass@`) are refused for every caller.
 *  2. **Address check** before each hop: every address the hostname resolves
 *     to must be public unicast. Loopback, RFC1918, link-local (incl. the
 *     cloud metadata address), CGNAT, multicast and the documentation ranges
 *     are all refused, on both IPv4 and IPv6.
 *  3. **HTTPS only** (plain `http:` is upgraded, never spoken), so a
 *     downgrade cannot be used to reach something the TLS name would have
 *     prevented.
 *  4. **Byte cap while streaming**, so a hostile or broken endpoint cannot
 *     make us buffer an unbounded body. The image reader also demands an
 *     image content-type AND matching magic bytes.
 *
 * On the DNS check being advisory: we resolve, verify, then let `fetch`
 * resolve again, so a record that changes in between is not caught (classic
 * rebinding). Pinning would mean connecting by IP with a custom dispatcher and
 * hand-managed SNI.
 *
 *  - For the short-video callers wall 1 narrows the input to hostnames under
 *    tiktok.com / instagram.com and their CDNs, so rebinding requires control
 *    of those zones — at which point the attacker has better options than our
 *    bot.
 *  - For the wishlist callers that argument does NOT hold: anyone can point a
 *    domain they own at us with a zero TTL and answer a public address to our
 *    check and an internal one to `fetch`. What still stands is wall 3: the
 *    connection is TLS to the default port, and certificate verification is
 *    against the attacker's hostname, which no internal service can present a
 *    valid certificate for — the handshake fails before a request is sent.
 *    The cloud metadata endpoint speaks plain HTTP on port 80 and is not
 *    reachable at all on this path. The residual is a timing/error oracle on
 *    whether something internal listens on 443, which we accept.
 *
 * The check stays for both because it is what catches a *legitimately*
 * resolving name that points somewhere internal.
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
 * `allow` decides which host check applies, so a page fetch can never be
 * redirected into fetching from a CDN host and vice versa. It sees the whole
 * (already https-upgraded) URL so the open-host check can also refuse a
 * non-default port.
 */
async function requestWithGuard(
  startUrl: string,
  allow: (url: URL) => boolean,
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
    // Nothing we fetch is ever authenticated (module note), so a URL that
    // carries userinfo is either a mistake or an attempt to smuggle a host.
    if (url.username || url.password) return { ok: false, error: "blocked" };
    if (!allow(url)) return { ok: false, error: "blocked" };
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
  const hop = await requestWithGuard(url, shortVideoUrl, options);
  if (!hop.ok) return hop;
  const buffer = await readCapped(hop.response, MAX_PAGE_BYTES);
  if (!buffer) return { ok: false, error: "too_large" };
  return { ok: true, body: buffer.toString("utf8"), finalUrl: hop.finalUrl };
}

function shortVideoUrl(url: URL): boolean {
  return isShortVideoHost(url.hostname);
}

function posterUrl(url: URL): boolean {
  return isPosterHost(url.hostname);
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
  const hop = await requestWithGuard(url, shortVideoUrl, options);
  if (!hop.ok) return hop;
  await hop.response.body?.cancel().catch(() => {});
  return { ok: true, finalUrl: hop.finalUrl };
}

/** Fetch a poster image from an allowlisted CDN host. */
export async function fetchPosterImage(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<{ buffer: Buffer }>> {
  const hop = await requestWithGuard(url, posterUrl, options);
  if (!hop.ok) return hop;
  const buffer = await readCapped(hop.response, MAX_IMAGE_BYTES);
  if (!buffer) return { ok: false, error: "too_large" };
  return { ok: true, buffer };
}

/* ── open-host fetches (Date Wishlist) ──────────────────────────────────── */

/**
 * Suffixes that only ever name something on a private network (or nothing at
 * all). A public DNS name never ends in one of these, so refusing them costs
 * nothing and closes the "my router answers for `printer.lan`" class of
 * request before DNS is even asked.
 */
const INTERNAL_HOST_SUFFIXES = [
  "localhost",
  "localdomain",
  "local",
  "lan",
  "home",
  "internal",
  "intranet",
  "corp",
  "private",
  "home.arpa",
  "arpa",
  "test",
  "invalid",
  "example",
  "onion",
] as const;

/**
 * Is this hostname something a public web page may be served from?
 *
 * A dotted DNS name with an alphabetic TLD — never an IP literal (v4 or v6,
 * in any of the shorthand forms the URL parser normalises into a dotted quad),
 * never a single-label name (`localhost`, `intranet`, a container name), never
 * an internal-only suffix. Exported for its own tests, like `isPublicAddress`.
 */
export function isPublicWebHostname(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/u, "");
  if (!host || host.length > 253) return false;
  if (host.startsWith("[") || host.includes(":")) return false; // IPv6 literal
  if (isIP(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => /^[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/u.test(label))) {
    return false; // includes the empty label of `a..b`
  }
  const tld = labels[labels.length - 1]!;
  // A real TLD is alphabetic (or an `xn--` IDN). An all-numeric last label is
  // an IPv4 shorthand that slipped past the parser, never a domain.
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/u.test(tld)) return false;
  return !INTERNAL_HOST_SUFFIXES.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

/** The open-host check: a public hostname on the default HTTPS port. */
function publicWebUrl(url: URL): boolean {
  if (url.port !== "" && url.port !== "443") return false;
  return isPublicWebHostname(url.hostname);
}

/** Content types a page read accepts; anything else is not a page. */
function isPageContentType(raw: string | null): boolean {
  if (!raw) return true; // a missing header is common on small shops
  const base = raw.split(";", 1)[0]!.trim().toLowerCase();
  return (
    base.startsWith("text/") ||
    base === "application/xhtml+xml" ||
    base === "application/json" ||
    base === "application/ld+json"
  );
}

/**
 * Fetch an HTML page from ANY public HTTPS host — a shop's product page.
 *
 * No allowlist (see the module note for why that is acceptable here and what
 * still guards it); every other wall applies at every hop. A response that is
 * not a page (an image, a PDF, a download) is refused as `blocked` before its
 * body is read.
 */
export async function fetchPublicPage(
  url: string,
  options: SafeFetchOptions = {},
): Promise<SafeFetchResult<{ body: string; finalUrl: string }>> {
  const hop = await requestWithGuard(url, publicWebUrl, {
    ...options,
    headers: {
      Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5",
      ...options.headers,
    },
  });
  if (!hop.ok) return hop;
  if (!isPageContentType(hop.response.headers.get("content-type"))) {
    await hop.response.body?.cancel().catch(() => {});
    return { ok: false, error: "blocked" };
  }
  const buffer = await readCapped(hop.response, MAX_PAGE_BYTES);
  if (!buffer) return { ok: false, error: "too_large" };
  return { ok: true, body: buffer.toString("utf8"), finalUrl: hop.finalUrl };
}

/** The only image formats we copy into our storage. GIF/SVG/AVIF are refused. */
const PUBLIC_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function publicImageType(raw: string | null): string | null {
  if (!raw) return null;
  const base = raw.split(";", 1)[0]!.trim().toLowerCase();
  const normalised = base === "image/jpg" || base === "image/pjpeg" ? "image/jpeg" : base;
  return PUBLIC_IMAGE_TYPES.has(normalised) ? normalised : null;
}

/** The body must BE what the header claims — a header is a third party's word. */
function magicMatches(buffer: Buffer, contentType: string): boolean {
  if (contentType === "image/jpeg") {
    return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  }
  if (contentType === "image/png") {
    return (
      buffer.length > 8 &&
      buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    );
  }
  if (contentType === "image/webp") {
    return (
      buffer.length > 12 &&
      buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
      buffer.subarray(8, 12).toString("latin1") === "WEBP"
    );
  }
  return false;
}

/**
 * Fetch a product photo from ANY public HTTPS host, for copying into our own
 * storage. Same perimeter as `fetchPublicPage`; additionally the response must
 * declare JPEG, PNG or WebP and its first bytes must agree, and the body is
 * capped at `WISHLIST_IMAGE_MAX_BYTES` (or a smaller `maxBytes`).
 */
export async function fetchPublicImage(
  url: string,
  options: SafeFetchOptions & { maxBytes?: number } = {},
): Promise<SafeFetchResult<{ buffer: Buffer; contentType: string | null }>> {
  const { maxBytes: requestedMax, ...rest } = options;
  const maxBytes = Math.min(requestedMax ?? WISHLIST_IMAGE_MAX_BYTES, WISHLIST_IMAGE_MAX_BYTES);
  const hop = await requestWithGuard(url, publicWebUrl, {
    ...rest,
    headers: {
      // Image CDNs negotiate on Accept; without this many answer AVIF, which
      // we neither sniff nor store.
      Accept: "image/webp,image/jpeg,image/png;q=0.9",
      ...rest.headers,
    },
  });
  if (!hop.ok) return hop;
  const contentType = publicImageType(hop.response.headers.get("content-type"));
  if (!contentType) {
    await hop.response.body?.cancel().catch(() => {});
    return { ok: false, error: "blocked" };
  }
  const buffer = await readCapped(hop.response, maxBytes);
  if (!buffer) return { ok: false, error: "too_large" };
  if (!magicMatches(buffer, contentType)) return { ok: false, error: "blocked" };
  return { ok: true, buffer, contentType };
}
