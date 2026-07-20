/**
 * Phase 3.4 — concierge venue negotiation.
 *
 * Once a match has an `agreedTime` locked in, we transition from
 * `negotiating` → `negotiating_venue` and ask both users, in order, for:
 *   1. a departure point — the Mini App map pin / Telegram `message:location`
 *      of where they'll be setting off from (asked first, on its own, so the
 *      "what am I marking?" ambiguity is gone),
 *   2. a free-text "vibe" (cafe / vegan / park walk / …), requested only
 *      *after* the departure point is saved.
 *
 * The collector itself stays idempotent and accumulates state on the
 * `matches` row, but the *prompts* are sequenced: free text that arrives
 * before the location pin is redirected back to the map rather than banked
 * as a vibe. When both users have a full set of (vibeText, lat, lng) the
 * bot computes the great-circle midpoint, safety-parses each vibe into a
 * whitelisted Places category, queries Google Places, and finalises the
 * match to `scheduled`.
 *
 * The final `scheduled` confirmation + `date_time` MessageEntity is
 * emitted from `tryFinalize` below, so this module owns the entire
 * lifecycle from `agreedTime` locked → `scheduled`.
 */

import type { Api, RawApi } from "grammy";
import { InlineKeyboard, InputFile, Keyboard } from "grammy";
import type {
  InlineKeyboardMarkup,
  MessageEntity,
  ReplyKeyboardMarkup,
} from "grammy/types";
import { prisma, type Theme } from "@gennety/db";
import { t, tv, type Language } from "@gennety/shared";
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
import { shouldOfferVenueChange, buildVenueChangeButton } from "./venue-change.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import { generateAndSaveWingmanHints } from "../../services/wingman-hint.js";
import { generateVenueBlurb } from "../../services/venue-blurb.js";
import { runVenueFinalizationOnce } from "../../services/venue-finalization-flight.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { venueSearchSteps, dateCardSteps } from "../../services/analysis-status.js";
import { renderDateCard, buildShareButton, type CardTheme } from "../../services/date-card/index.js";
import { notifyFounderDateScheduled } from "../../services/founder-notify.js";
import { buildMiniAppUrl } from "../../services/mini-app-url.js";

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
  theme: Theme = "dark",
): InlineKeyboardMarkup {
  const url = buildMiniAppUrl("location", { lang, theme, query: { match: matchId } });
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
 * DMs both users the location-first concierge prompt (`venueConciergeIntro`)
 * + the Mini App map button. The vibe is asked separately once the departure
 * point is saved (see `sendVenuePostSaveAck`), so this opening message is
 * scoped to a single, unambiguous ask: "mark where you'll set off from".
 *
 * Called from the scheduler the moment a time overlap is found.
 */
export async function startVenueNegotiation(
  api: Api<RawApi>,
  matchId: string,
  agreedTime: Date,
): Promise<void> {
  // Atomic claim: only the first caller flips `negotiating → negotiating_venue`.
  // Two concurrent calendar picks can each independently compute the same single
  // overlap (`processCalendarSlotsUpdate`) and both call this in the same tick;
  // the loser updates 0 rows and bails, so the concierge prompts are sent
  // exactly once. Same updateMany-with-count guard used in decision.ts /
  // match-expiry.ts — a non-atomic findUnique-then-update would double-DM both
  // users and clobber `agreedTime` / `calendarMessageId*`.
  const claim = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating" },
    data: {
      status: "negotiating_venue",
      agreedTime,
      venuePromptAskedAt: new Date(),
      calendarMessageIdA: null,
      calendarMessageIdB: null,
    },
  });
  if (claim.count === 0) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userA: { select: { telegramId: true, language: true, theme: true } },
      userB: { select: { telegramId: true, language: true, theme: true } },
    },
  });
  if (!match) return;

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;

  // M-17: mobile-only users use the `/v1/matches/:id/vibe-location` route
  // instead of the Telegram concierge prompt — skip them here.
  const sends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userA.telegramId), t(langA, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationMapKeyboard(matchId, langA, match.userA.theme),
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "venueConciergeIntro"), {
        parse_mode: "Markdown",
        reply_markup: buildLocationMapKeyboard(matchId, langB, match.userB.theme),
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
      userA: { select: { theme: true } },
      userB: { select: { theme: true } },
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
    .sendMessage(Number(telegramId), tv(lang, key), {
      // venueLocationNoted carries `*vibe*` markdown to bold the prompt;
      // the others are plain but Markdown is safe (no offending chars).
      parse_mode: "Markdown",
      ...(withMapButton
        ? {
            reply_markup: buildLocationMapKeyboard(
              matchId,
              lang,
              side === "A" ? m.userA.theme : m.userB.theme,
            ),
          }
        : {}),
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

  const lang = ctx.session.language;

  // Location-first ordering: we only ask for the *vibe* once the user has
  // marked their departure point. If free text lands before that pin, the
  // user is likely answering the wrong question (or never opened the map),
  // so we redirect them back to the location step rather than silently
  // banking the text as a vibe. The vibe prompt (`venueLocationNoted`) is
  // emitted by `sendVenuePostSaveAck` right after the location saves.
  const locState = await prisma.match.findUnique({
    where: { id: matchId },
    select: { vibeLatA: true, vibeLngA: true, vibeLatB: true, vibeLngB: true },
  });
  const hasLocation =
    side === "A"
      ? locState?.vibeLatA != null && locState?.vibeLngA != null
      : locState?.vibeLatB != null && locState?.vibeLngB != null;
  if (!hasLocation) {
    const actor = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from!.id) },
      select: { theme: true },
    });
    await ctx.reply(t(lang, "venueLocationFirst"), {
      parse_mode: "Markdown",
      reply_markup: buildLocationMapKeyboard(matchId, lang, actor?.theme ?? "dark"),
    });
    return;
  }

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
  return runVenueFinalizationOnce(matchId, () => finalizeVenue(api, matchId));
}

async function finalizeVenue(api: Api<RawApi>, matchId: string): Promise<void> {
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
      userA: {
        select: {
          telegramId: true,
          language: true,
          theme: true,
          gender: true,
          age: true,
          universityDomain: true,
          firstName: true,
          profile: { select: { photos: true, homeCity: true } },
        },
      },
      userB: {
        select: {
          telegramId: true,
          language: true,
          theme: true,
          gender: true,
          age: true,
          firstName: true,
          profile: { select: { photos: true, homeCity: true } },
        },
      },
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
  // Each side's date card renders in that recipient's chosen theme.
  const themeA: CardTheme = match.userA.theme === "light" ? "light" : "dark";
  const themeB: CardTheme = match.userB.theme === "light" ? "light" : "dark";

  // Curated-first: a hand-picked venue for this university wins; Places is the
  // fallback when nothing curated is in commute range. See `resolveVenue`.
  // Run the lookup concurrently with a self-replacing "picking the best spot"
  // status. The first three beats always play out; the final "matching your
  // vibe" beat is then held until the real lookup resolves, so a slow Places
  // fallback has honest visible progress without shortening the opening cadence.
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
        { until: venuePromise, untilFromStepIndex: 3, rich: true },
      ).catch(() => undefined),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    searchingRuns.push(
      runStatusSequence(
        api,
        Number(match.userB.telegramId),
        venueSearchSteps(langB),
        { until: venuePromise, untilFromStepIndex: 3, rich: true },
      ).catch(() => undefined),
    );
  }

  const [venue] = await Promise.all([venuePromise, ...searchingRuns]);

  const committed = await prisma.match.updateMany({
    where: { id: matchId, status: "negotiating_venue" },
    data: {
      status: "scheduled",
      venueName: venue.name,
      venueAddress: venue.address,
      venueLat: mid.lat,
      venueLng: mid.lng,
      venueGoogleMapsUri: venue.googleMapsUri,
      // Date-card imagery refs (feature-flagged render; harmless to store always).
      venuePhotoUrl: venue.photoUrl ?? null,
      venuePhotoName: venue.photoName ?? null,
    },
  });
  if (committed.count === 0) return;

  // Pre-generate Wingman hints now so the T-1.5h lifecycle tick has them
  // cached. Fire-and-forget; idempotent regeneration at reveal time
  // handles any LLM outage that happens during this call.
  generateAndSaveWingmanHints(matchId).catch((err) => {
    console.warn(`[wingman] generation failed for match ${matchId}:`, err);
  });

  // Grounded, per-language venue blurb (PRODUCT_SPEC §3.7): a short "what is
  // this place" line built ONLY from real facts (Google editorial summary /
  // rating / category + the vibe both asked for). It replaces the inlined Maps
  // URL — the deep-link already rides the "Open in Maps" keyboard button below,
  // so the body no longer duplicates it. Failsafe: each side degrades to a
  // generic line, so a blurb hiccup never blocks scheduling.
  const [blurbA, blurbB] = await Promise.all([
    generateVenueBlurb({
      venue,
      category: merged.category,
      keywords: merged.keywords,
      language: langA,
    }),
    generateVenueBlurb({
      venue,
      category: merged.category,
      keywords: merged.keywords,
      language: langB,
    }),
  ]);

  // Structured block: 📍 name / full address / blurb. The localized header and
  // the trailing `date_time` entity (added by `buildDateTimeEntity`) wrap it.
  let venueBlockA = `📍 ${venue.name}\n${venue.address}\n${blurbA}`;
  let venueBlockB = `📍 ${venue.name}\n${venue.address}\n${blurbB}`;

  // Expectation-setter: we never book a table, so at a busy slot a *seated* spot
  // can be full on arrival. Warn both sides once, on the card that names the
  // venue, and tell them how to handle it (arrive on time; if full, wait or pick
  // somewhere nearby). Skipped for park/museum, where "no table" is a non-issue
  // — mirrors the venue price-gate's park/museum carve-out (`venue.ts`). Plain
  // text: the scheduled card is sent without `parse_mode`, so no Markdown here.
  if (merged.category !== "park" && merged.category !== "museum") {
    venueBlockA += `\n\n${t(langA, "matchScheduledNoReservation")}`;
    venueBlockB += `\n\n${t(langB, "matchScheduledNoReservation")}`;
  }
  const baseA = t(langA, "matchScheduled", { venue: venueBlockA });
  const baseB = t(langB, "matchScheduled", { venue: venueBlockB });
  const { text: textA, entity: entA } = buildDateTimeEntity(baseA, match.agreedTime, langA);
  const { text: textB, entity: entB } = buildDateTimeEntity(baseB, match.agreedTime, langB);
  const mapsKeyboardA = buildScheduledMapsKeyboard(venue, langA);
  const mapsKeyboardB = buildScheduledMapsKeyboard(venue, langB);

  // Venue-change v2 board button on BOTH scheduled cards (feature-flagged) —
  // a passive affordance; no proactive "does the venue suit you?" question.
  if (shouldOfferVenueChange()) {
    mapsKeyboardA.inline_keyboard.push([
      buildVenueChangeButton(matchId, langA, match.userA.theme),
    ]);
    mapsKeyboardB.inline_keyboard.push([
      buildVenueChangeButton(matchId, langB, match.userB.theme),
    ]);
  }

  // Each side's scheduled confirmation. When the date-card feature is on we
  // try to render a PNG card (the recipient sees their *partner*) and send it
  // screenshot/forward-protected with a Share button; any render failure falls
  // back to the plain-text card per-side, so one render hiccup never denies the
  // other person their card and scheduling never wedges.
  const [resultA, resultB] = await Promise.all([
    sendScheduledConfirmation(api, {
      telegramId: match.userA.telegramId,
      text: textA,
      entity: entA,
      keyboard: mapsKeyboardA,
      language: langA,
      theme: themeA,
      matchId,
      partnerFirstName: match.userB.firstName ?? "",
      partnerPhotoRef: match.userB.profile?.photos?.[0] ?? null,
      venue,
      agreedTime: match.agreedTime,
    }),
    sendScheduledConfirmation(api, {
      telegramId: match.userB.telegramId,
      text: textB,
      entity: entB,
      keyboard: mapsKeyboardB,
      language: langB,
      theme: themeB,
      matchId,
      partnerFirstName: match.userA.firstName ?? "",
      partnerPhotoRef: match.userA.profile?.photos?.[0] ?? null,
      venue,
      agreedTime: match.agreedTime,
    }),
  ]);
  const dateCardFileIdA = resultA.fileId;
  const dateCardFileIdB = resultB.fileId;

  // Cache the rendered date-card `file_id` per side so the "My date" menu hub
  // can re-open the card instantly instead of re-rendering it. `null` (text
  // fallback / feature off) leaves the column untouched.
  if (dateCardFileIdA || dateCardFileIdB) {
    const data: { dateCardFileIdA?: string; dateCardFileIdB?: string } = {};
    if (dateCardFileIdA) data.dateCardFileIdA = dateCardFileIdA;
    if (dateCardFileIdB) data.dateCardFileIdB = dateCardFileIdB;
    await prisma.match
      .updateMany({
        // Rendering happens outside a transaction. Do not repopulate a cache
        // invalidated by a concurrent theme/language change (or by a terminal
        // match transition) while the PNG was being generated.
        where: {
          id: matchId,
          status: "scheduled",
          userA: { language: match.userA.language, theme: match.userA.theme },
          userB: { language: match.userB.language, theme: match.userB.theme },
        },
        data,
      })
      .catch((err) => {
        console.warn(`[date-card] file_id cache update failed for ${matchId}:`, err);
      });
  }

  // Founder ops feed: DM both date cards (male + female) as one media group.
  // The rendered PNG buffers ride back from `sendScheduledConfirmation` so the
  // founder bot can re-upload raw bytes (cross-bot file_ids don't transfer);
  // when the date-card feature is off it falls back to partner photos.
  // No-op unless FOUNDER_NOTIFY_ENABLED. Fire-and-forget.
  void notifyFounderDateScheduled({
    matchId,
    cardBufferA: resultA.cardBuffer,
    cardBufferB: resultB.cardBuffer,
    userA: {
      firstName: match.userA.firstName,
      age: match.userA.age,
      gender: match.userA.gender,
      city: match.userA.profile?.homeCity ?? null,
    },
    userB: {
      firstName: match.userB.firstName,
      age: match.userB.age,
      gender: match.userB.gender,
      city: match.userB.profile?.homeCity ?? null,
    },
    venue: { name: venue.name, address: venue.address },
    agreedTime: match.agreedTime,
    photoRefA: match.userB.profile?.photos?.[0] ?? null,
    photoRefB: match.userA.profile?.photos?.[0] ?? null,
  }).catch(() => {});
}

interface ScheduledConfirmationInput {
  telegramId: bigint;
  text: string;
  entity: MessageEntity;
  keyboard: InlineKeyboardMarkup;
  language: Language;
  /** Recipient's chosen theme — drives the card's light/dark chrome. */
  theme: CardTheme;
  matchId: string;
  /** The partner the recipient is meeting (shown on the card). */
  partnerFirstName: string;
  partnerPhotoRef: string | null;
  venue: Venue;
  agreedTime: Date;
}

/**
 * Send one side's `scheduled` confirmation. With `DATE_CARD_FEATURE_ENABLED`
 * we render a PNG date card and send it screenshot/forward-protected with a
 * Share button; the same `date_time`-entity caption + Maps/venue-change
 * keyboard ride along so all native affordances survive. Any render or send
 * failure degrades to the existing plain-text card so scheduling never wedges.
 */
async function sendScheduledConfirmation(
  api: Api<RawApi>,
  input: ScheduledConfirmationInput,
): Promise<{ fileId: string | null; cardBuffer: Buffer | null }> {
  if (!isTelegramTarget(input.telegramId)) return { fileId: null, cardBuffer: null };
  const chatId = Number(input.telegramId);

  if (env.DATE_CARD_FEATURE_ENABLED) {
    // The PNG render (partner-photo download + Places venue photo + satori→resvg
    // rasterize) is the one genuinely slow beat in finalization. Kick it off as
    // the real unit of work and broadcast a live "shine" status that is HELD
    // until the render actually resolves, so the chat never looks frozen. The
    // status is cosmetic — any failure inside it must not block the card.
    const renderWork = renderDateCard(
      {
        partnerFirstName: input.partnerFirstName,
        partnerPhotoRef: input.partnerPhotoRef,
        venueName: input.venue.name,
        venueAddress: input.venue.address,
        venuePhotoUrl: input.venue.photoUrl ?? null,
        venuePhotoName: input.venue.photoName ?? null,
        agreedTime: input.agreedTime,
        language: input.language,
        theme: input.theme,
      },
      { blur: false },
      api,
    );

    await runStatusSequence(api, chatId, dateCardSteps(input.language), {
      until: renderWork,
      rich: true,
    }).catch(() => undefined);

    const card = await renderWork;
    if (card) {
      const keyboard: InlineKeyboardMarkup = {
        inline_keyboard: [
          ...input.keyboard.inline_keyboard,
          [buildShareButton(input.matchId, input.language)],
        ],
      };
      try {
        const sent = await api.sendPhoto(chatId, new InputFile(card, "date-card.png"), {
          caption: input.text,
          caption_entities: [input.entity],
          reply_markup: keyboard,
          protect_content: true,
        });
        // Largest rendition's file_id — cached for instant re-open in the hub.
        // The buffer rides back too so the founder feed can re-upload it via
        // the founder bot (cross-bot file_ids don't transfer).
        return { fileId: sent.photo?.at(-1)?.file_id ?? null, cardBuffer: card };
      } catch (err) {
        console.warn(
          `[date-card] sendPhoto failed for ${chatId}, falling back to text:`,
          err,
        );
      }
    }
  }

  await api.sendMessage(chatId, input.text, {
    entities: [input.entity],
    reply_markup: input.keyboard,
  });
  return { fileId: null, cardBuffer: null };
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
