import { InlineKeyboard, InputMediaBuilder } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import { normalizeProfileMedia, profileMediaHasVideo, t, escapeMd } from "@gennety/shared";
import { sendProfileMediaCard } from "../../services/profile-media-dispatch.js";
import { env } from "../../config.js";

/**
 * Combined view + edit profile screen. Renders the profile the way a match
 * sees it (header + photos + details), then attaches the outcome-named edit
 * actions right below it — so there's no separate "Edit Profile" fork and the
 * buttons read as tasks ("About me", "Who I want") rather than DB fields.
 */
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

  // Framing line: this screen is the profile AS A MATCH SEES IT.
  await ctx.reply(t(lang, "myProfilePreviewHeader"));

  const rawSummary =
    user.profile?.psychologicalSummary?.trim() || t(lang, "myProfileNoBio");

  // Occupation is stored in the legacy `major` column (reframed as "what you
  // do"); it rides its own line only when set, so an empty field adds no
  // clutter. The line is data, not a label, so it needs no i18n.
  const occupationLine = user.major ? `💼 ${escapeMd(user.major)}\n` : "";

  // Registration v2: the 🎓 line is student-track flavor — a general (phone)
  // user has no universityDomain and gets no line instead of "🎓 —".
  const universityLine = user.universityDomain
    ? `🎓 ${escapeMd(user.universityDomain)}\n`
    : "";

  let body = t(lang, "myProfileBody", {
    firstName: escapeMd(user.firstName ?? "—"),
    surname: escapeMd(user.surname ?? "—"),
    age: user.age ?? 0,
    occupationLine,
    universityLine,
    language: (user.language ?? lang).toUpperCase(),
    summary: escapeMd(rawSummary),
  });

  // Telegram media groups accept 2–10 items; a single photo goes via replyWithPhoto.
  const photos = user.profile?.photos ?? [];
  const media = normalizeProfileMedia(user.profile?.profileMedia ?? [], photos);
  const hasLivePhoto = media.some((item) => item.type === "live_photo");
  const hasVideo = profileMediaHasVideo(media);

  // Nudge users with no profile video toward the always-visible menu entry, and
  // surface the free-ticket hook while the bonus is still claimable.
  if (!hasVideo) {
    const rewardAvailable =
      env.TICKET_FEATURE_ENABLED && !user.profile?.videoBonusTicketAt;
    body += `\n\n${t(lang, rewardAvailable ? "myProfileAddVideoHintReward" : "myProfileAddVideoHint")}`;
  }

  if ((hasLivePhoto || hasVideo) && ctx.chat) {
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

  // Outcome-named edit actions live right on the profile (view + edit merged).
  body += `\n\n${t(lang, "myProfileEditLabel")}`;
  const keyboard = new InlineKeyboard()
    .text(t(lang, "editBioBtn"), "menu:edit:bio")
    .text(t(lang, "editPrefsBtn"), "menu:edit:prefs")
    .row()
    .text(t(lang, "editMajorBtn"), "menu:edit:major")
    .text(t(lang, "editProfilePhotosBtn"), "menu:edit:photos")
    .row()
    .text(t(lang, "menuBack"), "menu:back");

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
