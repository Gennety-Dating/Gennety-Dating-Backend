import { computeStatusSnapshot, t, type Language } from "@gennety/shared";

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
 * Body + button for a live match.
 *
 * **The button carries the bare time and nothing else** (2026-07-30). Telegram's
 * collapsed pinned bar shows two things side by side: the first few words of the
 * body on the left, and the button as a badge on the right — and the badge is
 * itself truncated. A label inside it ("Time left to reply: 23h 39m") therefore
 * ate the badge's whole width and the actual number never rendered: users saw
 * "Your match is wai…" next to "⌛ Time left to r…", i.e. two truncated halves
 * of the same sentence and no timer at all.
 *
 * So the split is: the body's FIRST LINE names what is being counted and ends
 * with a colon, the badge holds only the digits. The pinned bar then reads as
 * one sentence — "Time left to reply:" ▸ "23h 39m". The drop mode is
 * deliberately left alone: its label is short enough to survive the badge, and
 * it reads fine today.
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
      // Ceil, matching `computeStatusSnapshot` — so this badge and the "My date"
      // menu row never disagree by a minute about the same date.
      const minutesToDate = Math.ceil(
        (stage.at.getTime() - input.now.getTime()) / 60_000,
      );
      return {
        text: lines.join("\n"),
        buttonText: formatBareCountdown(lang, minutesToDate),
        callbackData: "menu:date",
      };
    }
    case "decision":
      return {
        text: t(lang, "statusBannerDecision"),
        // Fed from `minutesLeftFromDispatch` (floor), the same value the pitch
        // keyboard's deadline button renders — so the two timers on screen show
        // the same number even though only one of them carries a label.
        buttonText: formatBareCountdown(lang, stage.minutesLeft),
        callbackData: "menu:date",
      };
    case "planning":
      return {
        text: t(lang, "statusBannerPlanning"),
        // No countdown exists here, so the badge is an action rather than a
        // status — repeating the body's own first line in it would be pure
        // duplication in the pinned bar.
        buttonText: t(lang, "statusButtonDateOpen"),
        callbackData: "menu:date",
      };
  }
}

/**
 * Digits only, no label and no emoji — see {@link renderStage} for why. Buckets
 * exactly like `computeStatusSnapshot` so the banner never disagrees with the
 * other surfaces rendering the same remaining time.
 */
function formatBareCountdown(lang: Language, totalMinutes: number): string {
  const safe = Math.max(totalMinutes, 0);
  const totalHours = Math.floor(safe / 60);
  const days = Math.floor(totalHours / 24);
  if (days >= 1) {
    return t(lang, "statusTimeDaysHours", { d: days, h: totalHours % 24 });
  }
  if (totalHours >= 1) {
    return t(lang, "statusTimeHoursMinutes", { h: totalHours, m: safe % 60 });
  }
  return t(lang, "statusTimeMinutes", { m: Math.max(1, safe) });
}
