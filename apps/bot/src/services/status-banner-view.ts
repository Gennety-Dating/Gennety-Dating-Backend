import {
  computeStatusSnapshot,
  formatDateCountdownText,
  t,
  type Language,
} from "@gennety/shared";

const LANGUAGE_LOCALES: Record<Language, string> = {
  en: "en-US",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  pl: "pl-PL",
};

export interface StatusBannerUpcomingDate {
  at: Date;
  venueName?: string | null;
}

export interface StatusBannerViewInput {
  now: Date;
  nextDropAt: Date;
  isProcessing: boolean;
  language: Language;
  timeZone: string;
  upcomingDate?: StatusBannerUpcomingDate;
}

export interface StatusBannerView {
  text: string;
  buttonText: string;
  callbackData: "menu:open";
  buttonStyle: "primary";
  signature: string;
}

/** Build the complete Telegram render state, independent of grammY. */
export function renderStatusBanner(input: StatusBannerViewInput): StatusBannerView {
  const locale = LANGUAGE_LOCALES[input.language];
  const date = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: input.timeZone,
  }).format(input.nextDropAt);
  const time = new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: input.timeZone,
  }).format(input.nextDropAt);

  const lines = [
    "✦ GENNETY DROP",
    "",
    t(input.language, "statusBannerSchedule", { date, time }),
    t(input.language, "statusBannerActive"),
  ];
  if (input.upcomingDate) {
    lines.push(
      "",
      formatDateCountdownText(
        {
          now: input.now,
          dateAt: input.upcomingDate.at,
          venueName: input.upcomingDate.venueName ?? null,
        },
        input.language,
      ),
    );
  }

  const snap = computeStatusSnapshot({
    now: input.now,
    nextMatchAt: input.nextDropAt,
    isProcessing: input.isProcessing,
  });
  let buttonText: string;
  switch (snap.phase) {
    case "processing":
      buttonText = t(input.language, "statusButtonProcessing");
      break;
    case "days":
      buttonText = t(input.language, "statusButtonDaysHours", {
        d: snap.days ?? 0,
        h: snap.hours ?? 0,
      });
      break;
    case "hours":
      buttonText = t(input.language, "statusButtonHoursMinutes", {
        h: snap.hours ?? 0,
        m: snap.minutes ?? 0,
      });
      break;
    case "minutes":
      buttonText = t(input.language, "statusButtonMinutes", {
        m: snap.minutes ?? 0,
      });
      break;
  }

  const view = {
    text: lines.join("\n"),
    buttonText,
    callbackData: "menu:open" as const,
    buttonStyle: "primary" as const,
  };
  return { ...view, signature: JSON.stringify(view) };
}
