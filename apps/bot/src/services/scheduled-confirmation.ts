/**
 * Shared `scheduled` confirmation delivery — the rich "your date is set" moment.
 *
 * Both venue-selection paths converge here once a match has been committed to
 * `scheduled` with its venue fields:
 *   - the legacy concierge finalizer (`handlers/matching/venue-negotiation.ts`
 *     → `finalizeVenue`), and
 *   - Venue Intent V2 (`services/venue-intent-v2.ts` →
 *     `selectAndFinalizeVenueIntentV2`).
 *
 * It lives in the service layer (not the handler) precisely so the V2 service
 * can call it without a `services → handlers` import cycle
 * (`venue-negotiation.ts` already imports the V2 service). It owns:
 *   - the grounded per-language venue blurb + busy-venue expectation-setter,
 *   - the structured `matchScheduled` text + tappable `date_time` entity,
 *   - the Maps / Change-venue keyboard,
 *   - the per-side date-card PNG render (or plain-text fallback),
 *   - the `dateCardFileId{A,B}` cache write, and
 *   - the founder ops-feed notification.
 *
 * It deliberately does NOT generate Wingman hints or commit the `scheduled`
 * transition — each caller does that around its own venue commit (so V2 is not
 * double-charged for wingman), then calls this once. Telegram-only: it no-ops
 * for non-Telegram (mobile) targets, which get their scheduled push from the
 * caller.
 */
import type { Api, RawApi } from "grammy";
import { InlineKeyboard, InputFile } from "grammy";
import type { InlineKeyboardMarkup, MessageEntity } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../config.js";
import { type Venue } from "./venue.js";
import { type VenueCategory } from "./vibe-parser.js";
import { generateVenueBlurb } from "./venue-blurb.js";
import { buildDateTimeEntity } from "./datetime-entity.js";
import { renderDateCard, buildShareButton, type CardTheme } from "./date-card/index.js";
import { notifyFounderDateScheduled } from "./founder-notify.js";
import {
  shouldOfferVenueChange,
  buildVenueChangeButton,
} from "../handlers/matching/venue-change.js";
import { isTelegramTarget } from "../utils/telegram-target.js";
import { runStatusSequence } from "./ai-stream.js";
import { dateCardSteps } from "./analysis-status.js";

export function buildScheduledMapsKeyboard(venue: Venue, lang: Language): InlineKeyboardMarkup {
  const url = buildVenueMapsUrl(venue);
  const kb = new InlineKeyboard().url(t(lang, "matchScheduledBtnOpenMaps"), url);
  return { inline_keyboard: kb.inline_keyboard };
}

export function buildVenueMapsUrl(venue: Venue): string {
  if (venue.googleMapsUri && /^https?:\/\//i.test(venue.googleMapsUri)) {
    return venue.googleMapsUri;
  }

  const query = [venue.name, venue.address].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
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

export interface DeliverScheduledConfirmationOptions {
  /** The chosen venue, carrying blurb-grounding facts + card imagery refs. */
  venue: Venue;
  /** Resolved venue category — drives the blurb + the busy-venue carve-out. */
  category: VenueCategory;
  /** Vibe keywords used to ground the blurb (empty = generic per-language line). */
  keywords: string[];
}

/**
 * Deliver the rich `scheduled` confirmation to both sides of an
 * already-committed (`status = scheduled`) match: grounded venue blurb,
 * structured `matchScheduled` block + `date_time` entity, Maps/Change-venue
 * keyboard, the per-side date-card PNG (feature-flagged; falls back to text),
 * the `dateCardFileId{A,B}` cache write, and the founder ops-feed DM.
 *
 * Idempotency + the `scheduled` commit are the CALLER's responsibility — this
 * runs exactly once after a successful commit and never re-guards the status.
 * Non-Telegram participants are skipped here (they get their push upstream).
 */
export async function deliverScheduledConfirmation(
  api: Api<RawApi>,
  matchId: string,
  { venue, category, keywords }: DeliverScheduledConfirmationOptions,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      agreedTime: true,
      userA: {
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
  if (!match || !match.agreedTime) return;

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;
  // Each side's date card renders in that recipient's chosen theme.
  const themeA: CardTheme = match.userA.theme === "light" ? "light" : "dark";
  const themeB: CardTheme = match.userB.theme === "light" ? "light" : "dark";

  // Grounded, per-language venue blurb (PRODUCT_SPEC §3.7): a short "what is
  // this place" line built ONLY from real facts (Google editorial summary /
  // rating / category + the vibe both asked for). It replaces the inlined Maps
  // URL — the deep-link already rides the "Open in Maps" keyboard button below,
  // so the body no longer duplicates it. Failsafe: each side degrades to a
  // generic line, so a blurb hiccup never blocks scheduling.
  const [blurbA, blurbB] = await Promise.all([
    generateVenueBlurb({ venue, category, keywords, language: langA }),
    generateVenueBlurb({ venue, category, keywords, language: langB }),
  ]);

  // Structured block: 📍 name / full address / blurb. The localized header and
  // the trailing `date_time` entity (added by `buildDateTimeEntity`) wrap it.
  let venueBlockA = `📍 ${venue.name}\n${venue.address}\n${blurbA}`;
  let venueBlockB = `📍 ${venue.name}\n${venue.address}\n${blurbB}`;

  // Expectation-setter: we never book a table, so at a busy slot a *seated* spot
  // can be full on arrival. Warn both sides once, on the card that names the
  // venue, and tell them how to handle it. Skipped for park/museum, where "no
  // table" is a non-issue — mirrors the venue price-gate's carve-out. Plain
  // text: the scheduled card is sent without `parse_mode`, so no Markdown here.
  if (category !== "park" && category !== "museum") {
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
