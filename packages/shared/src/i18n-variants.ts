/**
 * Runtime variant pools for the highest-frequency confirmations (VOICE.md §10).
 *
 * `tv()` is a drop-in for `t()` on the pooled keys: it picks uniformly from
 * `[canonical i18n string, ...alternates]`, so the same mid-flow confirmation
 * is not byte-identical every time. The canonical string is ALWAYS variant 0 —
 * `setVariantRng(() => 0)` makes `tv === t` for deterministic tests.
 *
 * Rules for adding a variant (see VOICE.md):
 * - identical `{placeholder}` set and Markdown markers as the canonical string;
 * - same register: short, warm, understatement over hype;
 * - vary the EMOJI too, not just the words. ✨ on every alternate makes it
 *   guaranteed rather than an accent, which is the punctuation failure §8 bans
 *   — so it rides the canonical string only, i.e. roughly one send in three;
 * - 2–3 alternates per key per language, authored natively — never translated.
 */

import type { Language } from "./types.js";
import { interpolate, t, type TranslationKey } from "./i18n.js";

export type VariantRng = () => number;

let rng: VariantRng | null = null;

/** Override the RNG (tests: `setVariantRng(() => 0)`); `null` restores Math.random. */
export function setVariantRng(fn: VariantRng | null): void {
  rng = fn;
}

/** Alternates only — the canonical `i18n.ts` string is implicitly variant 0. */
const VARIANTS: Partial<Record<TranslationKey, Record<Language, string[]>>> = {
  venueWaitingPeer: {
    en: [
      "Yours is in. Now we wait for them…",
      "Noted. Their move now…",
    ],
    ru: [
      "Записал. Теперь ждём вторую сторону…",
      "Есть. Ход за твоим мэтчем…",
    ],
    uk: [
      "Записав. Тепер чекаємо на іншу сторону…",
      "Є. Хід за твоїм метчем…",
    ],
    de: [
      "Notiert. Jetzt warten wir auf dein Match…",
      "Passt. Jetzt ist dein Match dran…",
    ],
    pl: [
      "Zapisane. Teraz czekamy na drugą stronę…",
      "Jest. Teraz ruch twojego matcha…",
    ],
  },
  matchScheduleSavedConfirmation: {
    en: [
      "Done. Your match got the ping — you'll hear from me the moment they answer.",
      "Locked your picks in. I'll ping you as soon as your match replies.",
    ],
    ru: [
      "Готово. Мэтч получил пинг — напишу сразу, как ответит.",
      "Зафиксировал твои слоты. Как только мэтч ответит — дам знать.",
    ],
    uk: [
      "Готово. Метч отримав пінг — напишу, щойно відповість.",
      "Зафіксував твої слоти. Щойно метч відповість — дам знати.",
    ],
    de: [
      "Erledigt. Dein Match hat den Ping — du hörst von mir, sobald eine Antwort da ist.",
      "Deine Slots stehen. Sobald dein Match antwortet, sage ich Bescheid.",
    ],
    pl: [
      "Gotowe. Twój match dostał ping — odezwę się, gdy tylko odpowie.",
      "Twoje sloty zapisane. Dam znać, jak tylko match odpowie.",
    ],
  },
  venueLocationNoted: {
    en: [
      "Starting point locked. Next — the *vibe*: _quiet cafe_, _vegan brunch_, _park walk_, _small museum_?",
      "Got your starting point. Now tell me the *vibe* — e.g. _quiet cafe_, _park walk_, _small museum_.",
    ],
    ru: [
      "Точка есть. Дальше — *вайб*: _тихое кафе_, _веган-завтрак_, _прогулка в парке_, _небольшой музей_?",
      "Точку выезда записал. Теперь расскажи про *вайб* — например _тихое кафе_, _прогулка в парке_, _небольшой музей_.",
    ],
    uk: [
      "Точка є. Далі — *вайб*: _тихе кафе_, _веган-сніданок_, _прогулянка в парку_, _невеликий музей_?",
      "Точку виїзду записав. Тепер розкажи про *вайб* — наприклад _тихе кафе_, _прогулянка в парку_, _невеликий музей_.",
    ],
    de: [
      "Startpunkt steht. Als Nächstes — der *Vibe*: _ruhiges Cafe_, _veganer Brunch_, _Parkspaziergang_, _kleines Museum_?",
      "Startpunkt notiert. Jetzt zum *Vibe* — z. B. _ruhiges Cafe_, _Parkspaziergang_, _kleines Museum_.",
    ],
    pl: [
      "Punkt startowy jest. Dalej — *vibe*: _cicha kawiarnia_, _wegański brunch_, _spacer po parku_, _małe muzeum_?",
      "Punkt startowy zapisany. Teraz powiedz, jaki *vibe* — np. _cicha kawiarnia_, _spacer po parku_, _małe muzeum_.",
    ],
  },
  venueVibeNoted: {
    en: [
      "Vibe locked. Now — where will you be coming from?",
      "Noted the vibe. Last thing: where do you set off from?",
    ],
    ru: [
      "Вайб есть. Теперь — откуда поедешь?",
      "Вайб записал. Осталось одно: откуда стартуешь?",
    ],
    uk: [
      "Вайб є. Тепер — звідки поїдеш?",
      "Вайб записав. Лишилось одне: звідки стартуєш?",
    ],
    de: [
      "Vibe steht. Jetzt — von wo kommst du?",
      "Vibe notiert. Eine Sache noch: von wo startest du?",
    ],
    pl: [
      "Vibe jest. Teraz — skąd będziesz jechać?",
      "Vibe zapisany. Została jedna rzecz: skąd startujesz?",
    ],
  },
};

/** Keys that carry a variant pool (exported for tests). */
export const VARIANT_KEYS = Object.keys(VARIANTS) as TranslationKey[];

/** Read a key's alternates for a language (exported for tests). */
export function variantAlternates(
  lang: Language,
  key: TranslationKey,
): string[] {
  return VARIANTS[key]?.[lang] ?? [];
}

/**
 * Variant-aware `t()`. Picks uniformly from the canonical string plus its
 * alternates; falls through to `t()` for keys without a pool.
 */
export function tv(
  lang: Language,
  key: TranslationKey,
  params?: Record<string, string | number>,
): string {
  const alternates = VARIANTS[key]?.[lang];
  if (!alternates || alternates.length === 0) return t(lang, key, params);
  const pool = [t(lang, key, params), ...alternates.map((a) => interpolate(a, params))];
  const roll = (rng ?? Math.random)();
  const idx = Math.min(pool.length - 1, Math.max(0, Math.floor(roll * pool.length)));
  return pool[idx];
}
