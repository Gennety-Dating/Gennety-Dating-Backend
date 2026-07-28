import type { Language } from "@gennety/shared";
import type { StatusStep } from "./ai-stream.js";
import { AI_EMOJI } from "./ai-emoji.js";
import { buildScanFrames } from "./radar-scan-counter.js";

/**
 * The Type Radar "thinking state" sequence (`TYPE_RADAR_PRODUCT_SPEC.md`): the
 * ~10s status beat played in the chat the moment the radar Mini App closes,
 * between the user rating the deck and the next onboarding question landing.
 *
 * Four scripted beats (6200ms total), then a fifth whose profile counter climbs
 * on the deceleration curve in {@link file://./radar-scan-counter.ts} (~4.5s),
 * so the whole sequence averages ~10.7s. It is a deliberate "labor illusion":
 * unlike the venue / date-card / video-check statuses it tracks no real work and
 * is passed no `until` promise — the radar verdicts were already persisted
 * before this runs, and the matching it narrates does not happen until the
 * Thursday batch, days later.
 *
 * Copy lives here rather than in the shared i18n bundle, matching the existing
 * {@link file://./type-radar-copy.ts} precedent that keeps this feature-flagged
 * feature's strings self-contained.
 */

/**
 * How long the bot waits after answering `POST /v1/radar/submit` before the
 * first beat.
 *
 * MUST STAY IN SYNC with `CLOSE_DELAY` in `apps/webapp/src/radar/App.tsx`
 * (2100ms — the radar Mini App holds its ✓ screen that long before calling
 * `WebApp.close()`). The sequence plays in the chat, so starting it any earlier
 * would burn its opening beats behind a Mini App still covering the screen.
 * The extra 100ms is margin for the close animation. Same "webapp constant
 * mirrored bot-side" convention as `apps/webapp/src/tickets/store-state.ts`.
 */
export const RADAR_MINI_APP_CLOSE_LEAD_MS = 2200;

/** Hold times of the four scripted beats, in order (ms). */
export const RADAR_BEAT_HOLD_MS = [900, 1800, 2500, 1000] as const;

interface RadarThinkingCopy {
  /** "Checking your ratings" */
  step1: string;
  /** "Reading your preferences" */
  step2: string;
  /** "Looking for matches" */
  step3: string;
  /** "Running deep search" */
  step4: string;
  /** "Scanning profiles {n}" — carries the `{n}` placeholder. */
  scan: string;
}

/**
 * Each line leads with a plain emoji glyph, which `thinkingHtml` upgrades to the
 * animated AIActions `<tg-emoji>` on the rich path and leaves as-is otherwise —
 * this is the "modular emoji layer": swapping a step's icon is one edit to the
 * glyph here plus its `emojiId` below, with no change to timing or execution.
 */
const COPY: Record<Language, RadarThinkingCopy> = {
  en: {
    step1: "👀 Checking your ratings",
    step2: "🧠 Reading your preferences",
    step3: "💞 Looking for matches",
    step4: "🔎 Running deep search",
    scan: "💞 Scanning profiles {n}",
  },
  ru: {
    step1: "👀 Смотрю твои оценки",
    step2: "🧠 Считываю предпочтения",
    step3: "💞 Ищу подходящих людей",
    step4: "🔎 Включаю глубокий поиск",
    scan: "💞 Просматриваю профили {n}",
  },
  uk: {
    step1: "👀 Дивлюся твої оцінки",
    step2: "🧠 Зчитую вподобання",
    step3: "💞 Шукаю відповідних людей",
    step4: "🔎 Вмикаю глибокий пошук",
    scan: "💞 Переглядаю профілі {n}",
  },
  de: {
    step1: "👀 Sehe mir deine Bewertungen an",
    step2: "🧠 Lese deine Vorlieben aus",
    step3: "💞 Suche passende Leute",
    step4: "🔎 Starte die Tiefensuche",
    scan: "💞 Sichte Profile {n}",
  },
  pl: {
    step1: "👀 Sprawdzam twoje oceny",
    step2: "🧠 Odczytuję preferencje",
    step3: "💞 Szukam pasujących osób",
    step4: "🔎 Włączam głębokie wyszukiwanie",
    scan: "💞 Przeglądam profile {n}",
  },
};

function copyFor(lang: Language | null | undefined): RadarThinkingCopy {
  return COPY[(lang ?? "en") as Language] ?? COPY.en;
}

/**
 * Build the whole sequence as ordinary {@link StatusStep}s: the four scripted
 * beats, then one step per counter frame.
 *
 * Expanding the counter into steps is what keeps this feature free of a second
 * timer loop — `runStatusSequence` plays the result exactly like any other
 * status, so the rich `<tg-thinking>` shimmer, the classic `editMessageText`
 * fallback, the injectable `wait`, and the swallow-everything error handling all
 * come for free.
 *
 * @param lang the user's `User.language`; falls back to English.
 * @param rng  injectable `[0,1)` source for the counter curve (tests seed it).
 */
export function radarThinkingSteps(
  lang: Language | null | undefined,
  rng: () => number = Math.random,
): StatusStep[] {
  const copy = copyFor(lang);

  const beats: StatusStep[] = [
    { text: copy.step1, holdMs: RADAR_BEAT_HOLD_MS[0], emojiId: AI_EMOJI.scan },
    { text: copy.step2, holdMs: RADAR_BEAT_HOLD_MS[1], emojiId: AI_EMOJI.think },
    { text: copy.step3, holdMs: RADAR_BEAT_HOLD_MS[2], emojiId: AI_EMOJI.matching },
    { text: copy.step4, holdMs: RADAR_BEAT_HOLD_MS[3], emojiId: AI_EMOJI.scan },
  ];

  // One glyph across every counter frame: the frames are ~150–600ms apart, and
  // swapping the animated emoji per tick would read as flicker, not progress.
  const counter: StatusStep[] = buildScanFrames(rng).map((frame) => ({
    text: copy.scan.replace("{n}", String(frame.n)),
    holdMs: frame.holdMs,
    emojiId: AI_EMOJI.matching,
  }));

  return [...beats, ...counter];
}
