/**
 * Venue change v2 — paid multiplayer venue board (PRODUCT_SPEC §3.7b).
 *
 * Both participants of a `scheduled` match share one likes board: a catalog of
 * alternatives within 3 km of the assigned venue where each side hearts the
 * places they'd prefer. Agreement is reached exactly like the calendar —
 * tapping a venue the partner already liked, or a single like-overlap,
 * auto-agrees; multiple simultaneous overlaps ask the actor to pick one. A
 * settled change costs `VENUE_CHANGE_STARS` (Telegram Stars); the payer matrix:
 *   • hetero pair — the MAN pays, whoever initiated. If she initiated, he gets
 *     a pay/decline fork; his "not this time" is single and final. She can
 *     always pay in parallel (first successful payment wins the settle CAS),
 *     and may send him a one-time "wish card" asking him to cover it.
 *   • same-sex pair — the session initiator (first like) pays.
 *   • express — the female's unilateral instant swap (no agreement): she mints
 *     an invoice for any catalog venue; the partner learns only from the
 *     updated card after payment. An abandoned express mint quietly reverts.
 * Decline/lapse NEVER cancels the match — the original venue simply stands.
 *
 * Like the Date Ticket and Coordination features, this is a string sub-state
 * (`Match.venueChangeStatus`: null → liking → agreed → settled | lapsed)
 * layered on `status = scheduled`. Inert when VENUE_CHANGE_FEATURE_ENABLED is
 * off. No free text anywhere — the board carries no comment channel, so the
 * NO-IN-APP-CHAT invariant needs no carve-out here.
 */

import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import type { Prisma } from "@gennety/db";
import {
  t,
  type Language,
  buildVenueInvoicePayload,
  type VenueInvoiceMode,
} from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { isTelegramTarget, toTelegramChatId } from "../../utils/telegram-target.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import {
  evaluateVenueBoardEligibility,
  venueChangeDeadline,
  venueChangeCutoff,
  buildVenueChangeCatalog,
  type CatalogVenue,
  type VenueChangeIneligibleReason,
} from "../../services/venue-change.js";

/** How long an abandoned express mint holds the board before quietly reverting. */
const EXPRESS_HOLD_MINUTES = 30;

// ---------------------------------------------------------------------------
// Match loading
// ---------------------------------------------------------------------------

const VC_SELECT = {
  id: true,
  status: true,
  agreedTime: true,
  venueName: true,
  venueAddress: true,
  venueLat: true,
  venueLng: true,
  venueGoogleMapsUri: true,
  venueChangeStatus: true,
  venueChangeProposerId: true,
  venueChangeProposedAt: true,
  venueChangeExpiresAt: true,
  venueChangeResolvedAt: true,
  venueChangeName: true,
  venueChangeAddress: true,
  venueChangeLat: true,
  venueChangeLng: true,
  venueChangeMapsUri: true,
  venueChangePlaceId: true,
  venueChangePhotoUrl: true,
  venueChangePhotoName: true,
  venueChangePaidById: true,
  venueChangePaidAt: true,
  venueChangePayDeclinedAt: true,
  venueChangeOfferPaySentAt: true,
  venueChangePingSentToAAt: true,
  venueChangePingSentToBAt: true,
  venueChangeExpressAt: true,
  venueLikesA: true,
  venueLikesB: true,
  userAId: true,
  userBId: true,
  userA: {
    select: {
      id: true,
      telegramId: true,
      language: true,
      gender: true,
      firstName: true,
      universityDomain: true,
    },
  },
  userB: {
    select: { id: true, telegramId: true, language: true, gender: true, firstName: true },
  },
} as const;

type VcMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

function loadMatch(matchId: string) {
  return prisma.match.findUnique({ where: { id: matchId }, select: VC_SELECT });
}

function langOf(lang: string | null): Language {
  return (lang ?? "en") as Language;
}

type Side = "A" | "B";

function sideOfUser(match: VcMatch, telegramId: bigint): Side | null {
  if (match.userA.telegramId === telegramId) return "A";
  if (match.userB.telegramId === telegramId) return "B";
  return null;
}

function userOfSide(match: VcMatch, side: Side) {
  return side === "A" ? match.userA : match.userB;
}

function otherSide(side: Side): Side {
  return side === "A" ? "B" : "A";
}

/** Exactly one male + one female → the hetero payer matrix applies. */
function isHeteroPair(match: VcMatch): boolean {
  const genders = [match.userA.gender, match.userB.gender];
  return genders.includes("male") && genders.includes("female");
}

/**
 * Who pays for a settled change. Hetero → the male, whoever initiated;
 * same-sex/unknown → the session initiator (first like / express minter).
 */
function payerSide(match: VcMatch): Side | null {
  if (isHeteroPair(match)) return match.userA.gender === "male" ? "A" : "B";
  if (match.venueChangeProposerId === match.userA.id) return "A";
  if (match.venueChangeProposerId === match.userB.id) return "B";
  return null;
}

/** Whether this caller may use the express unilateral swap. */
function expressAllowed(match: VcMatch, side: Side): boolean {
  if (isHeteroPair(match)) return userOfSide(match, side).gender === "female";
  return true; // same-sex/unknown: either side (the veto asymmetry is hetero-only)
}

// ---------------------------------------------------------------------------
// Like snapshots (Json[] on the match row)
// ---------------------------------------------------------------------------

/** Server-resolved venue snapshot stored per like and for the agreed venue. */
export interface VenueLikeSnapshot {
  key: string;
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string | null;
  category: string;
  photoUrl: string | null;
  photoRef: string | null;
}

export function venueKeyOf(v: {
  placeId: string | null;
  name: string;
  address: string;
}): string {
  return v.placeId ?? `${v.name}|${v.address}`;
}

function toSnapshot(v: CatalogVenue): VenueLikeSnapshot {
  return {
    key: venueKeyOf(v),
    placeId: v.placeId,
    name: v.name,
    address: v.address,
    lat: v.lat,
    lng: v.lng,
    mapsUri: v.mapsUri,
    category: v.category,
    photoUrl: v.photoUrl,
    photoRef: v.photoRefs[0] ?? null,
  };
}

function parseLikes(raw: Prisma.JsonValue[]): VenueLikeSnapshot[] {
  const out: VenueLikeSnapshot[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = item as Record<string, unknown>;
    if (typeof o.key !== "string" || typeof o.name !== "string") continue;
    out.push({
      key: o.key,
      placeId: typeof o.placeId === "string" ? o.placeId : null,
      name: o.name,
      address: typeof o.address === "string" ? o.address : "",
      lat: typeof o.lat === "number" ? o.lat : 0,
      lng: typeof o.lng === "number" ? o.lng : 0,
      mapsUri: typeof o.mapsUri === "string" ? o.mapsUri : null,
      category: typeof o.category === "string" ? o.category : "cafe",
      photoUrl: typeof o.photoUrl === "string" ? o.photoUrl : null,
      photoRef: typeof o.photoRef === "string" ? o.photoRef : null,
    });
  }
  return out;
}

function likesOfSide(match: VcMatch, side: Side): VenueLikeSnapshot[] {
  return parseLikes(side === "A" ? match.venueLikesA : match.venueLikesB);
}

// ---------------------------------------------------------------------------
// Scheduled-card decoration (called from tryFinalize)
// ---------------------------------------------------------------------------

/** v2: the board is offered to BOTH sides whenever the feature is on. */
export function shouldOfferVenueChange(): boolean {
  return env.VENUE_CHANGE_FEATURE_ENABLED;
}

function venueChangeUrl(matchId: string, lang: Language): string {
  return `${env.WEBAPP_URL}/venue-change.html?match=${matchId}&lang=${lang}`;
}

/** The `web_app` button appended to each side's scheduled-date card. */
export function buildVenueChangeButton(
  matchId: string,
  lang: Language,
): InlineKeyboardButton.WebAppButton {
  return { text: t(lang, "venueChangeButton"), web_app: { url: venueChangeUrl(matchId, lang) } };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function venueMapsUrl(name: string, address: string, mapsUri: string | null): string {
  if (mapsUri && /^https?:\/\//i.test(mapsUri)) return mapsUri;
  const query = [name, address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

function venueLabel(name: string, address: string): string {
  return address ? `${name} — ${address}` : name;
}

/**
 * Mint a Telegram Stars invoice link for this match's venue change. One flat
 * price for every path; the payload mode is informative (settle re-derives
 * express-ness from the row), but pre-checkout validates the amount.
 */
export async function createVenueInvoiceLink(
  api: Api<RawApi>,
  lang: Language,
  matchId: string,
  mode: VenueInvoiceMode,
  venueName: string,
): Promise<string> {
  return api.createInvoiceLink(
    t(lang, "venueInvoiceTitle"),
    t(lang, "venueInvoiceDesc", { venue: venueName }),
    buildVenueInvoicePayload(matchId, mode),
    "", // provider_token — empty for Telegram Stars (XTR)
    "XTR",
    [{ label: t(lang, "venueInvoiceLabel"), amount: env.VENUE_CHANGE_STARS }],
  );
}

// ---------------------------------------------------------------------------
// Board state (GET /v1/venue-change/state)
// ---------------------------------------------------------------------------

/** What the caller may do about payment right now (drives the Mini App UI). */
export type VenuePayAction =
  | "pay" // caller is the payer; no decline option (they initiated / same-sex initiator)
  | "pay_or_decline" // hetero male payer when SHE initiated — his fork
  | "pay_or_offer" // hetero female initiator — pay self / offer him
  | "wait" // agreed, caller has no payment role (and sees no price)
  | null;

export interface VenueBoardStateView {
  status: string; // none | liking | agreed | settled | lapsed
  open: boolean; // board interactions (likes/confirm/express) allowed
  closedReason: VenueChangeIneligibleReason | null;
  original: { name: string | null; address: string | null; mapsUri: string | null };
  myLikes: string[];
  peerLikes: string[];
  /** Agreed venue — null while none, and hidden from the partner during an express mint. */
  agreed: {
    key: string;
    name: string;
    address: string;
    mapsUri: string | null;
    expiresAt: string | null;
  } | null;
  myAction: VenuePayAction;
  /** Stars price — ONLY set when the caller has a paying action (incl. express). */
  priceStars: number | null;
  canOfferPartner: boolean;
  offerSent: boolean;
  payDeclined: boolean;
  expressAvailable: boolean;
  /** Set when status = settled: the new canonical venue + whether the peer paid. */
  settled: { name: string; address: string; mapsUri: string | null; peerPaid: boolean } | null;
}

export type VenueBoardStateResult =
  | { ok: false; reason: "match-not-found" | "not-participant" }
  | { ok: true; state: VenueBoardStateView };

export async function getVenueBoardState(
  telegramId: bigint,
  matchId: string,
  now: Date = new Date(),
): Promise<VenueBoardStateResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  return { ok: true, state: buildBoardState(match, side, now) };
}

function buildBoardState(match: VcMatch, side: Side, now: Date): VenueBoardStateView {
  const me = userOfSide(match, side);
  const eligibility = evaluateVenueBoardEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: me.id,
    userAId: match.userAId,
    userBId: match.userBId,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeStatus: match.venueChangeStatus,
    now,
  });

  const status = match.venueChangeStatus ?? "none";
  const myLikes = likesOfSide(match, side).map((l) => l.key);
  const peerLikes = likesOfSide(match, otherSide(side)).map((l) => l.key);

  // Express-pending agreements are invisible to the partner (silent until paid).
  const expressPending = status === "agreed" && match.venueChangeExpressAt != null;
  const iAmExpressMinter = expressPending && match.venueChangeProposerId === me.id;
  const agreedVisible = status === "agreed" && (!expressPending || iAmExpressMinter);

  const payer = payerSide(match);
  const hetero = isHeteroPair(match);
  const initiatorIsFemale =
    hetero &&
    ((match.venueChangeProposerId === match.userA.id && match.userA.gender === "female") ||
      (match.venueChangeProposerId === match.userB.id && match.userB.gender === "female"));

  let myAction: VenuePayAction = null;
  let canOfferPartner = false;
  if (agreedVisible) {
    if (iAmExpressMinter) {
      myAction = "pay"; // finish (or abandon — it quietly reverts)
    } else if (payer === side) {
      myAction = hetero && initiatorIsFemale ? "pay_or_decline" : "pay";
      if (match.venueChangePayDeclinedAt) myAction = null; // he already declined
    } else if (hetero && me.gender === "female" && initiatorIsFemale) {
      myAction = "pay_or_offer";
      canOfferPartner =
        !match.venueChangeOfferPaySentAt && !match.venueChangePayDeclinedAt;
    } else {
      myAction = "wait";
    }
  }

  const expressAvailable =
    eligibility.ok && (status === "none" || status === "liking") && expressAllowed(match, side);

  const paying = myAction === "pay" || myAction === "pay_or_decline" || myAction === "pay_or_offer";

  return {
    status,
    open: eligibility.ok && (status === "none" || status === "liking"),
    closedReason: eligibility.ok ? null : eligibility.reason,
    original: {
      name: match.venueName,
      address: match.venueAddress,
      mapsUri: match.venueGoogleMapsUri,
    },
    myLikes,
    peerLikes,
    agreed: agreedVisible
      ? {
          key: venueKeyOf({
            placeId: match.venueChangePlaceId,
            name: match.venueChangeName ?? "",
            address: match.venueChangeAddress ?? "",
          }),
          name: match.venueChangeName ?? "",
          address: match.venueChangeAddress ?? "",
          mapsUri: match.venueChangeMapsUri,
          expiresAt: match.venueChangeExpiresAt?.toISOString() ?? null,
        }
      : null,
    myAction,
    priceStars: paying || expressAvailable ? env.VENUE_CHANGE_STARS : null,
    canOfferPartner,
    offerSent: match.venueChangeOfferPaySentAt != null,
    payDeclined: match.venueChangePayDeclinedAt != null,
    expressAvailable,
    settled:
      status === "settled"
        ? {
            name: match.venueName ?? "",
            address: match.venueAddress ?? "",
            mapsUri: match.venueGoogleMapsUri,
            peerPaid: match.venueChangePaidById != null && match.venueChangePaidById !== me.id,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Catalog (GET /v1/venue-change/catalog)
// ---------------------------------------------------------------------------

export type VenueChangeCatalogResult =
  | { ok: false; reason: "match-not-found" | "not-participant" | VenueChangeIneligibleReason }
  | { ok: true; venues: CatalogVenue[] };

/** Catalog loader signature — injectable so tests need no DB / Places network. */
type LoadVenueChangeCatalog = (args: {
  universityDomain: string | null;
  center: { lat: number; lng: number };
  agreedTime: Date;
}) => Promise<CatalogVenue[]>;

export async function getVenueChangeCatalog(
  telegramId: bigint,
  matchId: string,
  now: Date = new Date(),
  loadCatalog: LoadVenueChangeCatalog = buildVenueChangeCatalog,
): Promise<VenueChangeCatalogResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };

  const eligibility = evaluateVenueBoardEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: userOfSide(match, side).id,
    userAId: match.userAId,
    userBId: match.userBId,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeStatus: match.venueChangeStatus,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
  if (match.venueLat == null || match.venueLng == null || !match.agreedTime) {
    return { ok: false, reason: "no-venue" };
  }

  const venues = await loadCatalog({
    universityDomain: match.userA.universityDomain,
    center: { lat: match.venueLat, lng: match.venueLng },
    agreedTime: match.agreedTime,
  });
  return { ok: true, venues };
}

// ---------------------------------------------------------------------------
// Likes (POST /v1/venue-change/like) — full-set submission, calendar-style
// ---------------------------------------------------------------------------

export interface SubmitLikesOptions {
  now?: Date;
  loadCatalog?: LoadVenueChangeCatalog;
}

export type SubmitLikesResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | VenueChangeIneligibleReason
        | "invalid-venue";
    }
  | { ok: true; agreed: boolean; overlapCandidates: string[] };

/**
 * Replace the caller's like set (calendar `pick` semantics). Every key is
 * re-resolved against the server-built catalog — the client's own venue data is
 * never trusted. A single overlap with the peer auto-agrees; multiple overlaps
 * are returned for the actor to confirm one.
 */
export async function submitVenueLikes(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  keys: string[],
  options: SubmitLikesOptions = {},
): Promise<SubmitLikesResult> {
  const now = options.now ?? new Date();
  const loadCatalog = options.loadCatalog ?? buildVenueChangeCatalog;

  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const me = userOfSide(match, side);

  const eligibility = evaluateVenueBoardEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: me.id,
    userAId: match.userAId,
    userBId: match.userBId,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeStatus: match.venueChangeStatus,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
  // Likes are only writable while the session is open (an `agreed` state —
  // incl. a hidden express mint — freezes the board until it settles/reverts).
  if (match.venueChangeStatus != null && match.venueChangeStatus !== "liking") {
    return { ok: false, reason: "wrong-state" };
  }
  if (match.venueLat == null || match.venueLng == null || !match.agreedTime) {
    return { ok: false, reason: "no-venue" };
  }

  // Resolve every submitted key against the server catalog.
  const catalog = await loadCatalog({
    universityDomain: match.userA.universityDomain,
    center: { lat: match.venueLat, lng: match.venueLng },
    agreedTime: match.agreedTime,
  });
  const byKey = new Map(catalog.map((v) => [venueKeyOf(v), v]));
  const snapshots: VenueLikeSnapshot[] = [];
  for (const key of [...new Set(keys)]) {
    const venue = byKey.get(key);
    if (!venue) return { ok: false, reason: "invalid-venue" };
    snapshots.push(toSnapshot(venue));
  }

  const hadLikes = likesOfSide(match, side).length > 0;
  const likesColumn = side === "A" ? "venueLikesA" : "venueLikesB";

  // Guarded write: only while the session is still open (a concurrent
  // agreement/express mint wins and this submission is rejected).
  const written = await prisma.match.updateMany({
    where: {
      id: matchId,
      status: "scheduled",
      OR: [{ venueChangeStatus: null }, { venueChangeStatus: "liking" }],
    },
    data: {
      [likesColumn]: snapshots as unknown as Prisma.InputJsonValue[],
      venueChangeStatus: snapshots.length > 0 ? "liking" : match.venueChangeStatus,
    },
  });
  if (written.count === 0) return { ok: false, reason: "wrong-state" };

  // Initiator claim — first like of the session wins (CAS on the null stamp).
  if (snapshots.length > 0) {
    await prisma.match.updateMany({
      where: { id: matchId, venueChangeProposedAt: null },
      data: { venueChangeProposerId: me.id, venueChangeProposedAt: now },
    });
  }

  // One-time board-invite ping to the partner on the caller's FIRST likes.
  if (!hadLikes && snapshots.length > 0) {
    await sendBoardPing(api, match, side).catch((err) => {
      console.warn("[venue-change] board ping failed:", err);
    });
  }

  // Overlap → agreement, exactly like the calendar.
  const peerKeys = new Set(likesOfSide(match, otherSide(side)).map((l) => l.key));
  const overlap = snapshots.filter((s) => peerKeys.has(s.key));
  if (overlap.length === 1) {
    const agreed = await reachAgreement(api, matchId, me.id, overlap[0], now);
    return { ok: true, agreed, overlapCandidates: [] };
  }
  return { ok: true, agreed: false, overlapCandidates: overlap.map((s) => s.key) };
}

/** First-like DM to the partner, framed positively and gendered by the liker. */
async function sendBoardPing(api: Api<RawApi>, match: VcMatch, likerSide: Side): Promise<void> {
  const liker = userOfSide(match, likerSide);
  const recipient = userOfSide(match, otherSide(likerSide));
  if (!isTelegramTarget(recipient.telegramId)) return;

  const guard = likerSide === "A" ? "venueChangePingSentToBAt" : "venueChangePingSentToAAt";
  const claim = await prisma.match.updateMany({
    where: { id: match.id, [guard]: null },
    data: { [guard]: new Date() },
  });
  if (claim.count === 0) return;

  const lang = langOf(recipient.language);
  const key = liker.gender === "female" ? "venueBoardPingFromF" : "venueBoardPingFromM";
  const kb = new InlineKeyboard().webApp(
    t(lang, "venueBoardPingBtn"),
    venueChangeUrl(match.id, lang),
  );
  await api.sendMessage(
    toTelegramChatId(recipient.telegramId),
    t(lang, key, { name: liker.firstName ?? "" }),
    { reply_markup: kb },
  );
}

// ---------------------------------------------------------------------------
// Agreement (single overlap / POST /v1/venue-change/confirm)
// ---------------------------------------------------------------------------

export type ConfirmVenueResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | VenueChangeIneligibleReason
        | "not-overlapping";
    }
  | { ok: true };

/** Resolve a multi-overlap: the actor picks one venue both sides liked. */
export async function confirmVenueAgreement(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  key: string,
  now: Date = new Date(),
): Promise<ConfirmVenueResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const me = userOfSide(match, side);

  const eligibility = evaluateVenueBoardEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: me.id,
    userAId: match.userAId,
    userBId: match.userBId,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeStatus: match.venueChangeStatus,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
  if (match.venueChangeStatus !== "liking") return { ok: false, reason: "wrong-state" };

  const mine = likesOfSide(match, side).find((l) => l.key === key);
  const theirs = likesOfSide(match, otherSide(side)).find((l) => l.key === key);
  if (!mine || !theirs) return { ok: false, reason: "not-overlapping" };

  await reachAgreement(api, matchId, me.id, mine, now);
  return { ok: true };
}

/**
 * Lock the agreed venue (CAS liking → agreed) and route the payment per the
 * matrix. Returns false when a concurrent agreement/settle won the race.
 */
async function reachAgreement(
  api: Api<RawApi>,
  matchId: string,
  finalizerUserId: string,
  venue: VenueLikeSnapshot,
  now: Date,
): Promise<boolean> {
  const fresh = await loadMatch(matchId);
  if (!fresh || !fresh.agreedTime) return false;
  const deadline = venueChangeDeadline(now, fresh.agreedTime);

  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", venueChangeStatus: "liking" },
    data: {
      venueChangeStatus: "agreed",
      venueChangeName: venue.name.slice(0, 256),
      venueChangeAddress: venue.address.slice(0, 256),
      venueChangeLat: venue.lat,
      venueChangeLng: venue.lng,
      venueChangeMapsUri: venue.mapsUri,
      venueChangePlaceId: venue.placeId,
      venueChangePhotoUrl: venue.photoUrl,
      venueChangePhotoName: venue.photoRef,
      venueChangeExpiresAt: deadline,
      venueChangeExpressAt: null,
    },
  });
  if (claim.count === 0) return false;

  console.info(`[venue-change] agreement match=${matchId} venue="${venue.name}"`);

  // Payment routing: DM the payer an invoice ONLY when they weren't the
  // finalizer AND no in-app fork covers them —
  //   • hetero, initiator = male, finalizer = female → DM him (he pays, no fork);
  //   • same-sex, finalizer ≠ initiator → DM the initiator;
  //   • hetero, initiator = female → NO DM: he either finalized (his in-app
  //     fork) or she did (her pay/offer fork decides what he sees).
  const payer = payerSide(fresh);
  if (!payer) return true;
  const payerUser = userOfSide(fresh, payer);
  const initiatorId = fresh.venueChangeProposerId;
  const payerInitiated = initiatorId === payerUser.id;
  if (payerUser.id !== finalizerUserId && payerInitiated && isTelegramTarget(payerUser.telegramId)) {
    const lang = langOf(payerUser.language);
    try {
      const link = await createVenueInvoiceLink(api, lang, matchId, "agreed", venue.name);
      const kb = new InlineKeyboard().url(
        t(lang, "venuePayBtn", { stars: env.VENUE_CHANGE_STARS }),
        link,
      );
      await api.sendMessage(
        toTelegramChatId(payerUser.telegramId),
        t(lang, "venuePayPromptDm", { venue: venueLabel(venue.name, venue.address) }),
        { reply_markup: kb },
      );
    } catch (err) {
      console.warn("[venue-change] pay-prompt DM failed:", err);
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Express mint (her unilateral instant swap)
// ---------------------------------------------------------------------------

export type ExpressMintResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | VenueChangeIneligibleReason
        | "invalid-venue"
        | "not-allowed";
    }
  | { ok: true; venueName: string };

/**
 * Stamp an express pick onto the row (status → agreed + expressAt) so the
 * subsequent Stars payment can settle it. Hidden from the partner until paid;
 * an unpaid mint quietly reverts after EXPRESS_HOLD_MINUTES (see the sweep).
 */
export async function mintExpressChange(
  telegramId: bigint,
  matchId: string,
  key: string,
  options: SubmitLikesOptions = {},
): Promise<ExpressMintResult> {
  const now = options.now ?? new Date();
  const loadCatalog = options.loadCatalog ?? buildVenueChangeCatalog;

  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const me = userOfSide(match, side);

  const eligibility = evaluateVenueBoardEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: me.id,
    userAId: match.userAId,
    userBId: match.userBId,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeStatus: match.venueChangeStatus,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };
  if (!expressAllowed(match, side)) return { ok: false, reason: "not-allowed" };
  if (match.venueLat == null || match.venueLng == null || !match.agreedTime) {
    return { ok: false, reason: "no-venue" };
  }

  const catalog = await loadCatalog({
    universityDomain: match.userA.universityDomain,
    center: { lat: match.venueLat, lng: match.venueLng },
    agreedTime: match.agreedTime,
  });
  const venue = catalog.find((v) => venueKeyOf(v) === key);
  if (!venue) return { ok: false, reason: "invalid-venue" };
  const snapshot = toSnapshot(venue);

  const holdUntil = new Date(
    Math.min(
      now.getTime() + EXPRESS_HOLD_MINUTES * 60 * 1000,
      venueChangeCutoff(match.agreedTime).getTime(),
    ),
  );

  const claim = await prisma.match.updateMany({
    where: {
      id: matchId,
      status: "scheduled",
      OR: [{ venueChangeStatus: null }, { venueChangeStatus: "liking" }],
    },
    data: {
      venueChangeStatus: "agreed",
      venueChangeProposerId: me.id,
      venueChangeProposedAt: match.venueChangeProposedAt ?? now,
      venueChangeName: snapshot.name.slice(0, 256),
      venueChangeAddress: snapshot.address.slice(0, 256),
      venueChangeLat: snapshot.lat,
      venueChangeLng: snapshot.lng,
      venueChangeMapsUri: snapshot.mapsUri,
      venueChangePlaceId: snapshot.placeId,
      venueChangePhotoUrl: snapshot.photoUrl,
      venueChangePhotoName: snapshot.photoRef,
      venueChangeExpiresAt: holdUntil,
      venueChangeExpressAt: now,
    },
  });
  if (claim.count === 0) return { ok: false, reason: "wrong-state" };

  console.info(`[venue-change] express mint match=${matchId} venue="${snapshot.name}"`);
  return { ok: true, venueName: snapshot.name };
}

// ---------------------------------------------------------------------------
// Offer-partner-pay (her wish card) + his final decline
// ---------------------------------------------------------------------------

export type OfferPayResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | "wrong-state"
        | "not-allowed"
        | "already-offered"
        | "pay-declined";
    }
  | { ok: true };

/**
 * She (hetero female initiator) asks him to cover the change: sends the wish
 * card to his chat with pay/decline buttons. One-shot per session.
 */
export async function offerPartnerPay(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
): Promise<OfferPayResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const me = userOfSide(match, side);

  if (match.venueChangeStatus !== "agreed" || match.venueChangeExpressAt) {
    return { ok: false, reason: "wrong-state" };
  }
  const eligible =
    isHeteroPair(match) && me.gender === "female" && match.venueChangeProposerId === me.id;
  if (!eligible) return { ok: false, reason: "not-allowed" };
  if (match.venueChangePayDeclinedAt) return { ok: false, reason: "pay-declined" };

  const claim = await prisma.match.updateMany({
    where: { id: matchId, venueChangeStatus: "agreed", venueChangeOfferPaySentAt: null },
    data: { venueChangeOfferPaySentAt: new Date() },
  });
  if (claim.count === 0) return { ok: false, reason: "already-offered" };

  const him = userOfSide(match, otherSide(side));
  if (isTelegramTarget(him.telegramId)) {
    await sendWishCard(api, match, me.firstName ?? "", him).catch((err) => {
      console.warn("[venue-change] wish card send failed:", err);
    });
  }
  return { ok: true };
}

/**
 * The wish card: her ask that he covers the venue change. PNG render lands in
 * a follow-up stage; the text card below is the permanent graceful fallback.
 */
async function sendWishCard(
  api: Api<RawApi>,
  match: VcMatch,
  herName: string,
  him: { telegramId: bigint; language: string | null },
): Promise<void> {
  const lang = langOf(him.language);
  const venueName = match.venueChangeName ?? "";
  const label = venueLabel(venueName, match.venueChangeAddress ?? "");
  const link = await createVenueInvoiceLink(api, lang, match.id, "agreed", venueName);
  const kb = new InlineKeyboard()
    .url(t(lang, "venueWishPayBtn", { stars: env.VENUE_CHANGE_STARS }), link)
    .row()
    .text(t(lang, "venueWishDeclineBtn"), `vchg:paydecline:${match.id}`);

  const { renderVenueWishCard } = await import("../../services/venue-wish-card.js");
  const png = await renderVenueWishCard(match.id).catch(() => null);
  const caption = t(lang, "venueWishText", { name: herName, venue: label });
  if (png) {
    const { InputFile } = await import("grammy");
    await api.sendPhoto(toTelegramChatId(him.telegramId), new InputFile(png, "venue-wish.png"), {
      caption,
      reply_markup: kb,
      protect_content: true,
    });
  } else {
    await api.sendMessage(toTelegramChatId(him.telegramId), caption, { reply_markup: kb });
  }
}

/**
 * His single, final "not this time" — from the wish card's inline button or
 * the Mini App fork. Never cancels anything; she keeps her pay-self path and
 * gets a soft nudge (with no mention of a refusal).
 */
export async function declineVenuePay(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
): Promise<{ ok: boolean }> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false };
  const side = sideOfUser(match, telegramId);
  if (!side) return { ok: false };
  const me = userOfSide(match, side);

  if (match.venueChangeStatus !== "agreed" || match.venueChangeExpressAt) return { ok: false };
  if (payerSide(match) !== side) return { ok: false };

  const claim = await prisma.match.updateMany({
    where: { id: matchId, venueChangeStatus: "agreed", venueChangePayDeclinedAt: null },
    data: { venueChangePayDeclinedAt: new Date() },
  });
  if (claim.count === 0) return { ok: false };

  console.info(`[venue-change] pay declined match=${matchId} by user=${me.id}`);

  // Soft pay-self nudge to her — venue + a direct invoice link, no refusal talk.
  const her = userOfSide(match, otherSide(side));
  if (isTelegramTarget(her.telegramId)) {
    const lang = langOf(her.language);
    const venueName = match.venueChangeName ?? "";
    try {
      const link = await createVenueInvoiceLink(api, lang, matchId, "agreed", venueName);
      const kb = new InlineKeyboard().url(
        t(lang, "venuePaySelfBtn", { stars: env.VENUE_CHANGE_STARS }),
        link,
      );
      await api.sendMessage(
        toTelegramChatId(her.telegramId),
        t(lang, "venuePaySelfDm", {
          venue: venueLabel(venueName, match.venueChangeAddress ?? ""),
        }),
        { reply_markup: kb },
      );
    } catch (err) {
      console.warn("[venue-change] pay-self DM failed:", err);
    }
  }
  return { ok: true };
}

/** Bot callback for the wish card's `[Not this time]` button. */
export async function handleVenuePayDecline(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("vchg:paydecline:")) return;
  const matchId = data.slice("vchg:paydecline:".length);
  await ctx.answerCallbackQuery().catch(() => undefined);
  if (!matchId || !ctx.from) return;

  const result = await declineVenuePay(ctx.api, BigInt(ctx.from.id), matchId);
  if (result.ok) {
    await ctx.reply(t(ctx.session.language, "venuePayDeclineAck")).catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Settle (successful_payment trust boundary)
// ---------------------------------------------------------------------------

/**
 * Telegram confirmed the Stars moved — settle the venue change: copy the
 * agreed venue onto the canonical venue* fields and notify both sides. The
 * status CAS makes a redelivered payment a no-op; a payment that LOSES the CAS
 * (parallel-pay race — both invoices were open) is refunded.
 */
export async function settleVenuePayment(
  api: Api<RawApi>,
  payerTelegramId: bigint,
  matchId: string,
  telegramChargeId: string,
): Promise<{ ok: boolean; reason?: string }> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const side = sideOfUser(match, payerTelegramId);
  if (!side) return { ok: false, reason: "not-participant" };
  const payer = userOfSide(match, side);

  const wasExpress = match.venueChangeExpressAt != null;
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", venueChangeStatus: "agreed" },
    data: {
      venueChangeStatus: "settled",
      venueChangeResolvedAt: new Date(),
      venueChangeExpiresAt: null,
      venueChangePaidById: payer.id,
      venueChangePaidAt: new Date(),
      venueName: match.venueChangeName,
      venueAddress: match.venueChangeAddress,
      venueLat: match.venueChangeLat,
      venueLng: match.venueChangeLng,
      venueGoogleMapsUri: match.venueChangeMapsUri,
      venuePhotoUrl: match.venueChangePhotoUrl,
      venuePhotoName: match.venueChangePhotoName,
    },
  });
  if (claim.count === 0) {
    // Redelivery of an already-settled payment is a no-op; a genuinely lost
    // parallel-pay race must give the Stars back.
    if (match.venueChangePaidById && match.venueChangePaidById !== payer.id) {
      console.warn(
        `[venue-change] parallel-pay race lost match=${matchId} — refunding ${telegramChargeId}`,
      );
      await api
        .refundStarPayment(Number(payerTelegramId), telegramChargeId)
        .catch((err) => console.error("[venue-change] refund failed:", err));
    }
    return { ok: false, reason: "not-agreed" };
  }

  console.info(
    `[venue-change] settled match=${matchId} payer=${payer.id} express=${wasExpress} ` +
      `charge=${telegramChargeId}`,
  );

  const venueName = match.venueChangeName ?? "";
  const venueAddress = match.venueChangeAddress ?? "";
  const mapsUri = match.venueChangeMapsUri;
  const label = venueLabel(venueName, venueAddress);
  const agreedTime = match.agreedTime ?? new Date();
  const peer = userOfSide(match, otherSide(side));

  // Payer: plain updated card.
  await sendUpdatedVenueCard(api, payer, "venueSettledCard", { venue: label }, agreedTime, venueName, venueAddress, mapsUri);

  // Peer: express → the positive-frame surprise; board → updated card that
  // reveals who covered it (gendered by the payer).
  if (isTelegramTarget(peer.telegramId)) {
    const peerKey = wasExpress
      ? payer.gender === "male"
        ? "venueExpressPartnerFromM"
        : "venueExpressPartnerFromF"
      : payer.gender === "male"
        ? "venueSettledPaidByM"
        : "venueSettledPaidByF";
    await sendUpdatedVenueCard(
      api,
      peer,
      peerKey,
      { name: payer.firstName ?? "", venue: label },
      agreedTime,
      venueName,
      venueAddress,
      mapsUri,
    );
  }
  return { ok: true };
}

type SettleCardKey =
  | "venueSettledCard"
  | "venueSettledPaidByM"
  | "venueSettledPaidByF"
  | "venueExpressPartnerFromM"
  | "venueExpressPartnerFromF";

async function sendUpdatedVenueCard(
  api: Api<RawApi>,
  user: { telegramId: bigint; language: string | null },
  key: SettleCardKey,
  vars: Record<string, string>,
  agreedTime: Date,
  name: string,
  address: string,
  mapsUri: string | null,
): Promise<void> {
  if (!isTelegramTarget(user.telegramId)) return;
  const lang = langOf(user.language);
  const base = t(lang, key, vars);
  const { text, entity } = buildDateTimeEntity(base, agreedTime, lang);
  const kb = new InlineKeyboard().url(
    t(lang, "matchScheduledBtnOpenMaps"),
    venueMapsUrl(name, address, mapsUri),
  );
  await api
    .sendMessage(toTelegramChatId(user.telegramId), text, {
      entities: [entity],
      reply_markup: kb,
    })
    .catch((err) => {
      console.warn(`[venue-change] updated card send failed for ${user.telegramId}:`, err);
    });
}

// ---------------------------------------------------------------------------
// Expiry sweep (date-lifecycle tick, BEFORE ice-breakers)
// ---------------------------------------------------------------------------

/**
 * Resolve overdue `agreed` states. An unpaid BOARD agreement lapses — the
 * original venue stands, both sides get a neutral notice, and the board closes
 * for this date. An abandoned EXPRESS mint quietly reverts to the open board
 * (no DMs — the partner never knew, and she simply changed her mind). The
 * match itself is never touched.
 */
export async function sweepExpiredVenueChanges(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<number> {
  if (!env.VENUE_CHANGE_FEATURE_ENABLED) return 0;

  const due = await prisma.match.findMany({
    where: { venueChangeStatus: "agreed", venueChangeExpiresAt: { lte: now } },
    select: VC_SELECT,
  });

  let resolved = 0;
  for (const match of due) {
    if (match.venueChangeExpressAt) {
      // Express revert: back to the open board, wipe the hidden pick.
      const hasLikes =
        parseLikes(match.venueLikesA).length > 0 || parseLikes(match.venueLikesB).length > 0;
      const claim = await prisma.match.updateMany({
        where: { id: match.id, venueChangeStatus: "agreed", venueChangeExpressAt: { not: null } },
        data: {
          venueChangeStatus: hasLikes ? "liking" : null,
          venueChangeName: null,
          venueChangeAddress: null,
          venueChangeLat: null,
          venueChangeLng: null,
          venueChangeMapsUri: null,
          venueChangePlaceId: null,
          venueChangePhotoUrl: null,
          venueChangePhotoName: null,
          venueChangeExpiresAt: null,
          venueChangeExpressAt: null,
        },
      });
      if (claim.count > 0) resolved += 1;
      continue;
    }

    const claim = await prisma.match.updateMany({
      where: { id: match.id, venueChangeStatus: "agreed", venueChangeExpressAt: null },
      data: {
        venueChangeStatus: "lapsed",
        venueChangeResolvedAt: now,
        venueChangeExpiresAt: null,
      },
    });
    if (claim.count === 0) continue;
    resolved += 1;

    const original = match.venueName ?? "";
    for (const user of [match.userA, match.userB]) {
      if (!isTelegramTarget(user.telegramId)) continue;
      await api
        .sendMessage(
          toTelegramChatId(user.telegramId),
          t(langOf(user.language), "venueLapsedDm", { venue: original }),
        )
        .catch(() => undefined);
    }
  }
  return resolved;
}
