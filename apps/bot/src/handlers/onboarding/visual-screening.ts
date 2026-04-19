import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { t } from "@gennety/shared";
import { env } from "../../config.js";

/**
 * Visual screening carousel — used both during onboarding (now handled by
 * the conversational agent) and post-onboarding "Edit Visual Preferences".
 *
 * Placeholder photo pools per preference. In production these would come
 * from a curated dataset.
 */

const PHOTO_POOLS: Record<string, string[]> = {
  women: [
    "https://placekitten.com/400/400?image=1",
    "https://placekitten.com/400/400?image=2",
    "https://placekitten.com/400/400?image=3",
    "https://placekitten.com/400/400?image=4",
    "https://placekitten.com/400/400?image=5",
  ],
  men: [
    "https://placekitten.com/400/400?image=6",
    "https://placekitten.com/400/400?image=7",
    "https://placekitten.com/400/400?image=8",
    "https://placekitten.com/400/400?image=9",
    "https://placekitten.com/400/400?image=10",
  ],
  both: [
    "https://placekitten.com/400/400?image=1",
    "https://placekitten.com/400/400?image=6",
    "https://placekitten.com/400/400?image=2",
    "https://placekitten.com/400/400?image=7",
    "https://placekitten.com/400/400?image=3",
  ],
};

/** Build caption text and optional custom_emoji entities */
export function buildScreeningCaption(
  index: number,
  total: number,
): { text: string; entities?: undefined } {
  return { text: `👍 ${index + 1}/${total} 👎` };
}

/** Send the first photo in the carousel */
export async function startVisualScreening(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { preference: true },
  });
  const pref = user?.preference ?? "both";
  const photos = PHOTO_POOLS[pref] ?? PHOTO_POOLS.both!;

  const { text } = buildScreeningCaption(0, photos.length);
  const keyboard = new InlineKeyboard()
    .text("👍", `vs:like:0`)
    .text("👎", `vs:dislike:0`);

  await ctx.replyWithPhoto(photos[0]!, {
    caption: text,
    reply_markup: keyboard,
  });
}

/** Handle a vs:like/vs:dislike callback during the carousel */
export async function handleVisualScreening(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("vs:")) return;

  const parts = data.split(":");
  if (parts.length !== 3) return;
  const action = parts[1];
  const index = parseInt(parts[2]!, 10);

  if (action !== "like" && action !== "dislike") return;
  if (isNaN(index)) return;

  await ctx.answerCallbackQuery();

  ctx.session.visualVotes.push({ photoIndex: index, liked: action === "like" });

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, preference: true },
  });
  const pref = user?.preference ?? "both";
  const photos = PHOTO_POOLS[pref] ?? PHOTO_POOLS.both!;
  const nextIndex = index + 1;

  if (nextIndex >= photos.length) {
    // Screening complete — save preferences and reset
    if (user) {
      await prisma.profile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, visualPreferences: ctx.session.visualVotes },
        update: { visualPreferences: ctx.session.visualVotes },
      });
    }

    // If called from edit mode, return to menu
    if (ctx.session.menuState === "edit_visual_prefs") {
      ctx.session.menuState = "idle";
      ctx.session.visualVotes = [];
      const lang = ctx.session.language;
      await ctx.reply(t(lang, "editVisualDone"));
      return;
    }

    ctx.session.visualVotes = [];
    return;
  }

  // Send next photo
  const { text } = buildScreeningCaption(nextIndex, photos.length);
  const keyboard = new InlineKeyboard()
    .text("👍", `vs:like:${nextIndex}`)
    .text("👎", `vs:dislike:${nextIndex}`);

  await ctx.replyWithPhoto(photos[nextIndex]!, {
    caption: text,
    reply_markup: keyboard,
  });
}
