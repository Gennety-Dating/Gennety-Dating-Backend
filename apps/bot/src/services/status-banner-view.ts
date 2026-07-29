import {
  computeStatusSnapshot,
  formatDateCountdownText,
  t,
  type Language,
} from "@gennety/shared";
import { renderCountdownButtonLabel } from "../utils/countdown-plate.js";

const LANGUAGE_LOCALES: Record<Language, string> = {
  en: "en-US",
  ru: "ru-RU",
  uk: "uk-UA",
  de: "de-DE",
  pl: "pl-PL",
};

/**
 * The stage of the caller's single live match, when they have one
 * (PRODUCT_SPEC §2.1). A user occupying a live-match slot is excluded from the
 * weekly batch (§3.2 filter 8), so the next-drop countdown would be a promise
 * we can't keep — the banner counts down whatever is actually next for them.
 *
 * Resolved from the match row by `resolveBannerStage` (workers/status-timer.ts),
 * which also decides when NO stage applies and the drop countdown is right
 * again (a date that already happened, a proposal past its TTL).
 */
export type StatusBannerStage =
  /** `scheduled`, still in the future — count down to the date itself. */
  | { kind: "date"; at: Date; venueName: string | null }
  /** `proposed`, this side hasn't answered — count down their reply window. */
  | { kind: "decision"; minutesLeft: number }
  /** Any other live match: nothing to count, the date is being arranged. */
  | { kind: "planning" };

export interface StatusBannerViewInput {
  now: Date;
  nextDropAt: Date;
  isProcessing: boolean;
  language: Language;
  timeZone: string;
  stage?: StatusBannerStage;
  /**
   * Set for an account registered in a city Gennety hasn't launched
   * (PRODUCT_SPEC §1.1). Matching is same-city, so counting down to a drop
   * they cannot be in is a promise we can't keep — the banner says so instead.
   */
  marketPending?: { city: string | null };
}

export interface StatusBannerView {
  text: string;
  buttonText: string;
  /** `menu:date` opens the My Date hub; the stage modes point there. */
  callbackData: "menu:open" | "menu:date";
  buttonStyle: "primary";
  signature: string;
}

/** Build the complete Telegram render state, independent of grammY. */
export function renderStatusBanner(input: StatusBannerViewInput): StatusBannerView {
  // Market-pending accounts get no drop countdown at all: they are not in the
  // pool, and there is no upcoming date to show either (a live match is
  // impossible without a same-city partner). The button still opens the menu —
  // that is where the switch-to-a-launched-market row lives.
  if (input.marketPending) {
    const view = {
      text: [
        "✦ GENNETY",
        "",
        t(input.language, "statusBannerMarketPending", {
          city: input.marketPending.city ?? "",
        }),
      ].join("\n"),
      buttonText: t(input.language, "statusButtonMenu"),
      callbackData: "menu:open" as const,
      buttonStyle: "primary" as const,
    };
    return { ...view, signature: JSON.stringify(view) };
  }

  // A live match owns the banner: the countdown rides the button (Telegram
  // renders it as its own block in the pinned message) and the body is a
  // heading naming what that countdown is for.
  if (input.stage) {
    const view = { ...renderStage(input.stage, input), buttonStyle: "primary" as const };
    return { ...view, signature: JSON.stringify(view) };
  }

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

  // The discrete countdown labels the primary button only. It is deliberately
  // NOT repeated inside the banner text (product decision): the live remaining
  // time is already surfaced on the inline button, so duplicating it in the body
  // is redundant.
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

  const view = {
    text: [
      "✦ GENNETY DROP",
      "",
      t(input.language, "statusBannerSchedule", { date, time }),
      "",
      t(input.language, "statusBannerActive"),
    ].join("\n"),
    buttonText: countdown,
    callbackData: "menu:open" as const,
    buttonStyle: "primary" as const,
  };
  return { ...view, signature: JSON.stringify(view) };
}

/**
 * Body + button for a live match. Every button label reuses an existing
 * localized renderer, so nothing here invents a second countdown format:
 * the decision label is byte-identical to the pitch keyboard's own deadline
 * button (both go through `renderCountdownButtonLabel`), and the date label
 * reuses the same `statusDate*` phrasing the My Date menu row shows.
 */
function renderStage(
  stage: StatusBannerStage,
  input: StatusBannerViewInput,
): Omit<StatusBannerView, "buttonStyle" | "signature"> {
  const lang = input.language;
  switch (stage.kind) {
    case "date": {
      const lines = [t(lang, "statusBannerDate")];
      // The venue is a proper noun — no i18n key, same as
      // `formatDateCountdownText` appending it verbatim.
      const venue = stage.venueName?.trim();
      if (venue) lines.push("", `📍 ${venue}`);
      return {
        text: lines.join("\n"),
        buttonText: formatDateCountdownText(
          { now: input.now, dateAt: stage.at, venueName: null },
          lang,
        ),
        callbackData: "menu:date",
      };
    }
    case "decision":
      return {
        text: t(lang, "statusBannerDecision"),
        buttonText: renderCountdownButtonLabel(lang, stage.minutesLeft),
        callbackData: "menu:date",
      };
    case "planning":
      return {
        text: t(lang, "statusBannerPlanning"),
        // The main-menu "My date" row already labels every pre-scheduled stage
        // this way; reusing the key keeps the two surfaces from drifting.
        buttonText: t(lang, "menuMyDatePlanning"),
        callbackData: "menu:date",
      };
  }
}
