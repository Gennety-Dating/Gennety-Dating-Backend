import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config.js";
import { CRON_TIMEZONE } from "./next-batch.js";

/**
 * Signed, self-contained links to the founder's mobile ad-spend form
 * (`GET /v1/founder/ad-spend/:token`).
 *
 * **Why a signed token and not a `FounderReport`-style database row.** The
 * weekly-matches report has to persist a snapshot anyway, so a row was free
 * there. This link carries nothing but a date range: a table would exist only
 * to hold what already fits in the URL, and would need its own migration,
 * expiry sweep and cleanup. An HMAC gives the same unguessability with no
 * schema change at all, and the link stays reproducible — regenerating one for
 * the same week yields the same URL rather than a second live credential.
 *
 * **What the token authorizes, and why it is keyed on `ADMIN_API_KEY`.** The
 * page writes `ad_spend` rows, which is otherwise an `ADMIN_API_KEY`-gated
 * operation. Deriving the signing key from that same secret makes the link an
 * explicit, narrowed delegation of it — one week, one purpose, with an expiry —
 * rather than a second independent way in. Rotating `ADMIN_API_KEY` therefore
 * invalidates every outstanding link, which is the behaviour you want from a
 * key rotation. With no `ADMIN_API_KEY` set there is no signing key and no link
 * is minted; the reminder falls back to naming the dashboard.
 */

/** Domain separator — an HMAC over `ADMIN_API_KEY` must not be reusable elsewhere. */
const LINK_PURPOSE = "founder-ad-spend-link.v1";

/**
 * How long a minted link stays valid.
 *
 * Shorter than the weekly report's 90 days on purpose: that link only *reads*
 * a snapshot, this one *writes* to `ad_spend`, and it sits in reverse-proxy
 * logs and phone browser history the same way. 30 days still covers a founder
 * who logs a month's spend in one sitting, while bounding how long a leaked
 * log line is worth anything. A stale link is not a dead end either — the next
 * Monday's reminder always carries a fresh one.
 */
export const AD_SPEND_LINK_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AdSpendLinkPayload {
  /** `YYYY-MM-DD`, the Monday the reported week starts on (UTC). */
  weekStart: string;
  /** `YYYY-MM-DD`, the Sunday it ends on (UTC). */
  weekEnd: string;
  /** Unix seconds. */
  exp: number;
}

const ISO_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** `<payload>.<signature>`, both base64url. */
export const AD_SPEND_TOKEN_RE = /^[A-Za-z0-9_-]{8,256}\.[A-Za-z0-9_-]{20,64}$/;

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(input: string): Buffer {
  return Buffer.from(input.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function signingKey(): string | null {
  return env.ADMIN_API_KEY || null;
}

function sign(body: string, key: string): string {
  return b64url(createHmac("sha256", key).update(`${LINK_PURPOSE}:${body}`).digest());
}

/**
 * Mint a token for one week. Returns `null` when no signing key is configured,
 * which every caller must treat as "no link this time" rather than as an error.
 */
export function signAdSpendLink(
  payload: Omit<AdSpendLinkPayload, "exp">,
  now: Date = new Date(),
): string | null {
  const key = signingKey();
  if (!key) return null;
  const full: AdSpendLinkPayload = {
    ...payload,
    exp: Math.floor((now.getTime() + AD_SPEND_LINK_TTL_MS) / 1000),
  };
  const body = b64url(JSON.stringify(full));
  return `${body}.${sign(body, key)}`;
}

/**
 * Verify a token and return its payload, or `null` for anything that is not a
 * live, correctly-signed link. Signature comparison is timing-safe for the
 * same reason the admin Bearer gate's is.
 */
export function verifyAdSpendLink(
  token: string,
  now: Date = new Date(),
): AdSpendLinkPayload | null {
  const key = signingKey();
  if (!key) return null;
  if (!AD_SPEND_TOKEN_RE.test(token)) return null;

  const dot = token.indexOf(".");
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body, key);

  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromB64url(body).toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const { weekStart, weekEnd, exp } = parsed as Record<string, unknown>;
  if (typeof weekStart !== "string" || !ISO_DAY_RE.test(weekStart)) return null;
  if (typeof weekEnd !== "string" || !ISO_DAY_RE.test(weekEnd)) return null;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return null;
  if (exp * 1000 <= now.getTime()) return null;

  return { weekStart, weekEnd, exp };
}

/**
 * The Monday–Sunday week that had fully closed by `now`, as the founder's own
 * calendar sees it.
 *
 * Two separate things had to be got right here, and the version this replaces
 * got both wrong by accident rather than by choice:
 *
 * 1. **Weekday, not subtraction.** The reminder used to be handed
 *    `Date.now() - 7d`. That lands on a Monday only because the cron fires at
 *    09:00 Kyiv; move the schedule to 02:00 and the same subtraction lands on
 *    the previous Sunday, and the message starts naming Sun–Sat windows that
 *    match no dashboard entry. Reading the weekday makes it hour-independent.
 *
 * 2. **The cron's timezone, not UTC.** The schedule is Kyiv-timed, so "the week
 *    that just closed" is a Kyiv week. At Monday 02:00 Kyiv it is still Sunday
 *    in UTC, and a UTC-anchored answer would name the week before last.
 *
 * The bounds themselves are returned as UTC midnights, because that is what
 * `ad_spend.period_start` / `period_end` hold — an entry made from the
 * dashboard and one made from the phone must land on the same
 * `@@unique([channel, category, periodStart, periodEnd])` key.
 */
export function previousWeek(
  now: Date = new Date(),
  timeZone: string = CRON_TIMEZONE,
): { start: Date; end: Date } {
  // `en-CA` formats as `YYYY-MM-DD`, so this is the calendar day in `timeZone`
  // re-expressed as a UTC midnight.
  const zonedDay = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  const today = new Date(`${zonedDay}T00:00:00.000Z`);
  // 0 = Sunday → 6 days back to Monday; otherwise `day - 1`.
  const day = today.getUTCDay();
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(today.getTime() - daysSinceMonday * 86_400_000);
  const start = new Date(thisMonday.getTime() - 7 * 86_400_000);
  const end = new Date(start.getTime() + 6 * 86_400_000);
  return { start, end };
}

/** `YYYY-MM-DD` for a UTC-midnight date. */
export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Parse a `YYYY-MM-DD` day into UTC midnight — the same instant
 * `new Date("2026-08-31")` yields, so a row entered from the phone shares the
 * `@@unique([channel, category, periodStart, periodEnd])` key with one entered
 * from the dashboard instead of silently becoming a duplicate. */
export function parseIsoDay(value: string): Date | null {
  if (!ISO_DAY_RE.test(value)) return null;
  const d = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}
