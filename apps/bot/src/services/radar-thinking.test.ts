import { describe, expect, it } from "vitest";
import { SUPPORTED_LANGUAGES, type Language } from "@gennety/shared";
import { AI_EMOJI } from "./ai-emoji.js";
import {
  radarThinkingSteps,
  RADAR_BEAT_HOLD_MS,
  RADAR_MINI_APP_CLOSE_LEAD_MS,
} from "./radar-thinking.js";

/** mulberry32 — deterministic PRNG so a sequence is reproducible in tests. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BEATS = RADAR_BEAT_HOLD_MS.length;

describe("radarThinkingSteps — scripted beats", () => {
  it("opens on the spec's 900 / 1800 / 2500 / 1000 cadence", () => {
    const steps = radarThinkingSteps("ru", seeded(1));
    expect(steps.slice(0, BEATS).map((s) => s.holdMs)).toEqual([900, 1800, 2500, 1000]);
  });

  it("carries one AI glyph per beat, and holds a single glyph across the counter", () => {
    const steps = radarThinkingSteps("en", seeded(1));

    expect(steps.slice(0, BEATS).map((s) => s.emojiId)).toEqual([
      AI_EMOJI.scan,
      AI_EMOJI.think,
      AI_EMOJI.matching,
      AI_EMOJI.scan,
    ]);
    // Swapping the animated emoji every ~150–600ms would read as flicker.
    const counter = steps.slice(BEATS);
    expect(counter.every((s) => s.emojiId === AI_EMOJI.matching)).toBe(true);
  });

  it("leads every line with a plain glyph so `thinkingHtml` can upgrade it", () => {
    // The emoji layer is text-driven: `thinkingHtml` only swaps in <tg-emoji>
    // when the label starts with a plain emoji + whitespace.
    for (const step of radarThinkingSteps("uk", seeded(3))) {
      expect(step.text).toMatch(/^\p{Extended_Pictographic}️?\s+\S/u);
    }
  });
});

describe("radarThinkingSteps — copy", () => {
  it("ships every supported language, with no untranslated fallthrough", () => {
    const seen = new Map<Language, string>();
    for (const lang of SUPPORTED_LANGUAGES) {
      const steps = radarThinkingSteps(lang, seeded(7));
      expect(steps).toHaveLength(radarThinkingSteps("en", seeded(7)).length);
      seen.set(lang, steps.slice(0, BEATS).map((s) => s.text).join("|"));
    }
    // Five distinct translations — a copy/paste of the English block would
    // silently ship English to a Polish user.
    expect(new Set(seen.values()).size).toBe(SUPPORTED_LANGUAGES.length);
  });

  it("uses the specified ru / uk / en wording verbatim", () => {
    const texts = (lang: Language) =>
      radarThinkingSteps(lang, seeded(5)).slice(0, BEATS).map((s) => s.text);

    expect(texts("en")).toEqual([
      "👀 Checking your ratings",
      "🧠 Reading your preferences",
      "💞 Looking for matches",
      "🔎 Running deep search",
    ]);
    expect(texts("ru")).toEqual([
      "👀 Смотрю твои оценки",
      "🧠 Считываю предпочтения",
      "💞 Ищу подходящих людей",
      "🔎 Включаю глубокий поиск",
    ]);
    expect(texts("uk")).toEqual([
      "👀 Дивлюся твої оцінки",
      "🧠 Зчитую вподобання",
      "💞 Шукаю відповідних людей",
      "🔎 Вмикаю глибокий пошук",
    ]);
  });

  it("falls back to English for a null/unknown language", () => {
    const en = radarThinkingSteps("en", seeded(9)).map((s) => s.text);
    expect(radarThinkingSteps(null, seeded(9)).map((s) => s.text)).toEqual(en);
    expect(radarThinkingSteps(undefined, seeded(9)).map((s) => s.text)).toEqual(en);
    expect(radarThinkingSteps("xx" as Language, seeded(9)).map((s) => s.text)).toEqual(en);
  });
});

describe("radarThinkingSteps — counter beat", () => {
  it("interpolates the number into every frame and leaves no placeholder behind", () => {
    for (const lang of SUPPORTED_LANGUAGES) {
      const counter = radarThinkingSteps(lang, seeded(11)).slice(BEATS);
      expect(counter.length).toBeGreaterThan(5);
      for (const step of counter) {
        expect(step.text).not.toContain("{n}");
        expect(step.text).toMatch(/\d+/);
      }
    }
  });

  it("renders the counter's own numbers, ascending, ending on the total", () => {
    const counter = radarThinkingSteps("en", seeded(13)).slice(BEATS);
    const numbers = counter.map((s) => Number(s.text.match(/(\d+)/)![1]));

    for (let i = 1; i < numbers.length; i++) {
      expect(numbers[i]!).toBeGreaterThan(numbers[i - 1]!);
    }
    expect(numbers[0]).toBeGreaterThanOrEqual(3);
    expect(numbers[0]).toBeLessThanOrEqual(6);
    expect(numbers[numbers.length - 1]).toBeGreaterThanOrEqual(160);
    expect(numbers[numbers.length - 1]).toBeLessThanOrEqual(220);
  });
});

describe("radarThinkingSteps — total budget", () => {
  it("runs ~10.7s on average, and never long enough to feel stuck", () => {
    const totals = Array.from({ length: 200 }, (_, i) =>
      radarThinkingSteps("ru", seeded(i + 1)).reduce((sum, s) => sum + s.holdMs, 0),
    );
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;

    // Scripted beats are a fixed 6200ms; the counter contributes ~4.5s.
    expect(mean).toBeGreaterThan(10_000);
    expect(mean).toBeLessThan(11_500);
    // Hard ceiling — the user is blocked from their next onboarding step for
    // this whole time, on top of the Mini App close lead-in.
    expect(Math.max(...totals)).toBeLessThan(14_000);
  });
});

describe("RADAR_MINI_APP_CLOSE_LEAD_MS", () => {
  it("outlasts the radar Mini App's own 2100ms close delay", () => {
    // Mirrors `CLOSE_DELAY` in apps/webapp/src/radar/App.tsx. Starting earlier
    // would burn the opening beats behind a Mini App still covering the chat.
    expect(RADAR_MINI_APP_CLOSE_LEAD_MS).toBeGreaterThanOrEqual(2100);
  });
});
