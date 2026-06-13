import { InputFile } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { renderDateCard } from "../../services/date-card/index.js";

/**
 * `datecard:share:{matchId}` — the recipient asked for a shareable copy of
 * their date card (PRODUCT_SPEC.md §3.7).
 *
 * The private card is sent screenshot/forward-protected; this re-renders the
 * SAME card with the partner's face blurred and sends it WITHOUT
 * `protect_content`, so it can leave the platform without exposing the
 * partner's identity. If the blur/render can't be produced we never fall back
 * to a clear image — we surface a try-again notice instead.
 */
export async function handleDateCardShare(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("datecard:share:")) return;

  const matchId = data.slice("datecard:share:".length);
  const lang = ctx.session.language;

  // Feature flag is checked defensively (a button could linger after a flag
  // flip). Inert when off.
  if (!env.DATE_CARD_FEATURE_ENABLED || !matchId || !ctx.from) {
    await ctx.answerCallbackQuery();
    return;
  }

  const caller = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { id: true },
  });
  if (!caller) {
    await ctx.answerCallbackQuery();
    return;
  }

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      status: true,
      agreedTime: true,
      userAId: true,
      userBId: true,
      venueName: true,
      venueAddress: true,
      venuePhotoUrl: true,
      venuePhotoName: true,
      userA: { select: { firstName: true, profile: { select: { photos: true } } } },
      userB: { select: { firstName: true, profile: { select: { photos: true } } } },
    },
  });

  const isA = match?.userAId === caller.id;
  const isB = match?.userBId === caller.id;
  if (!match || match.status !== "scheduled" || !match.agreedTime || (!isA && !isB)) {
    await ctx.answerCallbackQuery();
    return;
  }

  // The recipient's card shows their *partner* (the other side).
  const partner = isA ? match.userB : match.userA;

  await ctx.answerCallbackQuery();

  const card = await renderDateCard(
    {
      partnerFirstName: partner.firstName ?? "",
      partnerPhotoRef: partner.profile?.photos?.[0] ?? null,
      venueName: match.venueName ?? "",
      venueAddress: match.venueAddress ?? "",
      venuePhotoUrl: match.venuePhotoUrl,
      venuePhotoName: match.venuePhotoName,
      agreedTime: match.agreedTime,
      language: lang as Language,
    },
    { blur: true },
    ctx.api,
  );

  if (!card) {
    await ctx.reply(t(lang, "dateCardShareFailed"));
    return;
  }

  await ctx.api.sendPhoto(ctx.from.id, new InputFile(card, "gennety-date.png"), {
    caption: t(lang, "dateCardShareCaption"),
  });
}
