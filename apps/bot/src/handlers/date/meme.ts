import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  memeRevealFeatureLive,
  resolveMemeSubject,
  memeAnswerFor,
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

  // `resolveMemeSubject` is the trust boundary: a stranger's match id, a match
  // that ended without a date, and a pair with a block between them all resolve
  // to nothing. Kept apart from the answer lookup below so each dead card says
  // the true thing — and this one says nothing about WHY, because the reason
  // may be a block the viewer must not learn about.
  const subject = await resolveMemeSubject(matchId, user.id);
  if (!subject) {
    await ctx.answerCallbackQuery({ text: t(lang, "memeRevealUnavailable") }).catch(() => {});
    await ctx.editMessageReplyMarkup({}).catch(() => {});
    return;
  }

  const meme = await memeAnswerFor(subject);
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
