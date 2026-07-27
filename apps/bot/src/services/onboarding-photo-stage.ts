import { InlineKeyboard, type Api } from "grammy";
import {
  MAX_PHOTOS,
  MIN_PHOTOS,
  PHOTO_BONUS_TICKET_THRESHOLD,
  normalizeProfileMedia,
  profileMediaHasVideo,
  t,
  type Language,
  type SessionData,
} from "@gennety/shared";
import { recordOnboardingAssistantReply } from "./onboarding-agent.js";
import { photoStagePanelSync } from "./photo-stage-panel.js";

export const ONBOARDING_PHOTOS_CONTINUE_CALLBACK = "onboarding:photos:continue";

export function onboardingPhotoStageText(args: {
  language: Language;
  photoCount: number;
  ticketFeatureEnabled: boolean;
  hasVideo: boolean;
}): string {
  const { language, ticketFeatureEnabled, hasVideo } = args;
  const photoCount = Math.max(0, Math.min(args.photoCount, MAX_PHOTOS));

  if (photoCount < MIN_PHOTOS) {
    return t(language, "onboardingPhotosNeedMore", {
      count: photoCount,
      min: MIN_PHOTOS,
      remaining: MIN_PHOTOS - photoCount,
    });
  }

  if (!ticketFeatureEnabled) {
    const atPhotoLimit = photoCount >= MAX_PHOTOS;
    return t(
      language,
      atPhotoLimit
        ? hasVideo
          ? "onboardingPhotosOptionalMaxAfterVideo"
          : "onboardingPhotosOptionalMax"
        : hasVideo
          ? "onboardingPhotosOptionalAfterVideo"
          : "onboardingPhotosOptional",
      {
        count: photoCount,
        max: MAX_PHOTOS,
      },
    );
  }

  if (photoCount < PHOTO_BONUS_TICKET_THRESHOLD) {
    const initialOffer = photoCount === MIN_PHOTOS;
    return t(
      language,
      hasVideo
        ? initialOffer
          ? "onboardingPhotosBonusOfferAfterVideo"
          : "onboardingPhotosBonusProgressAfterVideo"
        : initialOffer
          ? "onboardingPhotosBonusOffer"
          : "onboardingPhotosBonusProgress",
      {
        count: photoCount,
        remaining: PHOTO_BONUS_TICKET_THRESHOLD - photoCount,
        threshold: PHOTO_BONUS_TICKET_THRESHOLD,
      },
    );
  }

  const atPhotoLimit = photoCount >= MAX_PHOTOS;
  return t(
    language,
    atPhotoLimit
      ? hasVideo
        ? "onboardingPhotosBothBonusesEarnedMax"
        : "onboardingPhotosPhotoBonusEarnedMax"
      : hasVideo
        ? "onboardingPhotosBothBonusesEarned"
        : "onboardingPhotosPhotoBonusEarned",
    {
      count: photoCount,
      max: MAX_PHOTOS,
    },
  );
}

export function sessionHasProfileVideo(session: SessionData): boolean {
  return profileMediaHasVideo(
    normalizeProfileMedia(session.pendingProfileMedia, session.pendingPhotos),
  );
}

/**
 * Send the upload stage's progress message: how many photos are on file (or
 * how many are still missing), the inline Continue once the minimum is met,
 * and the persistent bottom panel that opens the photo editor.
 *
 * This is the ONE place the panel is attached, which is what makes its
 * lifecycle tractable — every branch of the burst flush, the text handler, and
 * the video handler funnel through here. Teardown rides the next outgoing
 * message instead (see `services/photo-stage-panel.ts`).
 *
 * `session` is mutated (the panel arms its teardown flag), so the caller owns
 * persisting it: the live `ctx.session` is written back by grammY, while the
 * debounced burst flush upserts its own `bot_sessions` row.
 */
export async function sendPhotoStagePrompt(
  api: Api,
  chatId: number,
  telegramId: bigint,
  session: SessionData,
  photoCount: number,
  hasVideo: boolean,
  ticketFeatureEnabled: boolean,
): Promise<void> {
  const language = session.language;
  const text = onboardingPhotoStageText({
    language,
    photoCount,
    ticketFeatureEnabled,
    hasVideo,
  });
  await recordOnboardingAssistantReply(telegramId, text);

  if (photoCount < MIN_PHOTOS) {
    // Plain text, so it is free to carry the bottom panel.
    await api.sendMessage(chatId, text, photoStagePanelSync(session));
    return;
  }

  // Telegram allows exactly ONE `reply_markup` per message, so the inline
  // Continue wins here. Nothing is lost: a reply keyboard is chat-level and
  // persists from whichever message first carried it until it is explicitly
  // removed — and the stage always opens with the agent's plain-text photo
  // request, which is where the panel actually attaches.
  await api.sendMessage(chatId, text, {
    reply_markup: new InlineKeyboard().text(
      t(language, "btnContinuePhotos"),
      ONBOARDING_PHOTOS_CONTINUE_CALLBACK,
    ),
  });
}

export function isPhotoStageContinueText(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase().replace(/[.!?]+$/gu, "");
  if (!normalized || normalized.length > 40) return false;

  return /^(?:continue|done|finish|next|that'?s enough|no more|дальше|продолжить|продолжаем|готово|хватит|достаточно|вс[её]|далі|продовжити|продовжуємо|досить|weiter|fertig|genug|dalej|kontynuuj|gotowe|wystarczy)$/iu.test(
    normalized,
  );
}
