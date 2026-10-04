import type { Gender, Language } from "./types.js";
import type { VenueExperience } from "./venue-intent.js";
import type {
  ProfilerAnswerOption,
  ProfilerPriority,
  ProfilerQuestion,
} from "./profiler-questions.js";

/**
 * Contextual Profiler questions (founder decision 2026-10-04) — the questions
 * that open only when something happened to THIS person, instead of the weekly
 * re-asks of "plans for the weekend" / "best part of the week" they replace.
 *
 * Five families, each with a hand-written text in all five languages — never
 * LLM-worded, so every sentence a user can see is reviewed here:
 *
 *   - `topic`     — a date was just scheduled: "what are you into right now?"
 *                   The freshest icebreaker there is, asked while it can still
 *                   reach the T-5h icebreakers, the wingman tip and the Bump deck.
 *   - `format`    — a date took place two days ago: same format next time, or
 *                   different? A preference stated about a REAL evening rather
 *                   than an imagined one.
 *   - `signature` — two or more confirmed dates share one leading experience:
 *                   "looks like your format is coffee and something sweet — right?"
 *                   Behaviour plus explicit confirmation.
 *   - `followup`  — the person's own plan from a month ago (what they wanted to
 *                   learn, where they wanted to go): did it move?
 *   - `recheck`   — a dimension the person answered two months ago, asked again
 *                   in different words. Agreement between the two is the direct
 *                   measure of whether answers can be trusted, which is what the
 *                   founder needs before Profiler answers ever enter matching.
 *
 * The trigger rules live in `selectContextualProfilerQuestion`
 * (`apps/bot/src/services/profiler-schedule.ts`); this file only holds what a
 * question IS — id, wording, closed answer options.
 *
 * **Context is shown, not described.** A question that refers to something
 * (the date, the person's own earlier answer) is rendered with a card above it
 * — like a quoted message in a messenger — carrying the date, the venue, or the
 * quoted answer. So the wording here never names a venue, a date or a count; it
 * says "this format", "this", and the card says which. `recheck` deliberately
 * has no card: showing the earlier answer would make the second one a copy.
 *
 * **Never from passive data.** Nothing here reads music, Apple Health rhythm or
 * frequent places (founder decision 2026-10-04): every trigger is a date the
 * person went on through us, or something they told us themselves.
 *
 * **Options.** Every contextual question carries closed answer options (stable
 * ids + text), decided now so the answers can later become matching signals
 * once the app renders them as quick taps. Today both surfaces still take free
 * text, so each question's own wording names the choices.
 *
 * **Ids.** `<f|m>_ctx:<family>:<key>` — the bank's gender prefix, then the
 * family, then what the instance is about (a match id, an experience, a source
 * question id). One `ProfilerAnswer` row per instance falls out of the existing
 * `@@unique([userId, questionId])`, so "asked already" needs no new table, and
 * the id alone is enough to rebuild the question anywhere it is read. The
 * longest id (`format` + a UUID) keeps the Telegram Skip button's
 * `profiler:skip:<id>` callback inside its 64-byte limit.
 */

export const PROFILER_CONTEXT_FAMILIES = [
  "topic",
  "format",
  "signature",
  "followup",
  "recheck",
] as const;
export type ProfilerContextFamily = (typeof PROFILER_CONTEXT_FAMILIES)[number];

/** What a contextual question instance is about. */
export interface ProfilerContextRef {
  family: ProfilerContextFamily;
  /** Match id (`topic`, `format`), experience (`signature`), source question id (`followup`, `recheck`). */
  key: string;
}

type Texts = Record<Language, string>;

interface ContextualText {
  priority: ProfilerPriority;
  text: Texts;
  options: readonly ProfilerAnswerOption[];
}

const ID_MARK = "_ctx:";

function genderLetter(gender: Gender): "f" | "m" {
  return gender === "female" ? "f" : "m";
}

/** The persisted id of a contextual question instance. */
export function contextualProfilerQuestionId(
  gender: Gender,
  family: ProfilerContextFamily,
  key: string,
): string {
  return `${genderLetter(gender)}${ID_MARK}${family}:${key}`;
}

/** Inverse of `contextualProfilerQuestionId`; null for a bank id or a malformed one. */
export function parseContextualProfilerQuestionId(
  id: string,
): { gender: Gender; ref: ProfilerContextRef } | null {
  const match = /^([fm])_ctx:([a-z]+):([A-Za-z0-9_-]+)$/.exec(id);
  if (!match) return null;
  const family = PROFILER_CONTEXT_FAMILIES.find((f) => f === match[2]);
  if (!family) return null;
  return {
    gender: match[1] === "f" ? "female" : "male",
    ref: { family, key: match[3]! },
  };
}

export function isContextualProfilerQuestionId(id: string): boolean {
  return parseContextualProfilerQuestionId(id) !== null;
}

// ---------------------------------------------------------------------------
// I. topic — a date was scheduled
// ---------------------------------------------------------------------------

const TOPIC: ContextualText = {
  priority: "high",
  // Short on purpose: the card above names the date, so the text does not.
  // Next to the card, the long first version no longer fit the app's bubble
  // beside the mascot (stand frames, 2026-10-04).
  text: {
    en: "What are you into right now — a project, a hobby, a trip? I'll slip it in as a topic for your date.",
    ru: "Чем ты сейчас горишь — проект, хобби, поездка? Подкину это как тему для встречи.",
    uk: "Чим ти зараз гориш — проєкт, хобі, поїздка? Підкину це як тему для зустрічі.",
    de: "Was begeistert dich gerade — ein Projekt, ein Hobby, eine Reise? Ich bringe es als Thema für euer Treffen ein.",
    pl: "Czym teraz żyjesz — projekt, hobby, wyjazd? Podrzucę to jako temat na spotkanie.",
  },
  options: [
    {
      id: "project",
      text: {
        en: "Study or work — a new project",
        ru: "Учёба или работа — новый проект",
        uk: "Навчання чи робота — новий проєкт",
        de: "Studium oder Job — ein neues Projekt",
        pl: "Nauka lub praca — nowy projekt",
      },
    },
    {
      id: "hobby",
      text: { en: "A new hobby", ru: "Новое хобби", uk: "Нове хобі", de: "Ein neues Hobby", pl: "Nowe hobby" },
    },
    {
      id: "trip",
      text: {
        en: "A trip or plans",
        ru: "Поездка или планы",
        uk: "Поїздка чи плани",
        de: "Eine Reise oder Pläne",
        pl: "Wyjazd albo plany",
      },
    },
    {
      id: "resting",
      text: {
        en: "Taking it easy",
        ru: "Отдыхаю, ничего особенного",
        uk: "Відпочиваю, нічого особливого",
        de: "Ich lasse es ruhig angehen",
        pl: "Odpoczywam, nic szczególnego",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// II. format — a date took place
// ---------------------------------------------------------------------------

const FORMAT: ContextualText = {
  priority: "medium",
  // "The same" points at the date on the card above.
  text: {
    en: "Next time — the same, or different: calmer, on the move, or an evening dinner?",
    ru: "В следующий раз — так же или иначе: спокойнее, в движении или вечером за ужином?",
    uk: "Наступного разу — так само чи інакше: спокійніше, у русі чи ввечері за вечерею?",
    de: "Nächstes Mal — genauso oder anders: ruhiger, in Bewegung oder abends beim Essen?",
    pl: "Następnym razem — tak samo czy inaczej: spokojniej, w ruchu czy wieczorem przy kolacji?",
  },
  options: [
    {
      id: "same",
      text: {
        en: "Same again — it worked",
        ru: "Так же — зашло",
        uk: "Так само — зайшло",
        de: "Genauso — hat gepasst",
        pl: "Tak samo — było super",
      },
    },
    {
      id: "calmer",
      text: {
        en: "Calmer, at a table",
        ru: "Спокойнее, за столиком",
        uk: "Спокійніше, за столиком",
        de: "Ruhiger, am Tisch",
        pl: "Spokojniej, przy stoliku",
      },
    },
    {
      id: "moving",
      text: {
        en: "On the move — a walk or an activity",
        ru: "В движении — прогулка или что-то поделать",
        uk: "У русі — прогулянка чи щось зробити разом",
        de: "In Bewegung — ein Spaziergang oder eine Aktivität",
        pl: "W ruchu — spacer albo jakaś aktywność",
      },
    },
    {
      id: "evening",
      text: {
        en: "Evening — dinner or drinks",
        ru: "Вечером — ужин или бар",
        uk: "Ввечері — вечеря чи бар",
        de: "Abends — Essen oder Drinks",
        pl: "Wieczorem — kolacja albo drinki",
      },
    },
  ],
};

// ---------------------------------------------------------------------------
// III. signature — dates keep sharing one experience
// ---------------------------------------------------------------------------

/**
 * Experiences a confirmed date can carry (`mapVibeTagsToFacets` never yields
 * `surprise_me`, which is a request, not a place).
 */
export type ProfilerSignatureExperience = Exclude<VenueExperience, "surprise_me">;

/** Soft words for an experience, as they read inside the signature sentence. */
const SIGNATURE_LABELS: Record<ProfilerSignatureExperience, Texts> = {
  conversation: {
    en: "places for a good talk",
    ru: "места, где хорошо поговорить",
    uk: "місця, де добре поговорити",
    de: "Orte für gute Gespräche",
    pl: "miejsca na dobrą rozmowę",
  },
  coffee_treats: {
    en: "coffee and something sweet",
    ru: "кофе и десерты",
    uk: "кава й десерти",
    de: "Kaffee und Süßes",
    pl: "kawa i coś słodkiego",
  },
  meal_discovery: {
    en: "discovering new food",
    ru: "новые кухни и ужины",
    uk: "нові кухні й вечері",
    de: "neue Küchen entdecken",
    pl: "odkrywanie nowych smaków",
  },
  walk_view: {
    en: "walks and good views",
    ru: "прогулки и красивые виды",
    uk: "прогулянки й гарні краєвиди",
    de: "Spaziergänge mit Aussicht",
    pl: "spacery i ładne widoki",
  },
  art_culture: {
    en: "art and culture",
    ru: "искусство и выставки",
    uk: "мистецтво й виставки",
    de: "Kunst und Kultur",
    pl: "sztuka i kultura",
  },
  drinks_evening: {
    en: "an evening over drinks",
    ru: "вечер за бокалом",
    uk: "вечір за келихом",
    de: "ein Abend bei Drinks",
    pl: "wieczór przy drinku",
  },
  playful_activity: {
    en: "doing something together",
    ru: "что-то поделать вместе",
    uk: "щось робити разом",
    de: "zusammen etwas unternehmen",
    pl: "wspólne robienie czegoś",
  },
};

const SIGNATURE_TEMPLATE: Texts = {
  en: "Looks like your format is {label}. Is that right?",
  ru: "Похоже, твой формат — {label}. Так и есть?",
  uk: "Схоже, твій формат — {label}. Так і є?",
  de: "Dein Format scheint {label} zu sein. Stimmt das?",
  pl: "Wygląda na to, że twój format to {label}. Zgadza się?",
};

const SIGNATURE_OPTIONS: readonly ProfilerAnswerOption[] = [
  {
    id: "yes",
    text: {
      en: "Yes, that's me",
      ru: "Да, это моё",
      uk: "Так, це моє",
      de: "Ja, genau mein Ding",
      pl: "Tak, to moje",
    },
  },
  {
    id: "chance",
    text: {
      en: "Just a coincidence",
      ru: "Просто совпало",
      uk: "Просто збіглося",
      de: "Reiner Zufall",
      pl: "Zwykły przypadek",
    },
  },
  {
    id: "other",
    text: {
      en: "I'd like to try something else",
      ru: "Хочу попробовать другое",
      uk: "Хочу спробувати інше",
      de: "Ich will mal was anderes probieren",
      pl: "Chcę spróbować czegoś innego",
    },
  },
];

export function isProfilerSignatureExperience(value: string): value is ProfilerSignatureExperience {
  return Object.prototype.hasOwnProperty.call(SIGNATURE_LABELS, value);
}

function signatureText(experience: ProfilerSignatureExperience): Texts {
  const labels = SIGNATURE_LABELS[experience];
  return {
    en: SIGNATURE_TEMPLATE.en.replace("{label}", labels.en),
    ru: SIGNATURE_TEMPLATE.ru.replace("{label}", labels.ru),
    uk: SIGNATURE_TEMPLATE.uk.replace("{label}", labels.uk),
    de: SIGNATURE_TEMPLATE.de.replace("{label}", labels.de),
    pl: SIGNATURE_TEMPLATE.pl.replace("{label}", labels.pl),
  };
}

// ---------------------------------------------------------------------------
// IV. followup — the person's own plan, a month later
// ---------------------------------------------------------------------------

const LEARNING_NOT_YET: ProfilerAnswerOption = {
  id: "not_yet",
  text: {
    en: "Still putting it off",
    ru: "Пока откладываю",
    uk: "Поки відкладаю",
    de: "Schiebe es noch auf",
    pl: "Wciąż odkładam",
  },
};
const LEARNING_CHANGED: ProfilerAnswerOption = {
  id: "changed",
  text: {
    en: "Now I want something else",
    ru: "Теперь хочу другое",
    uk: "Тепер хочу інше",
    de: "Jetzt will ich was anderes",
    pl: "Teraz chcę czegoś innego",
  },
};
const TRAVEL_PLANNED: ProfilerAnswerOption = {
  id: "planned",
  text: {
    en: "Still in the plans",
    ru: "Всё ещё в планах",
    uk: "Досі в планах",
    de: "Noch in Planung",
    pl: "Wciąż w planach",
  },
};
const TRAVEL_CHANGED: ProfilerAnswerOption = {
  id: "changed",
  text: {
    en: "Now I want somewhere else",
    ru: "Теперь хочу в другое место",
    uk: "Тепер хочу в інше місце",
    de: "Jetzt zieht es mich woandershin",
    pl: "Teraz chcę gdzie indziej",
  },
};

/**
 * Source question → its follow-up. Only plans and passions — things that move
 * in a month and make a live opener ("you wanted to learn guitar — did you?").
 */
const FOLLOWUPS: Readonly<Record<string, ContextualText>> = {
  f_learning: {
    priority: "medium",
    text: {
      en: "Did you get started — or is it still on hold?",
      ru: "Получилось начать — или пока откладываешь?",
      uk: "Вдалося почати — чи поки відкладаєш?",
      de: "Hast du angefangen — oder schiebst du es noch auf?",
      pl: "Udało się zacząć — czy wciąż odkładasz?",
    },
    options: [
      {
        id: "started",
        text: {
          en: "Started!",
          ru: "Уже начала",
          uk: "Уже почала",
          de: "Schon angefangen",
          pl: "Już zaczęłam",
        },
      },
      LEARNING_NOT_YET,
      LEARNING_CHANGED,
    ],
  },
  m_learning: {
    priority: "medium",
    text: {
      en: "Did you get started — or is it still on hold?",
      ru: "Получилось начать — или пока откладываешь?",
      uk: "Вдалося почати — чи поки відкладаєш?",
      de: "Hast du angefangen — oder schiebst du es noch auf?",
      pl: "Udało się zacząć — czy wciąż odkładasz?",
    },
    options: [
      {
        id: "started",
        text: {
          en: "Started!",
          ru: "Уже начал",
          uk: "Уже почав",
          de: "Schon angefangen",
          pl: "Już zacząłem",
        },
      },
      LEARNING_NOT_YET,
      LEARNING_CHANGED,
    ],
  },
  f_travel: {
    priority: "low",
    text: {
      en: "Did you make it there — or is it still a plan?",
      ru: "Получилось съездить — или всё ещё в планах?",
      uk: "Вдалося з'їздити — чи досі в планах?",
      de: "Hat es geklappt — oder ist es noch ein Plan?",
      pl: "Udało się pojechać — czy to wciąż plan?",
    },
    options: [
      {
        id: "went",
        text: {
          en: "Been there!",
          ru: "Уже съездила",
          uk: "Уже з'їздила",
          de: "War schon da",
          pl: "Już byłam",
        },
      },
      TRAVEL_PLANNED,
      TRAVEL_CHANGED,
    ],
  },
  m_travel: {
    priority: "low",
    text: {
      en: "Did you make it there — or is it still a plan?",
      ru: "Получилось съездить — или всё ещё в планах?",
      uk: "Вдалося з'їздити — чи досі в планах?",
      de: "Hat es geklappt — oder ist es noch ein Plan?",
      pl: "Udało się pojechać — czy to wciąż plan?",
    },
    options: [
      {
        id: "went",
        text: {
          en: "Been there!",
          ru: "Уже съездил",
          uk: "Уже з'їздив",
          de: "War schon da",
          pl: "Już byłem",
        },
      },
      TRAVEL_PLANNED,
      TRAVEL_CHANGED,
    ],
  },
  m_passions: {
    priority: "medium",
    text: {
      en: "Is this still your talk-for-hours topic — or is there something new?",
      ru: "Это всё ещё твоя тема на часы — или появилось что-то новое?",
      uk: "Це досі твоя тема на години — чи з'явилося щось нове?",
      de: "Ist das immer noch dein Thema für Stunden — oder gibt es etwas Neues?",
      pl: "To wciąż twój temat na godziny — czy pojawiło się coś nowego?",
    },
    options: [
      {
        id: "same",
        text: {
          en: "Still this one",
          ru: "Всё ещё она",
          uk: "Досі вона",
          de: "Immer noch das",
          pl: "Wciąż ten",
        },
      },
      {
        id: "new",
        text: {
          en: "Something new",
          ru: "Появилось новое",
          uk: "З'явилося нове",
          de: "Etwas Neues",
          pl: "Coś nowego",
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// V. recheck — the same dimension, two months later, in other words
// ---------------------------------------------------------------------------

const CHRONOTYPE_RECHECK: ContextualText = {
  priority: "medium",
  text: {
    en: "Ideal time for a date: a weekend morning, daytime, after work, or late evening?",
    ru: "Идеальное время для свидания: утро выходного, днём, после работы или поздно вечером?",
    uk: "Ідеальний час для побачення: ранок вихідного, вдень, після роботи чи пізно ввечері?",
    de: "Die ideale Zeit für ein Date: Wochenendmorgen, tagsüber, nach der Arbeit oder spätabends?",
    pl: "Idealna pora na randkę: weekendowy poranek, w ciągu dnia, po pracy czy późnym wieczorem?",
  },
  options: [
    {
      id: "morning",
      text: {
        en: "Weekend morning",
        ru: "Утро выходного",
        uk: "Ранок вихідного",
        de: "Wochenendmorgen",
        pl: "Weekendowy poranek",
      },
    },
    {
      id: "day",
      text: { en: "Daytime", ru: "Днём", uk: "Вдень", de: "Tagsüber", pl: "W ciągu dnia" },
    },
    {
      id: "evening",
      text: {
        en: "After work",
        ru: "После работы",
        uk: "Після роботи",
        de: "Nach der Arbeit",
        pl: "Po pracy",
      },
    },
    {
      id: "late",
      text: {
        en: "Late evening",
        ru: "Поздно вечером",
        uk: "Пізно ввечері",
        de: "Spätabends",
        pl: "Późnym wieczorem",
      },
    },
  ],
};

/**
 * Source question → the same dimension asked differently: a concrete scene or
 * a number instead of a self-description, so the answer is a reaction rather
 * than a self-image. Only dimensions that could become matching signals.
 */
const RECHECKS: Readonly<Record<string, ContextualText>> = {
  f_chronotype: CHRONOTYPE_RECHECK,
  m_chronotype: CHRONOTYPE_RECHECK,
  f_initiative: {
    priority: "medium",
    text: {
      en: "He texts: “Where do you want to go?” What's your first reaction?",
      ru: "Он пишет: «Куда хочешь пойти?» Твоя первая реакция?",
      uk: "Він пише: «Куди хочеш піти?» Твоя перша реакція?",
      de: "Er schreibt: „Wohin möchtest du gehen?“ Deine erste Reaktion?",
      pl: "Pisze: „Gdzie chcesz pójść?” Twoja pierwsza reakcja?",
    },
    options: [
      {
        id: "suggest",
        text: {
          en: "I'll suggest a place right away",
          ru: "Сразу предложу место",
          uk: "Одразу запропоную місце",
          de: "Ich schlage sofort was vor",
          pl: "Od razu zaproponuję miejsce",
        },
      },
      {
        id: "he_picks",
        text: {
          en: "I'd rather he suggested one",
          ru: "Лучше бы предложил он",
          uk: "Краще б запропонував він",
          de: "Lieber soll er was vorschlagen",
          pl: "Wolałabym, żeby on zaproponował",
        },
      },
      {
        id: "together",
        text: {
          en: "Let's throw ideas around together",
          ru: "Накидаем варианты вместе",
          uk: "Накидаємо варіанти разом",
          de: "Wir sammeln zusammen Ideen",
          pl: "Wymyślimy coś razem",
        },
      },
    ],
  },
  m_planner: {
    priority: "medium",
    text: {
      en: "A free Saturday with no plans — bliss or slightly uncomfortable?",
      ru: "Свободная суббота без планов — это кайф или немного неуютно?",
      uk: "Вільна субота без планів — це кайф чи трохи незатишно?",
      de: "Ein freier Samstag ohne Pläne — herrlich oder eher unbehaglich?",
      pl: "Wolna sobota bez planów — czysta przyjemność czy trochę niewygodnie?",
    },
    options: [
      {
        id: "bliss",
        text: {
          en: "Bliss — I'll see where it takes me",
          ru: "Кайф — посмотрю, куда занесёт",
          uk: "Кайф — подивлюся, куди занесе",
          de: "Herrlich — mal sehen, wohin es mich treibt",
          pl: "Przyjemność — zobaczę, dokąd mnie poniesie",
        },
      },
      {
        id: "plan",
        text: {
          en: "Uncomfortable — I'll make a plan",
          ru: "Неуютно — накидаю план",
          uk: "Незатишно — накидаю план",
          de: "Unbehaglich — ich mache einen Plan",
          pl: "Niewygodnie — zrobię plan",
        },
      },
      {
        id: "depends",
        text: {
          en: "Depends on my mood",
          ru: "Зависит от настроения",
          uk: "Залежить від настрою",
          de: "Kommt auf die Laune an",
          pl: "Zależy od nastroju",
        },
      },
    ],
  },
  f_sport_pref: {
    priority: "medium",
    text: {
      en: "A guy who trains 3–4 times a week — for you that's…",
      ru: "Парень, который тренируется 3–4 раза в неделю, — для тебя это…",
      uk: "Хлопець, який тренується 3–4 рази на тиждень, — для тебе це…",
      de: "Ein Typ, der 3–4 Mal pro Woche trainiert — für dich ist das …",
      pl: "Chłopak, który trenuje 3–4 razy w tygodniu — dla ciebie to…",
    },
    options: [
      {
        id: "big_plus",
        text: {
          en: "A big plus",
          ru: "Большой плюс",
          uk: "Великий плюс",
          de: "Ein großes Plus",
          pl: "Duży plus",
        },
      },
      {
        id: "neutral",
        text: {
          en: "Doesn't matter",
          ru: "Всё равно",
          uk: "Байдуже",
          de: "Egal",
          pl: "Bez znaczenia",
        },
      },
      {
        id: "minus",
        text: {
          en: "More of a minus",
          ru: "Скорее минус",
          uk: "Радше мінус",
          de: "Eher ein Minus",
          pl: "Raczej minus",
        },
      },
    ],
  },
  m_sport: {
    priority: "medium",
    text: {
      en: "How many workouts do you get in a normal week?",
      ru: "Сколько тренировок у тебя в обычную неделю?",
      uk: "Скільки тренувань у тебе за звичайний тиждень?",
      de: "Wie viele Trainings schaffst du in einer normalen Woche?",
      pl: "Ile treningów masz w zwykłym tygodniu?",
    },
    options: [
      {
        id: "none",
        text: { en: "None", ru: "Ни одной", uk: "Жодного", de: "Keins", pl: "Żadnego" },
      },
      { id: "few", text: { en: "1–2", ru: "1–2", uk: "1–2", de: "1–2", pl: "1–2" } },
      {
        id: "many",
        text: {
          en: "3 or more",
          ru: "3 и больше",
          uk: "3 і більше",
          de: "3 oder mehr",
          pl: "3 lub więcej",
        },
      },
    ],
  },
};

/** Bank questions that have a follow-up, in ask order, for a gender. */
export function profilerFollowupSourceIds(gender: Gender): string[] {
  const letter = `${genderLetter(gender)}_`;
  return Object.keys(FOLLOWUPS).filter((id) => id.startsWith(letter));
}

/** Bank questions that have a recheck, in ask order, for a gender. */
export function profilerRecheckSourceIds(gender: Gender): string[] {
  const letter = `${genderLetter(gender)}_`;
  return Object.keys(RECHECKS).filter((id) => id.startsWith(letter));
}

function contextualText(
  gender: Gender,
  ref: ProfilerContextRef,
): ContextualText | null {
  switch (ref.family) {
    case "topic":
      return TOPIC;
    case "format":
      return FORMAT;
    case "signature":
      return isProfilerSignatureExperience(ref.key)
        ? { priority: "high", text: signatureText(ref.key), options: SIGNATURE_OPTIONS }
        : null;
    case "followup": {
      const own = profilerFollowupSourceIds(gender).includes(ref.key);
      return own ? FOLLOWUPS[ref.key] ?? null : null;
    }
    case "recheck": {
      const own = profilerRecheckSourceIds(gender).includes(ref.key);
      return own ? RECHECKS[ref.key] ?? null : null;
    }
  }
}

/**
 * Rebuild a contextual question from its id alone — every reader (the answer
 * handler, the stall sweep, the icebreaker prompts) resolves it the same way a
 * bank question resolves. Undefined for an id that is not a valid instance.
 */
export function contextualProfilerQuestionById(id: string): ProfilerQuestion | undefined {
  const parsed = parseContextualProfilerQuestionId(id);
  if (!parsed) return undefined;
  const spec = contextualText(parsed.gender, parsed.ref);
  if (!spec) return undefined;
  return {
    id,
    gender: parsed.gender,
    priority: spec.priority,
    text: spec.text,
    context: parsed.ref,
    options: spec.options,
  };
}

/** Build the instance for a family and key — undefined when the key is not valid for it. */
export function contextualProfilerQuestion(
  gender: Gender,
  family: ProfilerContextFamily,
  key: string,
): ProfilerQuestion | undefined {
  return contextualProfilerQuestionById(contextualProfilerQuestionId(gender, family, key));
}
