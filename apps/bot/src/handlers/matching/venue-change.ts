/**
 * Venue change gate (PRODUCT_SPEC §3.7 — female-exclusive one-shot swap).
 *
 * After a match reaches `scheduled` with an auto-assigned venue, the female
 * participant may (once, before the T-5h critical zone) propose an alternative
 * within `VENUE_CHANGE_RADIUS_KM` of the original venue, with a mandatory
 * comment. The male then accepts (venue updates) or declines (match cancels).
 *
 * Like the Date Ticket and Coordination features, this is a string sub-state
 * (`Match.venueChangeStatus`) layered on top of `status = scheduled` — we never
 * add a `MatchStatus` enum value, so the scheduling/venue/lifecycle code that
 * switches on `status` is untouched. Inert when `VENUE_CHANGE_FEATURE_ENABLED`
 * is off.
 *
 * Split of responsibilities:
 *   - `getVenueChangeState` / `proposeVenueChange` back the Mini App API route.
 *   - `handleVenueChange{Accept,Decline,ConfirmCancel,Back}` are the bot
 *     callbacks the male taps.
 *   - `buildVenueChangeButton` / `sendVenueChangeHint` decorate the female's
 *     scheduled-date DM (called from `tryFinalize`).
 *   - `sweepExpiredVenueChanges` auto-cancels a stalled proposal before the
 *     date-lifecycle ice-breaker step runs on a stale venue.
 */

import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type {
  InlineKeyboardButton,
  InlineKeyboardMarkup,
  MessageEntity,
} from "grammy/types";
import { prisma } from "@gennety/db";
import {
  t,
  type Language,
  VENUE_CHANGE_MIN_COMMENT_LEN,
  VENUE_CHANGE_MAX_COMMENT_LEN,
} from "@gennety/shared";
import { env } from "../../config.js";
import type { BotContext } from "../../session.js";
import { isTelegramTarget, toTelegramChatId } from "../../utils/telegram-target.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import {
  evaluateVenueChangeEligibility,
  venueChangeDeadline,
  isWithinRadius,
  buildVenueChangeCatalog,
  type CatalogVenue,
  type VenueChangeIneligibleReason,
} from "../../services/venue-change.js";

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
  venueChangeName: true,
  venueChangeAddress: true,
  venueChangeLat: true,
  venueChangeLng: true,
  venueChangeMapsUri: true,
  venueChangePlaceId: true,
  venueChangeComment: true,
  userAId: true,
  userBId: true,
  userA: { select: { id: true, telegramId: true, language: true, gender: true, universityDomain: true } },
  userB: { select: { id: true, telegramId: true, language: true, gender: true } },
} as const;

type VcMatch = NonNullable<Awaited<ReturnType<typeof loadMatch>>>;

function loadMatch(matchId: string) {
  return prisma.match.findUnique({ where: { id: matchId }, select: VC_SELECT });
}

function langOf(lang: string | null): Language {
  return (lang ?? "en") as Language;
}

// ---------------------------------------------------------------------------
// Female scheduled-DM decoration (called from tryFinalize)
// ---------------------------------------------------------------------------

/** Whether this side may be offered the one-shot venue change on their card. */
export function shouldOfferVenueChange(gender: string | null): boolean {
  return env.VENUE_CHANGE_FEATURE_ENABLED && gender === "female";
}

function venueChangeUrl(matchId: string, lang: Language): string {
  return `${env.WEBAPP_URL}/venue-change.html?match=${matchId}&lang=${lang}`;
}

/** The `web_app` button appended to the female's scheduled-date card. */
export function buildVenueChangeButton(
  matchId: string,
  lang: Language,
): InlineKeyboardButton.WebAppButton {
  return { text: t(lang, "venueChangeFemaleButton"), web_app: { url: venueChangeUrl(matchId, lang) } };
}

/** One-line follow-up DM explaining the one-shot right (sent after her card). */
export async function sendVenueChangeHint(
  api: Api<RawApi>,
  telegramId: bigint,
  lang: Language,
): Promise<void> {
  if (!isTelegramTarget(telegramId)) return;
  await api
    .sendMessage(toTelegramChatId(telegramId), t(lang, "venueChangeFemaleHint"), {
      parse_mode: "Markdown",
    })
    .catch((err) => {
      console.warn(`[venue-change] hint send failed for ${telegramId}:`, err);
    });
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function originCenter(match: VcMatch): { lat: number; lng: number } | null {
  if (match.venueLat == null || match.venueLng == null) return null;
  return { lat: match.venueLat, lng: match.venueLng };
}

function venueMapsUrl(name: string, address: string, mapsUri: string | null): string {
  if (mapsUri && /^https?:\/\//i.test(mapsUri)) return mapsUri;
  const query = [name, address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

/** Multi-line venue label used in DMs (name — address \n mapsUri). */
function venueLabel(name: string, address: string, mapsUri: string | null): string {
  const head = `${name} — ${address}`;
  return mapsUri ? `${head}\n${mapsUri}` : head;
}

function mapsKeyboard(name: string, address: string, mapsUri: string | null, lang: Language): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().url(
    t(lang, "matchScheduledBtnOpenMaps"),
    venueMapsUrl(name, address, mapsUri),
  );
  return { inline_keyboard: kb.inline_keyboard };
}

/**
 * Compensating standby/priority boost for the female after a venue change is
 * cancelled or lapses — she lost a real, accepted date through no matching
 * fault (decision C4). Mirrors `boostAcceptedSidePriority` in decision.ts; no
 * Elo penalty is applied to anyone.
 */
async function boostFemalePriority(userId: string): Promise<void> {
  try {
    await prisma.profile.updateMany({
      where: { userId },
      data: {
        standbyCount: { increment: 1 },
        missedWeeks: { increment: 1 },
        lastMissedAt: new Date(),
      },
    });
  } catch (err) {
    console.warn("[venue-change] female priority boost failed:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// State (GET /v1/venue-change/state)
// ---------------------------------------------------------------------------

export interface VenueChangeStateView {
  status: string; // venueChangeStatus ?? "none"
  eligible: boolean;
  ineligibleReason: VenueChangeIneligibleReason | null;
  minCommentLength: number;
  original: { name: string | null; address: string | null; mapsUri: string | null } | null;
}

export type VenueChangeStateResult =
  | { ok: false; reason: "match-not-found" | "not-participant" }
  | { ok: true; state: VenueChangeStateView };

export async function getVenueChangeState(
  telegramId: bigint,
  matchId: string,
  now: Date = new Date(),
): Promise<VenueChangeStateResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const callerId = userIdForTelegram(match, telegramId);
  if (!callerId) return { ok: false, reason: "not-participant" };

  const eligibility = evaluateVenueChangeEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: callerId,
    userAId: match.userAId,
    userBId: match.userBId,
    genderA: match.userA.gender,
    genderB: match.userB.gender,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeProposedAt: match.venueChangeProposedAt,
    now,
  });

  return {
    ok: true,
    state: {
      status: match.venueChangeStatus ?? "none",
      eligible: eligibility.ok,
      ineligibleReason: eligibility.ok ? null : eligibility.reason,
      minCommentLength: VENUE_CHANGE_MIN_COMMENT_LEN,
      original: {
        name: match.venueName,
        address: match.venueAddress,
        mapsUri: match.venueGoogleMapsUri,
      },
    },
  };
}

function userIdForTelegram(match: VcMatch, telegramId: bigint): string | null {
  if (match.userA.telegramId === telegramId) return match.userA.id;
  if (match.userB.telegramId === telegramId) return match.userB.id;
  return null;
}

// ---------------------------------------------------------------------------
// Catalog (GET /v1/venue-change/catalog)
// ---------------------------------------------------------------------------

export type VenueChangeCatalogResult =
  | { ok: false; reason: "match-not-found" | "not-participant" | VenueChangeIneligibleReason }
  | { ok: true; venues: CatalogVenue[] };

/**
 * Load the match, gate on eligibility (only the eligible female sees the
 * catalog), and build the 3 km curated-first / Places-fallback list centered on
 * the original venue.
 */
export async function getVenueChangeCatalog(
  telegramId: bigint,
  matchId: string,
  now: Date = new Date(),
): Promise<VenueChangeCatalogResult> {
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const callerId = userIdForTelegram(match, telegramId);
  if (!callerId) return { ok: false, reason: "not-participant" };

  const eligibility = evaluateVenueChangeEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: callerId,
    userAId: match.userAId,
    userBId: match.userBId,
    genderA: match.userA.gender,
    genderB: match.userB.gender,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeProposedAt: match.venueChangeProposedAt,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  const center = originCenter(match);
  if (!center || !match.agreedTime) return { ok: false, reason: "no-venue" };

  const venues = await buildVenueChangeCatalog({
    universityDomain: match.userA.universityDomain,
    center,
    agreedTime: match.agreedTime,
  });
  return { ok: true, venues };
}

// ---------------------------------------------------------------------------
// Propose (POST /v1/venue-change/propose)
// ---------------------------------------------------------------------------

export interface ProposeVenueChangeInput {
  placeId: string | null;
  name: string;
  address: string;
  lat: number;
  lng: number;
  mapsUri: string | null;
  comment: string;
}

/** Catalog loader signature — injectable so tests need no DB / Places network. */
type LoadVenueChangeCatalog = (args: {
  universityDomain: string | null;
  center: { lat: number; lng: number };
  agreedTime: Date;
}) => Promise<CatalogVenue[]>;

export interface ProposeVenueChangeOptions {
  now?: Date;
  loadCatalog?: LoadVenueChangeCatalog;
}

/**
 * Resolve a client-submitted pick to a real catalog row. Prefers an exact
 * Places/curated `placeId` match; falls back to a ~55 m coordinate match for
 * curated rows without a `placeId` (or older Mini App bundles that didn't echo
 * one back). The CALLER must use the returned row's own name/address/mapsUri —
 * never the client's — so a spoofed label or phishing maps link can't ride along.
 */
function resolveCatalogPick(
  catalog: CatalogVenue[],
  input: ProposeVenueChangeInput,
): CatalogVenue | null {
  if (input.placeId) {
    const byId = catalog.find((v) => v.placeId != null && v.placeId === input.placeId);
    if (byId) return byId;
  }
  const EPS = 0.0005; // ≈ 55 m
  return (
    catalog.find(
      (v) => Math.abs(v.lat - input.lat) < EPS && Math.abs(v.lng - input.lng) < EPS,
    ) ?? null
  );
}

export type ProposeVenueChangeResult =
  | {
      ok: false;
      reason:
        | "match-not-found"
        | "not-participant"
        | VenueChangeIneligibleReason
        | "comment-too-short"
        | "out-of-range"
        | "invalid-venue"
        | "race-lost";
    }
  | { ok: true };

/**
 * Female proposes a replacement venue. Re-validates eligibility, comment
 * length, and that the pick is within range of the ORIGINAL venue (never
 * trusts the client's coords blindly — same stance as `/v1/calendar/pick`).
 * On success: writes the `proposed` sub-state + deadline and DMs the male.
 */
export async function proposeVenueChange(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  input: ProposeVenueChangeInput,
  options: ProposeVenueChangeOptions = {},
): Promise<ProposeVenueChangeResult> {
  const now = options.now ?? new Date();
  const loadCatalog = options.loadCatalog ?? buildVenueChangeCatalog;
  const match = await loadMatch(matchId);
  if (!match) return { ok: false, reason: "match-not-found" };
  const callerId = userIdForTelegram(match, telegramId);
  if (!callerId) return { ok: false, reason: "not-participant" };

  const eligibility = evaluateVenueChangeEligibility({
    featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
    status: match.status,
    callerUserId: callerId,
    userAId: match.userAId,
    userBId: match.userBId,
    genderA: match.userA.gender,
    genderB: match.userB.gender,
    agreedTime: match.agreedTime,
    venueLat: match.venueLat,
    venueLng: match.venueLng,
    venueChangeProposedAt: match.venueChangeProposedAt,
    now,
  });
  if (!eligibility.ok) return { ok: false, reason: eligibility.reason };

  const comment = input.comment.trim();
  if (comment.length < VENUE_CHANGE_MIN_COMMENT_LEN) {
    return { ok: false, reason: "comment-too-short" };
  }
  if (
    !Number.isFinite(input.lat) ||
    !Number.isFinite(input.lng) ||
    Math.abs(input.lat) > 90 ||
    Math.abs(input.lng) > 180 ||
    !input.name.trim()
  ) {
    return { ok: false, reason: "invalid-venue" };
  }

  const center = originCenter(match);
  if (!center) return { ok: false, reason: "no-venue" };
  if (!isWithinRadius(center, { lat: input.lat, lng: input.lng })) {
    return { ok: false, reason: "out-of-range" };
  }

  const agreedTime = match.agreedTime;
  if (!agreedTime) return { ok: false, reason: "wrong-state" };

  // Re-derive the venue from the server-built catalog — never trust the
  // client's name/address/mapsUri/placeId. Without this a proposer could relay
  // an arbitrary venue label or a phishing maps link to the partner and have it
  // persisted as the canonical venue on accept. Same stance as
  // `/v1/calendar/pick` validating submitted slots against `proposedTimes`.
  const catalog = await loadCatalog({
    universityDomain: match.userA.universityDomain,
    center,
    agreedTime,
  });
  const resolved = resolveCatalogPick(catalog, input);
  if (!resolved) return { ok: false, reason: "invalid-venue" };

  const deadline = venueChangeDeadline(now, agreedTime);

  // Atomic one-shot claim: only the first proposal on a `scheduled` match with
  // a null `venueChangeProposedAt` wins. A concurrent second tap (or the F–F
  // peer racing) loses and is rejected.
  const claim = await prisma.match.updateMany({
    where: {
      id: matchId,
      status: "scheduled",
      venueChangeProposedAt: null,
    },
    data: {
      venueChangeStatus: "proposed",
      venueChangeProposerId: callerId,
      venueChangeProposedAt: now,
      venueChangeExpiresAt: deadline,
      venueChangeName: resolved.name.slice(0, 256),
      venueChangeAddress: resolved.address.slice(0, 256),
      venueChangeLat: resolved.lat,
      venueChangeLng: resolved.lng,
      venueChangeMapsUri: resolved.mapsUri,
      venueChangePlaceId: resolved.placeId,
      venueChangeComment: comment.slice(0, VENUE_CHANGE_MAX_COMMENT_LEN),
    },
  });
  if (claim.count === 0) return { ok: false, reason: "race-lost" };

  // DM the male (the non-proposer participant) the proposal + her comment.
  const proposerSide = match.userA.id === callerId ? "A" : "B";
  const male = proposerSide === "A" ? match.userB : match.userA;
  if (isTelegramTarget(male.telegramId)) {
    const lang = langOf(male.language);
    const notice = buildVenueChangeProposalNotice(
      lang,
      venueLabel(resolved.name, resolved.address, resolved.mapsUri),
      comment.slice(0, VENUE_CHANGE_MAX_COMMENT_LEN),
    );
    await api
      .sendMessage(toTelegramChatId(male.telegramId), notice.text, {
        entities: notice.entities,
        reply_markup: buildDecisionKeyboard(matchId, lang),
      })
      .catch((err) => {
        console.warn(`[venue-change] proposal DM failed for ${male.telegramId}:`, err);
      });
  }

  return { ok: true };
}

/**
 * Build the male's proposal message: intro + new venue + her comment as a
 * verbatim Telegram blockquote (no AI rewrite) + the ask. Mirrors the
 * emergency-reason relay carve-out — a one-shot, non-reply relay, NOT a chat.
 */
export function buildVenueChangeProposalNotice(
  lang: Language,
  venueLabelText: string,
  comment: string,
): { text: string; entities: MessageEntity[] } {
  const intro = t(lang, "venueChangeMaleIntro");
  const venueLine = t(lang, "venueChangeMaleNewVenue", { venue: venueLabelText });
  const commentIntro = t(lang, "venueChangeMaleComment");
  const ask = t(lang, "venueChangeMaleAsk");

  const beforeComment = `${intro}\n\n${venueLine}\n\n${commentIntro}\n\n`;
  const text = `${beforeComment}${comment}\n\n${ask}`;
  const entities: MessageEntity[] =
    comment.length > 0
      ? [{ type: "blockquote", offset: beforeComment.length, length: comment.length }]
      : [];
  return { text, entities };
}

function buildDecisionKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const kb = new InlineKeyboard()
    .text(t(lang, "venueChangeBtnAccept"), `vchg:accept:${matchId}`)
    .row()
    .text(t(lang, "venueChangeBtnDecline"), `vchg:decline:${matchId}`);
  return { inline_keyboard: kb.inline_keyboard };
}

function buildCancelConfirmKeyboard(matchId: string, lang: Language): InlineKeyboardMarkup {
  const kb = new InlineKeyboard()
    .text(t(lang, "venueChangeBtnConfirmCancel"), `vchg:cancel_confirm:${matchId}`)
    .danger()
    .row()
    .text(t(lang, "venueChangeBtnBack"), `vchg:cancel_back:${matchId}`)
    .success();
  return { inline_keyboard: kb.inline_keyboard };
}

// ---------------------------------------------------------------------------
// Bot callbacks (the male taps)
// ---------------------------------------------------------------------------

/** Resolve the acting user + match for a `vchg:*` callback, or null to ignore. */
async function resolveCallback(
  ctx: BotContext,
  prefix: string,
): Promise<{ match: VcMatch; matchId: string; userId: string } | null> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith(prefix)) return null;
  const matchId = data.slice(prefix.length);
  if (!matchId) return null;

  await ctx.answerCallbackQuery().catch(() => undefined);

  const match = await loadMatch(matchId);
  if (!match) return null;
  const userId = ctx.from ? userIdForTelegram(match, BigInt(ctx.from.id)) : null;
  if (!userId) return null;
  // The proposer (female) never acts on her own proposal.
  if (userId === match.venueChangeProposerId) return null;
  return { match, matchId, userId };
}

export async function handleVenueChangeAccept(ctx: BotContext): Promise<void> {
  const resolved = await resolveCallback(ctx, "vchg:accept:");
  if (!resolved) return;
  const { match, matchId } = resolved;
  const lang = ctx.session.language;

  if (match.venueChangeStatus !== "proposed") {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }

  // Atomic accept: copy the proposed venue onto the canonical venue fields.
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", venueChangeStatus: "proposed" },
    data: {
      venueChangeStatus: "accepted",
      venueChangeResolvedAt: new Date(),
      venueChangeExpiresAt: null,
      venueName: match.venueChangeName,
      venueAddress: match.venueChangeAddress,
      venueLat: match.venueChangeLat,
      venueLng: match.venueChangeLng,
      venueGoogleMapsUri: match.venueChangeMapsUri,
    },
  });
  if (claim.count === 0) {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }

  const name = match.venueChangeName ?? "";
  const address = match.venueChangeAddress ?? "";
  const mapsUri = match.venueChangeMapsUri;
  const label = venueLabel(name, address, mapsUri);
  const agreedTime = match.agreedTime ?? new Date();

  // DM the female: accepted.
  const proposer = match.userA.id === match.venueChangeProposerId ? match.userA : match.userB;
  if (isTelegramTarget(proposer.telegramId)) {
    await sendVenueCard(ctx.api, proposer.telegramId, langOf(proposer.language), "venueChangeAcceptedFemale", label, agreedTime, name, address, mapsUri);
  }
  // Ack the male with the updated card.
  await sendVenueCard(ctx.api, BigInt(ctx.from!.id), lang, "venueChangeAcceptedMaleAck", label, agreedTime, name, address, mapsUri);
}

export async function handleVenueChangeDecline(ctx: BotContext): Promise<void> {
  const resolved = await resolveCallback(ctx, "vchg:decline:");
  if (!resolved) return;
  const { match, matchId } = resolved;
  const lang = ctx.session.language;
  if (match.venueChangeStatus !== "proposed") {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }
  // Just surface the confirmation guard — no state change yet.
  await ctx.reply(t(lang, "venueChangeDeclineConfirm"), {
    reply_markup: buildCancelConfirmKeyboard(matchId, lang),
  });
}

export async function handleVenueChangeBack(ctx: BotContext): Promise<void> {
  const resolved = await resolveCallback(ctx, "vchg:cancel_back:");
  if (!resolved) return;
  const { match, matchId } = resolved;
  const lang = ctx.session.language;
  if (match.venueChangeStatus !== "proposed") {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }
  // Re-offer the accept/decline choice.
  await ctx.reply(t(lang, "venueChangeMaleAsk"), {
    reply_markup: buildDecisionKeyboard(matchId, lang),
  });
}

export async function handleVenueChangeConfirmCancel(ctx: BotContext): Promise<void> {
  const resolved = await resolveCallback(ctx, "vchg:cancel_confirm:");
  if (!resolved) return;
  const { match, matchId } = resolved;
  const lang = ctx.session.language;

  if (match.venueChangeStatus !== "proposed") {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }

  // Atomic cancel: flip the whole match to cancelled.
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "scheduled", venueChangeStatus: "proposed" },
    data: {
      status: "cancelled",
      venueChangeStatus: "rejected",
      venueChangeResolvedAt: new Date(),
      venueChangeExpiresAt: null,
    },
  });
  if (claim.count === 0) {
    await ctx.answerCallbackQuery({ text: t(lang, "venueChangeAlreadyResolved") }).catch(() => undefined);
    return;
  }

  // C4: no Elo penalty on the male; the female gets a comp/standby boost.
  if (match.venueChangeProposerId) await boostFemalePriority(match.venueChangeProposerId);

  const proposer = match.userA.id === match.venueChangeProposerId ? match.userA : match.userB;
  if (isTelegramTarget(proposer.telegramId)) {
    await ctx.api
      .sendMessage(toTelegramChatId(proposer.telegramId), t(langOf(proposer.language), "venueChangeCancelledFemale"))
      .catch(() => undefined);
  }
  await ctx.reply(t(lang, "venueChangeCancelledMale"));
}

async function sendVenueCard(
  api: Api<RawApi>,
  telegramId: bigint,
  lang: Language,
  key: "venueChangeAcceptedFemale" | "venueChangeAcceptedMaleAck",
  label: string,
  agreedTime: Date,
  name: string,
  address: string,
  mapsUri: string | null,
): Promise<void> {
  const base = t(lang, key, { venue: label });
  const { text, entity } = buildDateTimeEntity(base, agreedTime, lang);
  await api
    .sendMessage(toTelegramChatId(telegramId), text, {
      entities: [entity],
      reply_markup: mapsKeyboard(name, address, mapsUri, lang),
    })
    .catch((err) => {
      console.warn(`[venue-change] card send failed for ${telegramId}:`, err);
    });
}

// ---------------------------------------------------------------------------
// Expiry sweep (called from the date-lifecycle tick, BEFORE ice-breakers)
// ---------------------------------------------------------------------------

/**
 * Auto-cancel any `proposed` venue change whose deadline has passed (TTL or the
 * T-5h cutoff). Returns the number of matches cancelled. Must run before the
 * ice-breaker step so a stalled proposal never lets ice-breakers fire on a
 * venue that's mid-change.
 */
export async function sweepExpiredVenueChanges(
  api: Api<RawApi>,
  now: Date = new Date(),
): Promise<number> {
  // Fully inert (no query) when the feature is off — no `proposed` rows can
  // exist, and skipping the query keeps the date-lifecycle tick untouched.
  if (!env.VENUE_CHANGE_FEATURE_ENABLED) return 0;

  const due = await prisma.match.findMany({
    where: {
      venueChangeStatus: "proposed",
      venueChangeExpiresAt: { lte: now },
    },
    select: VC_SELECT,
  });

  let cancelled = 0;
  for (const match of due) {
    const claim = await prisma.match.updateMany({
      where: { id: match.id, status: "scheduled", venueChangeStatus: "proposed" },
      data: {
        status: "cancelled",
        venueChangeStatus: "expired",
        venueChangeResolvedAt: now,
        venueChangeExpiresAt: null,
      },
    });
    if (claim.count === 0) continue;
    cancelled += 1;

    if (match.venueChangeProposerId) await boostFemalePriority(match.venueChangeProposerId);

    for (const user of [match.userA, match.userB]) {
      if (!isTelegramTarget(user.telegramId)) continue;
      await api
        .sendMessage(toTelegramChatId(user.telegramId), t(langOf(user.language), "venueChangeExpiredCancel"))
        .catch(() => undefined);
    }
  }
  return cancelled;
}
