import { InlineKeyboard, InputFile, InputMediaBuilder } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { env } from "../../config.js";
import {
  findActiveMatchForTelegramId,
  type ActiveMatchResult,
} from "../../services/active-match.js";
import { buildDateTimeEntity } from "../../services/datetime-entity.js";
import {
  renderDateCard,
  buildShareButton,
  type CardTheme,
} from "../../services/date-card/index.js";
import { dateCardSteps } from "../../services/analysis-status.js";
import { runStatusSequence } from "../../services/ai-stream.js";
import { isProxyOpen } from "../../services/coordination.js";
import { evaluateVenueBoardEligibility } from "../../services/venue-change.js";
import {
  shouldOfferVenueChange,
  buildVenueChangeButton,
} from "../matching/venue-change.js";

/**
 * "My date" hub (`menu:date`). The conditional main-menu row opens this screen
 * whenever the user has a live match. For a `scheduled` date it re-surfaces the
 * whole date — the partner's card (re-sent instantly from the cached file_id,
 * or re-rendered on demand), venue + map, the localized date phrase, ice-breakers
 * — plus every still-relevant action (change venue, share, enter coordination
 * chat, cancel, report). For the earlier planning stages it re-surfaces the one
 * Mini App entry the user might have lost above in the chat.
 *
 * Every action button reuses an existing callback/handler; the date/matching
 * routers run before the menu router in `bot.ts`, so they are already live from
 * a hub keyboard. Nothing here commits a new product mechanic.
 */
export async function handleMyDate(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const active = await findActiveMatchForTelegramId(BigInt(ctx.from!.id));
  if (!active) {
    await ctx.reply(t(lang, "dateHubNoActive"));
    return;
  }

  if (active.match.status === "scheduled" && active.match.venueName && active.match.agreedTime) {
    await renderScheduledHub(ctx, active);
    return;
  }
  await renderPlanningHub(ctx, active);
}

// ── Scheduled hub ───────────────────────────────────────────────────────────

async function renderScheduledHub(ctx: BotContext, active: ActiveMatchResult): Promise<void> {
  const lang = ctx.session.language;
  const { match, side } = active;
  const caption = buildScheduledCaption(lang, active);
  const keyboard = buildDateHubKeyboard(active, lang, new Date());

  const cachedFileId = side === "A" ? match.dateCardFileIdA : match.dateCardFileIdB;

  let cardSent = false;
  if (cachedFileId) {
    try {
      await ctx.replyWithPhoto(cachedFileId, {
        caption: caption.text,
        caption_entities: [caption.entity],
        reply_markup: keyboard,
        protect_content: true,
      });
      cardSent = true;
    } catch {
      // Stale cached file_id — fall through to a fresh render / plain fallback.
    }
  }

  if (!cardSent && env.DATE_CARD_FEATURE_ENABLED) {
    cardSent = await renderAndSendCard(ctx, active, caption, keyboard);
  }

  if (!cardSent) {
    await sendFallbackCard(ctx, active, caption, keyboard);
  }
}

interface Caption {
  text: string;
  entity: ReturnType<typeof buildDateTimeEntity>["entity"];
}

/** Header + venue block wrapped with the tappable `date_time` phrase. */
function buildScheduledCaption(lang: Language, active: ActiveMatchResult): Caption {
  const { match, partner } = active;
  const header = t(lang, "dateHubHeaderScheduled", { name: partner.firstName ?? "" });
  const base = `${header}\n\n📍 ${match.venueName}\n${match.venueAddress ?? ""}`.trimEnd();
  return buildDateTimeEntity(base, match.agreedTime!, lang);
}

/**
 * Re-render the partner date card and send it, caching the resulting Telegram
 * `file_id` so the next hub open is instant. Returns `false` on any render/send
 * failure so the caller degrades to the plain fallback.
 */
async function renderAndSendCard(
  ctx: BotContext,
  active: ActiveMatchResult,
  caption: Caption,
  keyboard: InlineKeyboardMarkup,
): Promise<boolean> {
  const lang = ctx.session.language;
  const chatId = ctx.chat?.id;
  if (chatId == null) return false;
  const { match, side, partner, self } = active;
  const theme: CardTheme = self.theme === "light" ? "light" : "dark";

  const renderWork = renderDateCard(
    {
      partnerFirstName: partner.firstName ?? "",
      partnerPhotoRef: partner.photos[0] ?? null,
      venueName: match.venueName!,
      venueAddress: match.venueAddress ?? "",
      venuePhotoUrl: match.venuePhotoUrl,
      venuePhotoName: match.venuePhotoName,
      agreedTime: match.agreedTime!,
      language: lang,
      theme,
    },
    { blur: false },
    ctx.api,
  );

  // Held "shine" status while the multi-second render runs (same primitive as
  // the scheduled-DM path). Purely cosmetic — never blocks the card.
  await runStatusSequence(ctx.api, chatId, dateCardSteps(lang), {
    until: renderWork,
    rich: true,
  }).catch(() => undefined);

  const card = await renderWork;
  if (!card) return false;

  let message;
  try {
    message = await ctx.replyWithPhoto(new InputFile(card, "date-card.png"), {
      caption: caption.text,
      caption_entities: [caption.entity],
      reply_markup: keyboard,
      protect_content: true,
    });
  } catch (err) {
    console.warn("[my-date] date-card send failed, falling back to text:", err);
    return false;
  }

  const fileId = message.photo?.at(-1)?.file_id ?? null;
  if (fileId) {
    await prisma.match
      .update({
        where: { id: match.id },
        data: side === "A" ? { dateCardFileIdA: fileId } : { dateCardFileIdB: fileId },
      })
      .catch(() => undefined);
  }
  return true;
}

/**
 * No rendered card available (feature off, or render failed): show the partner's
 * protected photos + the same venue/time text so the hub still works end-to-end.
 */
async function sendFallbackCard(
  ctx: BotContext,
  active: ActiveMatchResult,
  caption: Caption,
  keyboard: InlineKeyboardMarkup,
): Promise<void> {
  const photos = active.partner.photos;
  if (ctx.chat) {
    try {
      if (photos.length === 1) {
        await ctx.replyWithPhoto(photos[0]!, { protect_content: true });
      } else if (photos.length >= 2) {
        await ctx.replyWithMediaGroup(
          photos.slice(0, 10).map((id) => InputMediaBuilder.photo(id)),
          { protect_content: true },
        );
      }
    } catch {
      // Stale file_ids — skip media, still send the text card below.
    }
  }
  await ctx.reply(caption.text, {
    entities: [caption.entity],
    reply_markup: keyboard,
  });
}

/** All still-relevant actions for a scheduled date, reusing existing callbacks. */
function buildDateHubKeyboard(
  active: ActiveMatchResult,
  lang: Language,
  now: Date,
): InlineKeyboardMarkup {
  const { match, side, partner, self } = active;
  const kb = new InlineKeyboard();

  kb.url(t(lang, "matchScheduledBtnOpenMaps"), buildMapsUrl(match)).row();

  // Change venue — only while the paid board is open (same T-5h cutoff the
  // scheduled card uses). Reconstruct A/B ids from side + participants.
  const userAId = side === "A" ? self.id : partner.id;
  const userBId = side === "A" ? partner.id : self.id;
  if (
    shouldOfferVenueChange() &&
    evaluateVenueBoardEligibility({
      featureEnabled: env.VENUE_CHANGE_FEATURE_ENABLED,
      status: match.status,
      callerUserId: self.id,
      userAId,
      userBId,
      agreedTime: match.agreedTime,
      venueLat: match.venueLat,
      venueLng: match.venueLng,
      venueChangeStatus: match.venueChangeStatus,
      now,
    }).ok
  ) {
    kb.add(buildVenueChangeButton(match.id, lang)).row();
  }

  // Share the (blurred) card off-platform — only meaningful when a card exists.
  if (env.DATE_CARD_FEATURE_ENABLED) {
    kb.add(buildShareButton(match.id, lang)).row();
  }

  // Enter the anonymous coordination chat while its window is open (T-30m…T+2h).
  if (env.COORDINATION_FEATURE_ENABLED && isProxyOpen(match, now)) {
    kb.text(t(lang, "coordEnterBtn"), `coord:enter:${match.id}`).row();
  }

  // Cancel is available for the whole scheduled window (the emergency handler
  // guards the actual state change behind its own two-step red confirmation).
  kb.text(t(lang, "emergencyBtn"), `emerg:start:${match.id}`).danger().row();
  kb.text(t(lang, "reportBtn"), `report:open:${match.id}`).row();
  kb.text(t(lang, "menuBack"), "menu:back");

  return { inline_keyboard: kb.inline_keyboard };
}

function buildMapsUrl(match: ActiveMatchResult["match"]): string {
  if (match.venueGoogleMapsUri && /^https?:\/\//i.test(match.venueGoogleMapsUri)) {
    return match.venueGoogleMapsUri;
  }
  const query = [match.venueName, match.venueAddress].filter(Boolean).join(", ");
  return `https://maps.google.com/?q=${encodeURIComponent(query)}`;
}

// ── Planning hub (proposed / negotiating / negotiating_venue) ────────────────

/**
 * Lightweight card for the pre-scheduled stages: the partner's name, a
 * stage-aware line, and — where the entry point is unambiguous — the one Mini
 * App button the user might have lost in the chat. The calendar button is
 * suppressed while the Date Ticket gate is still open (the standalone,
 * re-openable ticket card is the correct entry there, not the calendar).
 */
async function renderPlanningHub(ctx: BotContext, active: ActiveMatchResult): Promise<void> {
  const lang = ctx.session.language;
  const { match, partner } = active;
  const name = partner.firstName ?? "";
  const kb = new InlineKeyboard();

  let text: string;
  if (match.status === "negotiating_venue") {
    text = t(lang, "dateHubPlanningVenue", { name });
    kb.webApp(
      t(lang, "venueConciergeBtnMap"),
      `${env.WEBAPP_URL}/location.html?match=${match.id}&lang=${lang}`,
    ).row();
  } else if (match.status === "negotiating") {
    text = t(lang, "dateHubPlanningNegotiating", { name });
    const ticketGateOpen =
      env.TICKET_FEATURE_ENABLED &&
      match.ticketStatus != null &&
      match.ticketStatus !== "completed";
    if (!ticketGateOpen) {
      kb.webApp(
        t(lang, "matchScheduleBtnCalendar"),
        `${env.WEBAPP_URL}?match=${match.id}&lang=${lang}`,
      ).row();
    }
  } else {
    // proposed — the decision flows conversationally; no Mini App to re-open.
    text = t(lang, "dateHubPlanningProposed", { name });
  }

  kb.text(t(lang, "reportBtn"), `report:open:${match.id}`).row();
  kb.text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(text, { reply_markup: { inline_keyboard: kb.inline_keyboard } });
}
