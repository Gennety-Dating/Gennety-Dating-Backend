import {
  MAX_PHOTOS,
  MIN_PHOTOS,
  PHOTO_BONUS_TICKET_THRESHOLD,
  t,
  type Language,
} from "@gennety/shared";

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

export function isPhotoStageContinueText(text: string): boolean {
  const normalized = text.trim().toLocaleLowerCase().replace(/[.!?]+$/gu, "");
  if (!normalized || normalized.length > 40) return false;

  return /^(?:continue|done|finish|next|that'?s enough|no more|дальше|продолжить|продолжаем|готово|хватит|достаточно|вс[её]|далі|продовжити|продовжуємо|досить|weiter|fertig|genug|dalej|kontynuuj|gotowe|wystarczy)$/iu.test(
    normalized,
  );
}
