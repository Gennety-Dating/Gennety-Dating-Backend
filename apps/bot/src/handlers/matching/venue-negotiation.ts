/**
 * Phase 3.4 — concierge venue negotiation.
 *
 * Once a match has an `agreedTime` locked in, we transition from
 * `negotiating` → `negotiating_venue` and ask both users to provide:
 *   1. a free-text "vibe" (cafe / vegan / park walk / …),
 *   2. a Telegram `message:location` pin of where they'll be commuting from.
 *
 * Order doesn't matter — handlers are idempotent and we accumulate state
 * on the `matches` row. When both users have a full set of (vibeText,
 * lat, lng) the bot computes the great-circle midpoint, safety-parses
 * each vibe into a whitelisted Places category, queries Google Places,
 * and finalises the match to `scheduled`.
 *
 * The final `scheduled` confirmation + `date_time` MessageEntity is
 * emitted from `tryFinalize` below, so this module owns the entire
 * lifecycle from `agreedTime` locked → `scheduled`.
 */

import type { Api, RawApi } from "grammy";
import { Keyboard } from "grammy";
import type { ReplyKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { parseVibe, mergeParsed } from "../../services/vibe-parser.js";
import {
  midpoint,
  haversineDistanceKm,
  venueSearchRadiusMeters,
  type LatLng,
} from "../../services/geo.js";
import { pickVenueAtMidpoint } from "../../services/venue.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import { generateAndSaveWingmanHints } from "../../services/wingman-hint.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";

/**
 * Build the reply keyboard that surfaces Telegram's `request_location`
 * button. We ship a one-shot keyboard (`one_time_keyboard: true`) so it
 * disappears after the user taps it — location sharing is a single event.
 *
 * NB: grammY's `Keyboard.build()` returns the `KeyboardButton[][]` rows array,
 * NOT a full `ReplyKeyboardMarkup` object. Telegram rejects that with
 * `400: object expected as reply markup`. The Keyboard *instance* itself
 * already has `keyboard` / `resize_keyboard` / `one_time_keyboard` populated
 * by the chained methods, so we serialise it explicitly.
 */
export function buildLocationRequestKeyboard(lang: Language): ReplyKeyboardMarkup {
  const kb = new Keyboard()
    .requestLocation(t(lang, "venueConciergeBtnLocation"))
    .resized()
    .oneTime();
  return {
    keyboard: kb.build(),
    resize_keyboard: true,
    one_time_keyboard: true,
  };
}

/**
 * Enter `negotiating_venue`: writes the agreed time, sets the status, and
 * DMs both users with the concierge prompt + a `request_location` keyboard.
 *
 * Called from the scheduler the moment a time overlap is found.
 */
export async function startVenueNegotiation(
  api: Api<RawApi>,
  matchId: string,
  agreedTime: Date,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;

  // Idempotency: if something already advanced the match, bail.
  if (match.status !== "negotiating") return;

  await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "negotiating_venue",
      agreedTime,
      venuePromptAskedAt: new Date(),
    },
  });

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;

  // M-17: mobile-only users use the `/v1/matches/:id/vibe-location` route
  // instead of the Telegram concierge prompt — skip them here.
  const sends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userA.telegramId), t(langA, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationRequestKeyboard(langA),
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationRequestKeyboard(langB),
      }),
    );
  }
  await Promise.all(sends);
}

/**
 * Handler for `message:location` during `negotiating_venue`. Writes the
 * pin to the appropriate side of the match and triggers finalisation if
 * that completes the data set.
 */
export async function handleVenueLocation(ctx: BotContext): Promise<void> {
  const loc = ctx.message?.location;
  if (!loc) return;

  const resolved = await resolveMatchSide(ctx);
  if (!resolved) return;
  const { matchId, side } = resolved;

  const data =
    side === "A"
      ? { vibeLatA: loc.latitude, vibeLngA: loc.longitude }
      : { vibeLatB: loc.latitude, vibeLngB: loc.longitude };
  await prisma.match.update({ where: { id: matchId }, data });

  const lang = ctx.session.language;

  // Acknowledge. The choice of follow-up copy depends on whether the user
  // has already sent their vibe text.
  const refreshed = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      vibeTextA: true,
      vibeTextB: true,
    },
  });
  const hasVibe =
    side === "A" ? Boolean(refreshed?.vibeTextA) : Boolean(refreshed?.vibeTextB);

  await ctx.reply(t(lang, hasVibe ? "venueWaitingPeer" : "venueLocationNoted"), {
    reply_markup: { remove_keyboard: true },
  });

  await tryFinalize(ctx.api, matchId);
}

/**
 * Handler for free-text messages during `negotiating_venue` — the "vibe".
 * Runs the safety parser (deny-list + LLM whitelist) and persists both the
 * raw text (audit trail) and the resolved category.
 */
export async function handleVenueVibe(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  if (!text) return;

  const resolved = await resolveMatchSide(ctx);
  if (!resolved) return;
  const { matchId, side } = resolved;

  const parsed = await parseVibe(text);

  const data =
    side === "A"
      ? {
          vibeTextA: text,
          parsedCategoryA: parsed.category,
        }
      : {
          vibeTextB: text,
          parsedCategoryB: parsed.category,
        };
  await prisma.match.update({ where: { id: matchId }, data });

  const lang = ctx.session.language;

  // If safety layer overrode the user's request, let them know (softly).
  if (!parsed.safe) {
    await ctx.reply(t(lang, "venueSafetyOverride"));
  }

  const refreshed = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
    },
  });
  const hasLocation =
    side === "A"
      ? refreshed?.vibeLatA != null && refreshed?.vibeLngA != null
      : refreshed?.vibeLatB != null && refreshed?.vibeLngB != null;

  await ctx.reply(t(lang, hasLocation ? "venueWaitingPeer" : "venueVibeNoted"));

  await tryFinalize(ctx.api, matchId);
}

/**
 * Check whether both sides have submitted vibe + location. If yes, run
 * the midpoint → Places pipeline and finalise.
 */
export async function tryFinalize(api: Api<RawApi>, matchId: string): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      status: true,
      agreedTime: true,
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
      parsedCategoryA: true,
      parsedCategoryB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;
  if (match.status !== "negotiating_venue") return; // idempotency

  if (
    !match.agreedTime ||
    !match.vibeTextA ||
    !match.vibeTextB ||
    match.vibeLatA == null ||
    match.vibeLngA == null ||
    match.vibeLatB == null ||
    match.vibeLngB == null
  ) {
    return;
  }

  // Re-parse on finalization (defence-in-depth) so a DB row that was
  // written before a whitelist change still gets the latest safety rules.
  const [parsedA, parsedB] = await Promise.all([
    parseVibe(match.vibeTextA),
    parseVibe(match.vibeTextB),
  ]);
  const merged = mergeParsed(parsedA, parsedB);

  const a: LatLng = { lat: match.vibeLatA, lng: match.vibeLngA };
  const b: LatLng = { lat: match.vibeLatB, lng: match.vibeLngB };
  const mid = midpoint(a, b);
  const distanceKm = haversineDistanceKm(a, b);
  const radiusMeters = venueSearchRadiusMeters(distanceKm);

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;

  const searchingSends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    searchingSends.push(
      api
        .sendMessage(Number(match.userA.telegramId), t(langA, "venueSearching"))
        .catch(() => undefined),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    searchingSends.push(
      api
        .sendMessage(Number(match.userB.telegramId), t(langB, "venueSearching"))
        .catch(() => undefined),
    );
  }
  await Promise.all(searchingSends);

  const venue = await pickVenueAtMidpoint({
    lat: mid.lat,
    lng: mid.lng,
    category: merged.category,
    keywords: merged.keywords,
    radiusMeters,
  });

  await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "scheduled",
      venueName: venue.name,
      venueAddress: venue.address,
      venueLat: mid.lat,
      venueLng: mid.lng,
    },
  });

  // Pre-generate Wingman hints now so the T-1h lifecycle tick has them
  // cached. Fire-and-forget; idempotent regeneration at reveal time
  // handles any LLM outage that happens during this call.
  generateAndSaveWingmanHints(matchId).catch((err) => {
    console.warn(`[wingman] generation failed for match ${matchId}:`, err);
  });

  const venueLabel = `${venue.name} — ${venue.address}`;
  const baseA = t(langA, "matchScheduled", { venue: venueLabel });
  const baseB = t(langB, "matchScheduled", { venue: venueLabel });
  const { text: textA, entity: entA } = buildDateTimeEntity(baseA, match.agreedTime);
  const { text: textB, entity: entB } = buildDateTimeEntity(baseB, match.agreedTime);

  const finalSends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    finalSends.push(
      api.sendMessage(Number(match.userA.telegramId), textA, { entities: [entA] }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    finalSends.push(
      api.sendMessage(Number(match.userB.telegramId), textB, { entities: [entB] }),
    );
  }
  await Promise.all(finalSends);
}

/**
 * Map an incoming update to the match and side (A/B) it belongs to.
 * Returns null when the sender isn't an active participant in a
 * `negotiating_venue` match — in which case the router should fall
 * through to the next handler rather than consuming the message.
 */
async function resolveMatchSide(
  ctx: BotContext,
): Promise<{ matchId: string; side: "A" | "B" } | null> {
  const fromId = ctx.from?.id;
  if (!fromId) return null;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(fromId) },
    select: { id: true },
  });
  if (!user) return null;

  // Grab the most recent in-flight venue negotiation for this user. A
  // user should only ever have one at a time given the FSM, but we order
  // by `createdAt desc` defensively.
  const match = await prisma.match.findFirst({
    where: {
      status: "negotiating_venue",
      OR: [{ userAId: user.id }, { userBId: user.id }],
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, userAId: true },
  });
  if (!match) return null;

  return {
    matchId: match.id,
    side: match.userAId === user.id ? "A" : "B",
  };
}
