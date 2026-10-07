import type { Language } from "./types.js";
import type { ProfilerAnswerOption, ProfilerQuestion } from "./profiler-questions.js";

/**
 * Quick answers for the Profiler in the native app (founder decision
 * 2026-10-07, mockup «Вопросы о себе, правки» v4).
 *
 * A question can carry an INPUT — how the app offers its answers as taps
 * instead of only a text field:
 *
 *   photos — a horizontal ribbon of photo cards («Какие цветы тебе ближе?»),
 *   pair   — two large photo tiles, this or that («К морю / В горы»),
 *   chips  — borderless text capsules,
 *   scale  — seven detents between two poles («жаворонок ↔ сова»).
 *
 * A question without an input is text only (turn-offs, humour, surprises,
 * "what friends say", passions): their value is the person's own words, and
 * any options would steer them.
 *
 * Two kinds of question, two tap rules:
 *   - OPEN (the bank): the options are hints, not the right answers. A tap puts
 *     the option into the field; the person sends it, and may add their own
 *     words first. "Своими словами" always comes first in the app.
 *   - CLOSED (contextual families, `profiler-context-questions.ts`): the
 *     options are exhaustive for that moment, so a tap answers on the spot.
 *
 * Every answer keeps what was tapped (`ProfilerAnswer.optionIds`) and how the
 * answer came about (`answerSource` tap / text / both), so the answers can
 * become matching signals later without re-asking anyone. `answerText` stays
 * the readable sentence the icebreaker / wingman prompts already read
 * (`composeProfilerAnswerText`). Not used in matching yet.
 *
 * Photos are bundled in the app by `image` key — the server never sends a URL.
 * An option without `image` is drawn as a text card in the ribbon.
 */

export type ProfilerInputKind = "photos" | "pair" | "chips" | "scale";

type Texts = Record<Language, string>;

export interface ProfilerInputOption extends ProfilerAnswerOption {
  /** Bundled photo key in the app; absent = a text card. */
  image?: string;
}

export interface ProfilerInput {
  kind: ProfilerInputKind;
  /** For `scale`: exactly seven, from the `from` pole to the `to` pole. */
  options: readonly ProfilerInputOption[];
  /** Several options may be picked together. Always false for pair and scale. */
  multiple: boolean;
  /** `scale` only: the two ends, drawn under the line. */
  poles?: { from: Texts; to: Texts };
}

/** What the app gets for a question: the input and whether a tap answers. */
export interface ProfilerQuestionInput extends ProfilerInput {
  /** true = a tap answers at once (contextual); false = a tap fills the field. */
  closed: boolean;
}

/** Ids of the seven scale detents, `from` pole to `to` pole. */
export const PROFILER_SCALE_STEP_IDS = [
  "from_3",
  "from_2",
  "from_1",
  "middle",
  "to_1",
  "to_2",
  "to_3",
] as const;

function scale(
  poles: { from: Texts; to: Texts },
  labels: Record<Language, readonly [string, string, string, string, string, string, string]>,
): ProfilerInput {
  return {
    kind: "scale",
    multiple: false,
    poles,
    options: PROFILER_SCALE_STEP_IDS.map((id, i) => ({
      id,
      text: {
        en: labels.en[i]!,
        ru: labels.ru[i]!,
        uk: labels.uk[i]!,
        de: labels.de[i]!,
        pl: labels.pl[i]!,
      },
    })),
  };
}

const CHRONOTYPE = scale(
  {
    from: { en: "Early bird", ru: "Жаворонок", uk: "Жайворонок", de: "Frühaufsteher", pl: "Ranny ptaszek" },
    to: { en: "Night owl", ru: "Сова", uk: "Сова", de: "Nachteule", pl: "Nocny marek" },
  },
  {
    en: [
      "Definitely an early bird",
      "Mostly an early bird",
      "A bit more early bird",
      "Right in the middle",
      "A bit more night owl",
      "Mostly a night owl",
      "Definitely a night owl",
    ],
    ru: [
      "Точно жаворонок",
      "Скорее жаворонок",
      "Чуть больше жаворонок",
      "Ровно посередине",
      "Чуть больше сова",
      "Скорее сова",
      "Точно сова",
    ],
    uk: [
      "Точно жайворонок",
      "Радше жайворонок",
      "Трохи більше жайворонок",
      "Рівно посередині",
      "Трохи більше сова",
      "Радше сова",
      "Точно сова",
    ],
    de: [
      "Klar Frühaufsteher",
      "Eher Frühaufsteher",
      "Etwas mehr Frühaufsteher",
      "Genau in der Mitte",
      "Etwas mehr Nachteule",
      "Eher Nachteule",
      "Klar Nachteule",
    ],
    pl: [
      "Zdecydowanie ranny ptaszek",
      "Raczej ranny ptaszek",
      "Trochę bardziej ranny ptaszek",
      "Dokładnie pośrodku",
      "Trochę bardziej nocny marek",
      "Raczej nocny marek",
      "Zdecydowanie nocny marek",
    ],
  },
);

const COMM_STYLE = scale(
  {
    from: { en: "Long talks", ru: "Долгие разговоры", uk: "Довгі розмови", de: "Lange Gespräche", pl: "Długie rozmowy" },
    to: {
      en: "Short and to the point",
      ru: "Коротко и по делу",
      uk: "Коротко і по суті",
      de: "Kurz und knapp",
      pl: "Krótko i na temat",
    },
  },
  {
    en: [
      "Only long talks",
      "Mostly long talks",
      "A bit more long talks",
      "Half and half",
      "A bit more to the point",
      "Mostly short",
      "Only short and to the point",
    ],
    ru: [
      "Только долгие разговоры",
      "Скорее долгие разговоры",
      "Чуть больше разговоров",
      "Поровну",
      "Чуть больше по делу",
      "Скорее коротко",
      "Только коротко и по делу",
    ],
    uk: [
      "Тільки довгі розмови",
      "Радше довгі розмови",
      "Трохи більше розмов",
      "Порівну",
      "Трохи більше по суті",
      "Радше коротко",
      "Тільки коротко і по суті",
    ],
    de: [
      "Nur lange Gespräche",
      "Eher lange Gespräche",
      "Etwas mehr Gespräche",
      "Halb und halb",
      "Etwas mehr auf den Punkt",
      "Eher kurz",
      "Nur kurz und knapp",
    ],
    pl: [
      "Tylko długie rozmowy",
      "Raczej długie rozmowy",
      "Trochę więcej rozmów",
      "Pół na pół",
      "Trochę bardziej na temat",
      "Raczej krótko",
      "Tylko krótko i na temat",
    ],
  },
);

const PLANNER = scale(
  {
    from: { en: "By the plan", ru: "По плану", uk: "За планом", de: "Nach Plan", pl: "Według planu" },
    to: { en: "Spontaneous", ru: "Спонтанно", uk: "Спонтанно", de: "Spontan", pl: "Spontanicznie" },
  },
  {
    en: [
      "Everything by the plan",
      "Mostly by the plan",
      "A bit more plan",
      "Half and half",
      "A bit more spontaneous",
      "Mostly spontaneous",
      "Fully spontaneous",
    ],
    ru: [
      "Всё по плану",
      "Скорее по плану",
      "Чуть больше плана",
      "Поровну",
      "Чуть больше спонтанности",
      "Скорее спонтанно",
      "Полностью спонтанно",
    ],
    uk: [
      "Усе за планом",
      "Радше за планом",
      "Трохи більше плану",
      "Порівну",
      "Трохи більше спонтанності",
      "Радше спонтанно",
      "Повністю спонтанно",
    ],
    de: [
      "Alles nach Plan",
      "Eher nach Plan",
      "Etwas mehr Plan",
      "Halb und halb",
      "Etwas spontaner",
      "Eher spontan",
      "Völlig spontan",
    ],
    pl: [
      "Wszystko według planu",
      "Raczej według planu",
      "Trochę więcej planu",
      "Pół na pół",
      "Trochę bardziej spontanicznie",
      "Raczej spontanicznie",
      "Całkiem spontanicznie",
    ],
  },
);

const FLOWERS: ProfilerInput = {
  kind: "photos",
  multiple: true,
  options: [
    { id: "peony", image: "peony", text: { en: "Peonies", ru: "Пионы", uk: "Півонії", de: "Pfingstrosen", pl: "Piwonie" } },
    { id: "lavender", image: "lavender", text: { en: "Lavender", ru: "Лаванда", uk: "Лаванда", de: "Lavendel", pl: "Lawenda" } },
    { id: "tulip", image: "tulip", text: { en: "Tulips", ru: "Тюльпаны", uk: "Тюльпани", de: "Tulpen", pl: "Tulipany" } },
    { id: "daisy", image: "daisy", text: { en: "Daisies", ru: "Ромашки", uk: "Ромашки", de: "Margeriten", pl: "Margerytki" } },
    { id: "wildflowers", image: "wildflowers", text: { en: "Wildflowers", ru: "Полевые", uk: "Польові", de: "Wiesenblumen", pl: "Polne kwiaty" } },
    { id: "roses", image: "roses", text: { en: "Roses", ru: "Розы", uk: "Троянди", de: "Rosen", pl: "Róże" } },
    // The question invites "no bouquets, please" on purpose (see `f_flowers`):
    // a text card, so the refusal is one tap away like any flower.
    { id: "no_bouquets", text: { en: "No bouquets, please", ru: "Без букетов", uk: "Без букетів", de: "Lieber keine Sträuße", pl: "Bez bukietów" } },
  ],
};

const TRAVEL: ProfilerInput = {
  kind: "pair",
  multiple: false,
  options: [
    { id: "sea", image: "sea", text: { en: "To the sea", ru: "К морю", uk: "До моря", de: "Ans Meer", pl: "Nad morze" } },
    { id: "mountains", image: "mountains", text: { en: "To the mountains", ru: "В горы", uk: "У гори", de: "In die Berge", pl: "W góry" } },
  ],
};

const PETS: ProfilerInput = {
  kind: "chips",
  multiple: true,
  options: [
    { id: "cat", text: { en: "Cat", ru: "Кошка", uk: "Кішка", de: "Katze", pl: "Kot" } },
    { id: "dog", text: { en: "Dog", ru: "Собака", uk: "Собака", de: "Hund", pl: "Pies" } },
    { id: "want_one", text: { en: "Want one", ru: "Хочу завести", uk: "Хочу завести", de: "Hätte gern eins", pl: "Chcę mieć" } },
    { id: "none", text: { en: "No pets", ru: "Нет", uk: "Немає", de: "Keine", pl: "Nie mam" } },
  ],
};

const SPORT_PREF: ProfilerInput = {
  kind: "chips",
  multiple: false,
  options: [
    { id: "important", text: { en: "Yes, it matters", ru: "Да, это важно", uk: "Так, це важливо", de: "Ja, das ist mir wichtig", pl: "Tak, to ważne" } },
    { id: "plus", text: { en: "Would be a plus", ru: "Было бы плюсом", uk: "Було б плюсом", de: "Wäre ein Plus", pl: "Byłoby plusem" } },
    { id: "doesnt_matter", text: { en: "Doesn't matter", ru: "Неважно", uk: "Неважливо", de: "Egal", pl: "Bez znaczenia" } },
  ],
};

const SPORT: ProfilerInput = {
  kind: "chips",
  multiple: true,
  options: [
    { id: "gym", text: { en: "Gym", ru: "Зал", uk: "Зал", de: "Fitnessstudio", pl: "Siłownia" } },
    { id: "running", text: { en: "Running", ru: "Бег", uk: "Біг", de: "Laufen", pl: "Bieganie" } },
    { id: "football", text: { en: "Football", ru: "Футбол", uk: "Футбол", de: "Fußball", pl: "Piłka nożna" } },
    { id: "swimming", text: { en: "Swimming", ru: "Плавание", uk: "Плавання", de: "Schwimmen", pl: "Pływanie" } },
    { id: "cycling", text: { en: "Cycling", ru: "Велосипед", uk: "Велосипед", de: "Radfahren", pl: "Rower" } },
    { id: "none", text: { en: "No sport", ru: "Не занимаюсь", uk: "Не займаюся", de: "Kein Sport", pl: "Nie uprawiam" } },
  ],
};

const INITIATIVE: ProfilerInput = {
  kind: "chips",
  multiple: false,
  options: [
    { id: "he_plans", text: { en: "Let him plan", ru: "Пусть планирует он", uk: "Хай планує він", de: "Er soll planen", pl: "Niech on planuje" } },
    { id: "together", text: { en: "Decide together", ru: "Решать вместе", uk: "Вирішувати разом", de: "Gemeinsam entscheiden", pl: "Decydować razem" } },
    { id: "i_suggest", text: { en: "I'll suggest too", ru: "Могу предложить сама", uk: "Можу запропонувати сама", de: "Ich schlage auch selbst vor", pl: "Mogę sama zaproponować" } },
  ],
};

/**
 * The pilot: which bank questions get quick answers. Everything else stays
 * text only. Contextual questions get chips from their own `options`.
 */
const BANK_INPUTS: Readonly<Record<string, ProfilerInput>> = {
  f_comm_style: COMM_STYLE,
  f_chronotype: CHRONOTYPE,
  f_sport_pref: SPORT_PREF,
  f_initiative: INITIATIVE,
  f_flowers: FLOWERS,
  f_travel: TRAVEL,
  f_pets: PETS,
  m_sport: SPORT,
  m_chronotype: CHRONOTYPE,
  m_planner: PLANNER,
  m_travel: TRAVEL,
  m_pets: PETS,
};

/** Every bank question id that has quick answers (tests, docs). */
export function profilerBankInputIds(): string[] {
  return Object.keys(BANK_INPUTS);
}

/**
 * How the app should offer answers to `question`, or null for text only.
 * A bank question → its pilot input (open). A contextual question → chips from
 * its own options (closed: one tap answers).
 */
export function profilerQuestionInput(question: ProfilerQuestion): ProfilerQuestionInput | null {
  if (question.context) {
    if (!question.options || question.options.length === 0) return null;
    return { kind: "chips", multiple: false, options: question.options, closed: true };
  }
  const input = BANK_INPUTS[question.id];
  return input ? { ...input, closed: false } : null;
}

/** Localized option text, English fallback. */
export function profilerOptionText(option: ProfilerAnswerOption, language: Language): string {
  return option.text[language] ?? option.text.en;
}

export type ProfilerAnswerSource = "tap" | "text" | "both";

export type ProfilerQuickAnswer =
  | { ok: true; answerText: string; optionIds: string[]; source: ProfilerAnswerSource }
  | { ok: false; error: "unknown_option" | "too_many_options" | "empty_answer" };

/**
 * Turn what the app sent — tapped option ids and the field's text — into the
 * row to store.
 *
 * `answerText` is what the prompts read, so it must say the whole answer in
 * words: the tapped options' text, then the person's own words. When the text
 * already names every tapped option (the app puts a tapped photo's label into
 * the field, and the person sent it as is or added to it), the text alone is
 * the answer and nothing is repeated.
 *
 * `source`: the client's word when it sent one that fits; otherwise derived —
 * no options → text, no text → tap, both → both.
 */
export function composeProfilerAnswerText(
  question: ProfilerQuestion,
  optionIds: readonly string[],
  text: string,
  language: Language,
  maxLength: number,
  claimedSource?: ProfilerAnswerSource,
): ProfilerQuickAnswer {
  const own = text.trim();
  const ids = [...new Set(optionIds.map((id) => id.trim()).filter((id) => id.length > 0))];
  if (ids.length === 0) {
    if (!own) return { ok: false, error: "empty_answer" };
    return { ok: true, answerText: own.slice(0, maxLength), optionIds: [], source: "text" };
  }

  const input = profilerQuestionInput(question);
  if (!input) return { ok: false, error: "unknown_option" };
  const picked: ProfilerAnswerOption[] = [];
  for (const id of ids) {
    const option = input.options.find((o) => o.id === id);
    if (!option) return { ok: false, error: "unknown_option" };
    picked.push(option);
  }
  if (!input.multiple && picked.length > 1) return { ok: false, error: "too_many_options" };

  const labels = picked.map((o) => profilerOptionText(o, language));
  const joined = labels.join(", ");
  let answerText: string;
  if (!own) {
    answerText = joined;
  } else {
    const lower = own.toLocaleLowerCase(language);
    const named = labels.every((label) => lower.includes(label.toLocaleLowerCase(language)));
    answerText = named ? own : `${joined}. ${own}`;
  }

  const derived: ProfilerAnswerSource = own ? "both" : "tap";
  // A "tap" claim with text is honest only when the text is just the labels
  // the app put there; "text" never fits an answer that carries options.
  const source =
    claimedSource === "tap" || claimedSource === "both" ? (own ? claimedSource : "tap") : derived;
  return { ok: true, answerText: answerText.slice(0, maxLength), optionIds: ids, source };
}
