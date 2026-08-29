import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";

/**
 * Signed entry codes for launch-event tickets
 * (LAUNCH_EVENTS_PRODUCT_SPEC.md §7).
 *
 * Pure: no database, no clock of its own (the caller passes `now`), no Express.
 * Everything that touches a ticket row lives in `event-ticket.ts`.
 *
 * ── What the signature does and does NOT do ─────────────────────────────
 *
 * It proves the code came from us and has not been edited, and it expires.
 * It does **not** make the code single-use — nothing stateless can. Single-use
 * is a compare-and-set on `checkedInAt IS NULL` at the door, so two phones
 * showing the same screenshot produce one admission and one refusal. The TTL
 * exists for a different reason: a code forwarded to a friend outside the
 * venue is dead within minutes rather than being a transferable ticket.
 *
 * ── Why not just show the ticket id ─────────────────────────────────────
 *
 * A ticket id is a UUID that never changes, so a photographed screen is a
 * permanent pass, and anyone who ever saw one could probe the scanner with it.
 * The nonce is rotatable ("my code leaked") without reissuing the ticket, and
 * the payload carries the event so a valid code from LAST month's party is
 * refused by shape rather than by lookup.
 */

/** Bumped only if the payload's field set changes; a scanner rejects unknown. */
export const EVENT_QR_VERSION = 1;

export const EVENT_QR_SECRET_MIN_BYTES = 32;

/**
 * Signing with a blank or trivial secret is worse than not signing at all: it
 * looks like security and validates every forgery, so the routes refuse to
 * mint or verify rather than proceed. Same bar and same reasoning as
 * `isStrongJwtSecret`.
 */
export function isStrongEventQrSecret(secret: string): boolean {
  return Buffer.byteLength(secret, "utf8") >= EVENT_QR_SECRET_MIN_BYTES;
}

export interface EventQrPayload {
  v: number;
  /** Ticket id. */
  t: string;
  /** Event id — a code from another event is refused before any DB call. */
  e: string;
  /** The ticket's current rotating nonce. */
  n: string;
  /** Unix seconds. */
  exp: number;
}

export type EventQrVerdict =
  | { ok: true; payload: EventQrPayload }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" | "wrong_version" };

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

/** A fresh rotating nonce. 16 bytes: this is a lookup secret, not a key. */
export function newQrNonce(): string {
  return randomBytes(16).toString("base64url");
}

export function signEventQr(payload: EventQrPayload, secret: string): string {
  const body = b64url(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = b64url(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

/**
 * Verify a scanned code.
 *
 * Order matters and is deliberate: signature BEFORE expiry, so an attacker
 * cannot learn anything from the difference between "forged" and "expired" —
 * and so an expired-but-genuine code can be reported to staff as
 * "ask them to refresh" rather than as a forgery, which is a very different
 * thing to say to someone standing at a door.
 */
export function verifyEventQr(raw: string, secret: string, nowSeconds: number): EventQrVerdict {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0 || dot === raw.length - 1) return { ok: false, reason: "malformed" };

  const body = raw.slice(0, dot);
  const provided = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = createHmac("sha256", secret).update(body).digest();
  // Length-check first: timingSafeEqual THROWS on a length mismatch, and an
  // uncaught throw here would turn a malformed scan into a 500 at the door.
  if (provided.length !== expected.length) return { ok: false, reason: "bad_signature" };
  if (!timingSafeEqual(provided, expected)) return { ok: false, reason: "bad_signature" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!parsed || typeof parsed !== "object") return { ok: false, reason: "malformed" };

  const p = parsed as Record<string, unknown>;
  if (
    typeof p.t !== "string" ||
    typeof p.e !== "string" ||
    typeof p.n !== "string" ||
    typeof p.exp !== "number" ||
    typeof p.v !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (p.v !== EVENT_QR_VERSION) return { ok: false, reason: "wrong_version" };
  if (p.exp <= nowSeconds) return { ok: false, reason: "expired" };

  return { ok: true, payload: { v: p.v, t: p.t, e: p.e, n: p.n, exp: p.exp } };
}
