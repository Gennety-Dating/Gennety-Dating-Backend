import { InlineKeyboard } from "grammy";
import type { BotContext } from "../../session.js";
import { prisma } from "@gennety/db";
import {
  normalizeProfileMedia,
  profileMediaHasVideo,
  PROFILE_VIDEO_MAX_DURATION_SECONDS,
  PROFILE_VIDEO_MAX_FILE_SIZE_BYTES,
  t,
  type Language,
} from "@gennety/shared";
import { env } from "../../config.js";
import { showMainMenu } from "./main.js";
import {
  getMessageVideo,
  incomingVideoMedia,
} from "../../services/telegram-profile-media.js";
import { profileMediaToJson } from "../../services/profile-media-json.js";
import { prepareProfileVideo, videoSavedAck } from "../../services/profile-video.js";
import { grantVideoBonusIfEligible } from "../../services/ticket-wallet.js";
import { sendTicketRewardDM } from "../../services/ticket-reward.js";
import { logMediaValidationRejection } from "../../services/profile-media-validation/rejection-log.js";

const VIDEO_MAX_MB = Math.round(PROFILE_VIDEO_MAX_FILE_SIZE_BYTES / (1024 * 1024));

/** True when a video earns a free Date Ticket (feature on, bonus not yet claimed). */
function videoRewardAvailable(videoBonusTicketAt: Date | null): boolean {
  return env.TICKET_FEATURE_ENABLED && !videoBonusTicketAt;
}

/** Compose the localized profile-video screen copy for the current state. */
function videoScreenText(lang: Language, hasVideo: boolean, reward: boolean): string {
  const lines: string[] = [];
  if (hasVideo) lines.push(t(lang, "editVideoHasOne"));
  lines.push(
    t(lang, "editVideoPrompt", {
      sec: PROFILE_VIDEO_MAX_DURATION_SECONDS,
      mb: VIDEO_MAX_MB,
    }),
  );
  if (reward) lines.push(t(lang, "editVideoRewardLine"));
  return lines.join("\n\n");
}

/**
 * Enter the `edit_video` state and prompt for a profile video. Reachable from
 * the main-menu "🎬 Profile Video" button. Shows a Remove button when a video
 * already exists, and surfaces the free-ticket hint while the bonus is unclaimed.
 */
export async function handleEditVideoStart(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const profile = await prisma.profile.findFirst({
    where: { user: { telegramId } },
    select: { photos: true, profileMedia: true, videoBonusTicketAt: true },
  });
  const media = normalizeProfileMedia(profile?.profileMedia ?? [], profile?.photos ?? []);
  const hasVideo = profileMediaHasVideo(media);
  const reward = videoRewardAvailable(profile?.videoBonusTicketAt ?? null);

  ctx.session.menuState = "edit_video";

  const keyboard = new InlineKeyboard();
  if (hasVideo) keyboard.text(t(lang, "editVideoRemoveBtn"), "menu:video:remove").row();
  keyboard.text(t(lang, "menuBack"), "menu:back");

  await ctx.reply(videoScreenText(lang, hasVideo, reward), {
    parse_mode: "Markdown",
    reply_markup: keyboard,
  });
}

/**
 * Consume a message while `menuState === "edit_video"`. A `video` message is
 * validated (safety-only, display-only — never added to `photos[]`), persisted
 * to `Profile.profileMedia`, and earns the one-time video ticket bonus. Anything
 * that isn't a usable video re-prompts without leaving the state.
 */
export async function handleEditVideoUpload(ctx: BotContext): Promise<void> {
  if (!ctx.chat) return;
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const video = getMessageVideo(ctx.message);
  if (!video) {
    await ctx.reply(
      t(lang, "editVideoNotAVideo", {
        sec: PROFILE_VIDEO_MAX_DURATION_SECONDS,
        mb: VIDEO_MAX_MB,
      }),
      { parse_mode: "Markdown" },
    );
    return;
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      profile: { select: { photos: true, profileMedia: true } },
    },
  });
  if (!user) return;

  const extracted = incomingVideoMedia(video);
  if (!extracted.ok) {
    void logMediaValidationRejection({
      userId: user.id,
      mediaType: "video",
      reason: extracted.reason === "too_long" ? "video_too_long" : "video_too_large_to_check",
    });
    await ctx.reply(
      extracted.reason === "too_long" ? t(lang, "videoTooLong") : t(lang, "videoTooLarge"),
    );
    return;
  }

  const photos = user.profile?.photos ?? [];
  const existingMedia = normalizeProfileMedia(user.profile?.profileMedia ?? [], photos);
  const existingVideo = existingMedia.find((item) => item.type === "video");
  if (existingVideo?.video === extracted.media.video) {
    await ctx.reply(videoSavedAck(lang));
    return;
  }

  const prepared = await prepareProfileVideo({
    api: ctx.api,
    chatId: ctx.chat.id,
    userId: user.id,
    language: lang,
    media: extracted.media,
    profilePhotoRefs: photos,
    reply: (text) => ctx.reply(text),
  });
  if (prepared.kind === "rejected") return;

  // Video is display-only: photos[] and photoFaceScores stay untouched, so the
  // photos[i] ↔ photoFaceScores[i] invariant holds and no verification rerun is
  // needed (the video carries no identity gate).
  const nextMedia = [
    ...existingMedia.filter((item) => item.type !== "video"),
    prepared.media,
  ];
  await prisma.profile.update({
    where: { userId: user.id },
    data: { profileMedia: profileMediaToJson(normalizeProfileMedia(nextMedia, photos)) },
  });

  const res = await grantVideoBonusIfEligible(user.id);
  if (res.granted) {
    await sendTicketRewardDM(ctx.api, ctx.chat.id, lang, "video", res.balance);
  } else {
    await ctx.reply(videoSavedAck(lang));
  }

  ctx.session.menuState = "idle";
  await showMainMenu(ctx);
}

/** Remove the profile video. The one-time ticket bonus is not reversed. */
export async function handleEditVideoRemove(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  const lang = ctx.session.language;
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      profile: { select: { photos: true, profileMedia: true } },
    },
  });
  if (!user) return;

  const photos = user.profile?.photos ?? [];
  const existingMedia = normalizeProfileMedia(user.profile?.profileMedia ?? [], photos);
  if (profileMediaHasVideo(existingMedia)) {
    const nextMedia = existingMedia.filter((item) => item.type !== "video");
    await prisma.profile.update({
      where: { userId: user.id },
      data: { profileMedia: profileMediaToJson(normalizeProfileMedia(nextMedia, photos)) },
    });
  }

  ctx.session.menuState = "idle";
  await ctx.reply(t(lang, "editVideoRemoved"));
  await showMainMenu(ctx);
}
