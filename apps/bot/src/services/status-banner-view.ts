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

  // The discrete countdown labels the primary button and — for non-English
  // locales — also leads the banner text. Telegram's pinned-message preview is a
  // single truncated line that never renders inline buttons, so the only way to
  // surface the remaining time "at the top" is inside the text itself. English's
  // short "Next drop: …" schedule line already fits that preview, so per an
  // explicit product decision en is left byte-for-byte as before; the longer
  // ru/uk/de/pl schedule lines pushed the time past the truncation, hiding it.
  const snap = computeStatusSnapshot({
    now: input.now,
    nextMatchAt: input.nextDropAt,
    isProcessing: input.isProcessing,
  });
  let countdown: string;
  switch (snap.phase) {
    case "processing":
      countdown = t(input.language, "statusButtonProcessing");
      break;
    case "days":
      countdown = t(input.language, "statusButtonDaysHours", {
        d: snap.days ?? 0,
        h: snap.hours ?? 0,
      });
      break;
    case "hours":
      countdown = t(input.language, "statusButtonHoursMinutes", {
        h: snap.hours ?? 0,
        m: snap.minutes ?? 0,
      });
      break;
    case "minutes":
      countdown = t(input.language, "statusButtonMinutes", {
        m: snap.minutes ?? 0,
      });
      break;
  }

  const lines: string[] = [];
  // Lead with the countdown so it survives the pinned preview's single-line
  // truncation on the longer locales (en keeps its original layout).
  if (input.language !== "en") lines.push(countdown, "");
  lines.push(
    "✦ GENNETY DROP",
    "",
    t(input.language, "statusBannerSchedule", { date, time }),
    t(input.language, "statusBannerActive"),
  );
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

  const view = {
    text: lines.join("\n"),
    buttonText: countdown,
    callbackData: "menu:open" as const,
    buttonStyle: "primary" as const,
  };
  return { ...view, signature: JSON.stringify(view) };
}
