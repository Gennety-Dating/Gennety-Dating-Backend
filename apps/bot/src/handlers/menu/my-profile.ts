import { InlineKeyboard, InputMediaBuilder } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { normalizeProfileMedia, t, escapeMd } from "@gennety/shared";
import { sendProfileMediaCard } from "../../services/profile-media-dispatch.js";

/** Shared profile rendering logic. */
async function renderMyProfile(ctx: BotContext): Promise<void> {
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { profile: true },
  });
  if (!user) {
    await ctx.reply(t(lang, "myProfileNoBio"));
    return;
  }

  const rawSummary =
    user.profile?.psychologicalSummary?.trim() || t(lang, "myProfileNoBio");

  const body = t(lang, "myProfileBody", {
    firstName: escapeMd(user.firstName ?? "—"),
    surname: escapeMd(user.surname ?? "—"),
    age: user.age ?? 0,
    university: escapeMd(user.universityDomain ?? "—"),
    language: (user.language ?? lang).toUpperCase(),
    summary: escapeMd(rawSummary),
  });

  // Telegram media groups accept 2–10 items; a single photo goes via replyWithPhoto.
  const photos = user.profile?.photos ?? [];
  const media = normalizeProfileMedia(user.profile?.profileMedia ?? [], photos);
  const hasLivePhoto = media.some((item) => item.type === "live_photo");
  if (hasLivePhoto && ctx.chat) {
    try {
      await sendProfileMediaCard(ctx.api, ctx.chat.id, media);
    } catch {
      // Stale file_ids — skip media and continue with text body.
    }
  } else if (photos.length === 1) {
    try {
      await ctx.replyWithPhoto(photos[0]!);
    } catch {
      // Stale file_id — skip photo and continue with text body.
    }
  } else if (photos.length >= 2) {
    try {
      await ctx.replyWithMediaGroup(
        photos.slice(0, 10).map((id) => InputMediaBuilder.photo(id)),
      );
    } catch {
      // Stale file_ids — skip photos and continue with text body.
    }
  }

  const keyboard = new InlineKeyboard().text(t(lang, "menuBack"), "menu:back");

  try {
    await ctx.reply(body, { parse_mode: "Markdown", reply_markup: keyboard });
  } catch {
    // Markdown parse failure — fall back to plain text
    await ctx.reply(body.replace(/[\\*_`\[]/g, ""), { reply_markup: keyboard });
  }
}

/** Render the user's generated bio as read-only text (callback entry). */
export async function handleMyProfile(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await renderMyProfile(ctx);
}

/** Render the user's profile (command entry — via /profile). */
export async function showMyProfile(ctx: BotContext): Promise<void> {
  await renderMyProfile(ctx);
}
