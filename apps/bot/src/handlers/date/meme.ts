import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  memeRevealFeatureLive,
  partnerMemeForViewer,
  deliverMemeReveal,
} from "../../services/meme-reveal.js";
import { DEMO_MODE_ENABLED } from "../../demo/config.js";

/**
 * `meme:show:<matchId>` — the tap on the pre-date meme card.
 *
 * Nothing is charged, so this is the whole flow: resolve, reveal. What used to
 * live here — minting a Stars invoice, swapping the card's own button for a pay
 * button, checking an entitlement index so a reused invoice link could not
 * charge twice — went with the price.
 *
 * The card stays tappable afterwards on purpose. A second tap re-sends the
 * meme, which is what somebody tapping an old card actually wants, and there is
 * no longer any reason to prevent it.
 */
export async function handleMemeShow(ctx: BotContext): Promise<void> {
  const matchId = ctx.callbackQuery?.data?.split(":")[2];
  if (!matchId || !ctx.from) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from.id) },
    select: { id: true, language: true },
  });
  if (!user) {
    await ctx.answerCallbackQuery().catch(() => {});
    return;
  }
  const lang = (user.language ?? "en") as Language;

  if (!memeRevealFeatureLive() && !DEMO_MODE_ENABLED) {
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    return;
  }

  // `partnerMemeForViewer` is also the trust boundary: a match id from someone
  // who is not on that match resolves to nothing.
  const meme = await partnerMemeForViewer(matchId, user.id);
  if (!meme) {
    // The partner re-answered the humour question in words, which clears the
    // pointer and with it the consent that pointer represented. Strip the dead
    // button and say so rather than leaving a tap that does nothing.
    await ctx.answerCallbackQuery({ text: t(lang, "memeRevealGone") }).catch(() => {});
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    return;
  }

  await ctx.answerCallbackQuery().catch(() => {});
  if (ctx.chat) await deliverMemeReveal(ctx.api, ctx.chat.id, lang, meme);
}
