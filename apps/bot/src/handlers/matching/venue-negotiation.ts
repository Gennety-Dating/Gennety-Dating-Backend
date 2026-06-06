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
import { InlineKeyboard, Keyboard } from "grammy";
import type { InlineKeyboardMarkup, ReplyKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { parseVibe, mergeParsed } from "../../services/vibe-parser.js";
import {
  midpoint,
  haversineDistanceKm,
  venueSearchRadiusMeters,
  type LatLng,
} from "../../services/geo.js";
import { type Venue } from "../../services/venue.js";
import { resolveVenue } from "../../services/curated-venue.js";
import {
  shouldOfferVenueChange,
  buildVenueChangeButton,
  sendVenueChangeHint,
} from "./venue-change.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import { generateAndSaveWingmanHints } from "../../services/wingman-hint.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { venueSearchSteps } from "../../services/analysis-status.js";

/**
 * Build the reply keyboard that surfaces Telegram's `request_location`
 * button. Kept exported for the legacy code path / tests; the live
 * concierge prompt now uses the Mini App map picker instead.
 *
 * The keyboard is one-shot (`one_time_keyboard: true`) so it auto-hides
 * after the user taps it. NB: grammY's `Keyboard.build()` returns the
 * `KeyboardButton[][]` rows array, not a full `ReplyKeyboardMarkup` —
 * Telegram rejects bare arrays with `400: object expected as reply
 * markup`, so we serialise explicitly.
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
 * Inline keyboard with a `web_app` button that opens the Location Mini
 * App. Replaces the legacy `request_location` reply keyboard as the
 * primary location-input affordance — the reply button is broken on
 * Telegram Desktop (no GPS) and lets users only share their current
 * GPS, not a metro stop or a friend's address. The Mini App supports:
 *  - Type-and-pick autocomplete (Places searchText)
 *  - Tap on map
 *  - Drag the marker
 *
 * The `?match=…&lang=…` query lets the Mini App scope itself to this
 * match without requiring the user to be in inline mode.
 */
export function buildLocationMapKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboardMarkup {
  const url = `${env.WEBAPP_URL}/location.html?match=${matchId}&lang=${lang}`;
  const kb = new InlineKeyboard().webApp(t(lang, "venueConciergeBtnMap"), url);
  return { inline_keyboard: kb.inline_keyboard };
}

function buildScheduledMapsKeyboard(venue: Venue, lang: Language): InlineKeyboardMarkup {
  const url = buildVenueMapsUrl(venue);
  const kb = new InlineKeyboard().url(t(lang, "matchScheduledBtnOpenMaps"), url);
  return { inline_keyboard: kb.inline_keyboard };
}

function buildVenueMapsUrl(venue: Venue): string {
  if (venue.googleMapsUri && /^https?:\/\//i.test(venue.googleMapsUri)) {
    return venue.googleMapsUri;
  }

  const query = [venue.name, venue.address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
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
        reply_markup: buildLocationMapKeyboard(matchId, langA),
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationMapKeyboard(matchId, langB),
      }),
    );
  }
  await Promise.all(sends);
}

/**
 * Send the side-aware "what's next" ACK after one of (vibeText | vibeLat+Lng)
 * is saved on a `negotiating_venue` match. Picks one of three messages:
 *   - both done                → `venueWaitingPeer` (waiting on partner)
 *   - vibe done, no location   → `venueVibeNoted` + 🗺️ Pick on map button
 *   - location done, no vibe   → `venueLocationNoted` (text, asks for vibe)
 *
 * Centralised here so the bot-message handlers and the Mini App POST
 * route share the exact same logic — without it, picking location via
 * the Mini App left the user with no chat-side cue, which read as the
 * bot ignoring them.
 *
 * Returns the chosen i18n key so callers can chain remove_keyboard /
 * other behaviour off the result if they want; passes-through any
 * sendMessage failure as a swallowed warn.
 */
export async function sendVenuePostSaveAck(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  side: "A" | "B",
  lang: Language,
): Promise<"venueWaitingPeer" | "venueVibeNoted" | "venueLocationNoted" | null> {
  if (!isTelegramTarget(telegramId)) return null;

  const m = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      vibeTextA: true,
      vibeTextB: true,
      vibeLatA: true,
      vibeLngA: true,
      vibeLatB: true,
      vibeLngB: true,
    },
  });
  if (!m) return null;

  const hasVibe = side === "A" ? Boolean(m.vibeTextA) : Boolean(m.vibeTextB);
  const hasLocation =
    side === "A"
      ? m.vibeLatA != null && m.vibeLngA != null
      : m.vibeLatB != null && m.vibeLngB != null;

  let key: "venueWaitingPeer" | "venueVibeNoted" | "venueLocationNoted";
  let withMapButton = false;
  if (hasVibe && hasLocation) {
    key = "venueWaitingPeer";
  } else if (hasVibe) {
    key = "venueVibeNoted";
    withMapButton = true; // user just saved vibe; surface map button next
  } else {
    key = "venueLocationNoted";
  }

  await api
    .sendMessage(Number(telegramId), t(lang, key), {
      // venueLocationNoted carries `*vibe*` markdown to bold the prompt;
      // the others are plain but Markdown is safe (no offending chars).
      parse_mode: "Markdown",
      ...(withMapButton ? { reply_markup: buildLocationMapKeyboard(matchId, lang) } : {}),
    })
    .catch((err) => {
      console.warn(`[venue-ack] sendMessage failed for ${telegramId}:`, err);
    });

  return key;
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

  await sendVenuePostSaveAck(
    ctx.api,
    BigInt(ctx.from!.id),
    matchId,
    side,
    lang,
  );

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

  await sendVenuePostSaveAck(
    ctx.api,
    BigInt(ctx.from!.id),
    matchId,
    side,
    lang,
  );

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
      userA: { select: { telegramId: true, language: true, gender: true, universityDomain: true } },
      userB: { select: { telegramId: true, language: true, gender: true } },
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

  // Curated-first: a hand-picked venue for this university wins; Places is the
  // fallback when nothing curated is in commute range. See `resolveVenue`.
  // Run the lookup concurrently with a self-replacing "picking the best spot"
  // status so the real (often sub-second) lookup hides behind a considered ~5s
  // cadence — a venue that pops instantly reads as "first result grabbed".
  const venuePromise = resolveVenue({
    universityDomain: match.userA.universityDomain,
    midpoint: mid,
    originA: a,
    originB: b,
    radiusMeters,
    category: merged.category,
    keywords: merged.keywords,
    agreedTime: match.agreedTime,
  });

  const searchingRuns: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    searchingRuns.push(
      runStatusSequence(
        api,
        Number(match.userA.telegramId),
        venueSearchSteps(langA),
      ).catch(() => undefined),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    searchingRuns.push(
      runStatusSequence(
        api,
        Number(match.userB.telegramId),
        venueSearchSteps(langB),
      ).catch(() => undefined),
    );
  }

  const [venue] = await Promise.all([venuePromise, ...searchingRuns]);

  await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "scheduled",
      venueName: venue.name,
      venueAddress: venue.address,
      venueLat: mid.lat,
      venueLng: mid.lng,
      venueGoogleMapsUri: venue.googleMapsUri,
    },
  });

  // Pre-generate Wingman hints now so the T-1.5h lifecycle tick has them
  // cached. Fire-and-forget; idempotent regeneration at reveal time
  // handles any LLM outage that happens during this call.
  generateAndSaveWingmanHints(matchId).catch((err) => {
    console.warn(`[wingman] generation failed for match ${matchId}:`, err);
  });

  // Append the Google Maps deep-link on a new line when available so
  // the user can tap to verify the venue exists / pre-check hours and
  // commute. Telegram auto-linkifies bare URLs in plain text — no
  // parse_mode needed (and we want to avoid Markdown escaping issues
  // around place names containing `*` / `_`).
  const venueLabel = venue.googleMapsUri
    ? `${venue.name} — ${venue.address}\n${venue.googleMapsUri}`
    : `${venue.name} — ${venue.address}`;
  const baseA = t(langA, "matchScheduled", { venue: venueLabel });
  const baseB = t(langB, "matchScheduled", { venue: venueLabel });
  const { text: textA, entity: entA } = buildDateTimeEntity(baseA, match.agreedTime, langA);
  const { text: textB, entity: entB } = buildDateTimeEntity(baseB, match.agreedTime, langB);
  const mapsKeyboardA = buildScheduledMapsKeyboard(venue, langA);
  const mapsKeyboardB = buildScheduledMapsKeyboard(venue, langB);

  // Female-exclusive one-shot "Change venue" button on her scheduled card
  // (feature-flagged). Inert for the male / when the flag is off.
  if (shouldOfferVenueChange(match.userA.gender)) {
    mapsKeyboardA.inline_keyboard.push([buildVenueChangeButton(matchId, langA)]);
  }
  if (shouldOfferVenueChange(match.userB.gender)) {
    mapsKeyboardB.inline_keyboard.push([buildVenueChangeButton(matchId, langB)]);
  }

  const finalSends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    finalSends.push(
      api.sendMessage(Number(match.userA.telegramId), textA, {
        entities: [entA],
        reply_markup: mapsKeyboardA,
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    finalSends.push(
      api.sendMessage(Number(match.userB.telegramId), textB, {
        entities: [entB],
        reply_markup: mapsKeyboardB,
      }),
    );
  }
  await Promise.all(finalSends);

  // Follow-up hint DM explaining the one-shot venue-change right (after the card).
  const hintSends: Array<Promise<unknown>> = [];
  if (shouldOfferVenueChange(match.userA.gender)) {
    hintSends.push(sendVenueChangeHint(api, match.userA.telegramId, langA));
  }
  if (shouldOfferVenueChange(match.userB.gender)) {
    hintSends.push(sendVenueChangeHint(api, match.userB.telegramId, langB));
  }
  await Promise.all(hintSends);
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
