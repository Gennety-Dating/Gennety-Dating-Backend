import type { Gender, Language } from "./types.js";
import { PROFILER_PRIORITY_WEIGHTS } from "./constants.js";

/**
 * Profiler question bank (PRODUCT_SPEC §Phase 1b).
 *
 * Two gender-specific, priority-ordered banks. Women are asked from the
 * "what you want in a partner / date" angle (fuels HINTS for the man); men
 * are asked from the "who you are" angle (fuels ICEBREAKERS for the woman).
 *
 * Questions are user-facing and fully localized, but live here — alongside
 * their stable id + priority — rather than in the monolithic i18n map, so a
 * question's identity, ordering weight, and every translation stay cohesive
 * in one place. Generic UI strings (skip button, batch intro, hint/icebreaker
 * framing) remain in i18n.ts.
 */

export type ProfilerPriority = "high" | "medium" | "low";

export interface ProfilerQuestion {
  /** Stable identifier persisted on `ProfilerAnswer.questionId`. */
  id: string;
  /** Which gender's bank this question belongs to. */
  gender: Gender;
  priority: ProfilerPriority;
  /** Localized prompt text, keyed by language. */
  text: Record<Language, string>;
}

/** Weight an answer carries in icebreaker/hint generation (spec §5.3). */
export function profilerPriorityWeight(priority: ProfilerPriority): number {
  return PROFILER_PRIORITY_WEIGHTS[priority];
}

const FEMALE_QUESTIONS: ProfilerQuestion[] = [
  {
    id: "f_date_spots",
    gender: "female",
    priority: "high",
    text: {
      en: "What kind of places do you enjoy for a first date?",
      ru: "Какие места для первого свидания тебе нравятся?",
      uk: "Які місця для першого побачення тобі подобаються?",
      de: "Welche Orte magst du für ein erstes Date?",
      pl: "Jakie miejsca lubisz na pierwszą randkę?",
    },
  },
  {
    id: "f_comm_style",
    gender: "female",
    priority: "high",
    text: {
      en: "In talking with a guy, what matters more to you — chatting about everything, or keeping it to the point?",
      ru: "Что для тебя важно в общении с парнем — болтать обо всём или говорить по делу?",
      uk: "Що для тебе важливо в спілкуванні з хлопцем — балакати про все чи говорити по суті?",
      de: "Was ist dir im Gespräch mit einem Typen wichtiger — über alles plaudern oder auf den Punkt kommen?",
      pl: "Co jest dla ciebie ważne w rozmowie z chłopakiem — gadać o wszystkim czy mówić konkretnie?",
    },
  },
  {
    id: "f_chronotype",
    gender: "female",
    priority: "high",
    text: {
      en: "Are you an early bird or a night owl?",
      ru: "Ты жаворонок или сова?",
      uk: "Ти жайворонок чи сова?",
      de: "Bist du eher Frühaufsteher oder Nachteule?",
      pl: "Jesteś rannym ptaszkiem czy nocnym markiem?",
    },
  },
  {
    id: "f_sport_pref",
    gender: "female",
    priority: "high",
    text: {
      en: "Do you want your guy to play sports — and if so, which ones?",
      ru: "Хочешь ли ты, чтобы твой парень занимался спортом, и если да — то каким?",
      uk: "Чи хочеш ти, щоб твій хлопець займався спортом, і якщо так — то яким?",
      de: "Möchtest du, dass dein Freund Sport treibt — und wenn ja, welchen?",
      pl: "Czy chcesz, żeby twój chłopak uprawiał sport — a jeśli tak, to jaki?",
    },
  },
  {
    id: "f_turnoffs",
    gender: "female",
    priority: "medium",
    text: {
      en: "What's an instant turn-off in a guy when you first meet?",
      ru: "Что тебя сразу отталкивает в парне при первом знакомстве?",
      uk: "Що тебе одразу відштовхує в хлопці при першому знайомстві?",
      de: "Was schreckt dich bei einem Typen beim ersten Treffen sofort ab?",
      pl: "Co od razu cię zniechęca do chłopaka przy pierwszym spotkaniu?",
    },
  },
  {
    id: "f_shared_interests",
    gender: "female",
    priority: "medium",
    text: {
      en: "Does it matter that you share interests, or is mutual interest in each other enough?",
      ru: "Тебе важно, чтобы у вас были общие интересы, или достаточно взаимного интереса друг к другу?",
      uk: "Тобі важливо, щоб у вас були спільні інтереси, чи достатньо взаємного інтересу одне до одного?",
      de: "Ist es dir wichtig, gemeinsame Interessen zu haben, oder reicht gegenseitiges Interesse aneinander?",
      pl: "Czy ważne jest, żebyście mieli wspólne zainteresowania, czy wystarczy wzajemne zainteresowanie sobą?",
    },
  },
  {
    id: "f_activity_pref",
    gender: "female",
    priority: "medium",
    text: {
      en: "How do you like to spend time — actively, or in a calm setting?",
      ru: "Как ты предпочитаешь проводить время — активно или в спокойной обстановке?",
      uk: "Як ти любиш проводити час — активно чи в спокійній обстановці?",
      de: "Wie verbringst du deine Zeit lieber — aktiv oder in entspannter Atmosphäre?",
      pl: "Jak wolisz spędzać czas — aktywnie czy w spokojnej atmosferze?",
    },
  },
  {
    id: "f_media",
    gender: "female",
    priority: "low",
    text: {
      en: "What are you watching, reading, or listening to right now?",
      ru: "Что ты сейчас смотришь, читаешь или слушаешь?",
      uk: "Що ти зараз дивишся, читаєш або слухаєш?",
      de: "Was schaust, liest oder hörst du gerade?",
      pl: "Co teraz oglądasz, czytasz albo czego słuchasz?",
    },
  },
];

const MALE_QUESTIONS: ProfilerQuestion[] = [
  {
    id: "m_passions",
    gender: "male",
    priority: "high",
    text: {
      en: "What could you talk about for hours?",
      ru: "О чём ты мог бы говорить часами?",
      uk: "Про що ти міг би говорити годинами?",
      de: "Worüber könntest du stundenlang reden?",
      pl: "O czym mógłbyś mówić godzinami?",
    },
  },
  {
    id: "m_ideal_evening",
    gender: "male",
    priority: "high",
    text: {
      en: "What does your ideal evening with someone new look like?",
      ru: "Как выглядит твой идеальный вечер с новым человеком?",
      uk: "Який вигляд має твій ідеальний вечір з новою людиною?",
      de: "Wie sieht dein idealer Abend mit einer neuen Person aus?",
      pl: "Jak wygląda twój idealny wieczór z nową osobą?",
    },
  },
  {
    id: "m_sport",
    gender: "male",
    priority: "high",
    text: {
      en: "Do you play any sports? Which ones?",
      ru: "Ты занимаешься спортом? Каким?",
      uk: "Ти займаєшся спортом? Яким?",
      de: "Treibst du Sport? Welchen?",
      pl: "Uprawiasz jakiś sport? Jaki?",
    },
  },
  {
    id: "m_planner",
    gender: "male",
    priority: "medium",
    text: {
      en: "Are you more of a planner, or do you live in the moment?",
      ru: "Ты больше плановый или живёшь моментом?",
      uk: "Ти більше людина плану чи живеш моментом?",
      de: "Bist du eher ein Planer oder lebst du im Moment?",
      pl: "Jesteś bardziej osobą, która planuje, czy żyjesz chwilą?",
    },
  },
  {
    id: "m_surprise",
    gender: "male",
    priority: "medium",
    text: {
      en: "What surprises people about you once they get to know you?",
      ru: "Что в тебе удивляет людей, когда узнают поближе?",
      uk: "Що в тобі дивує людей, коли впізнають ближче?",
      de: "Was überrascht Leute an dir, wenn sie dich näher kennenlernen?",
      pl: "Co zaskakuje ludzi w tobie, gdy poznają cię bliżej?",
    },
  },
  {
    id: "m_media",
    gender: "male",
    priority: "low",
    text: {
      en: "What are you watching, reading, or listening to right now?",
      ru: "Что ты сейчас смотришь, читаешь или слушаешь?",
      uk: "Що ти зараз дивишся, читаєш або слухаєш?",
      de: "Was schaust, liest oder hörst du gerade?",
      pl: "Co teraz oglądasz, czytasz albo czego słuchasz?",
    },
  },
];

/**
 * The ordered question bank for a gender. Order in the array IS the priority
 * order the Profiler asks in (high-priority first). `null` gender → empty
 * (the scheduler skips users without a known gender).
 */
export function profilerQuestionBank(gender: Gender | null): ProfilerQuestion[] {
  if (gender === "female") return FEMALE_QUESTIONS;
  if (gender === "male") return MALE_QUESTIONS;
  return [];
}

/** Look up a question by id across both banks (for the answer handler). */
export function profilerQuestionById(id: string): ProfilerQuestion | undefined {
  return [...FEMALE_QUESTIONS, ...MALE_QUESTIONS].find((q) => q.id === id);
}

/** Localized prompt text for a question, falling back to English. */
export function profilerQuestionText(
  question: ProfilerQuestion,
  language: Language,
): string {
  return question.text[language] ?? question.text.en;
}

export interface ScoredProfilerAnswer {
  question: ProfilerQuestion;
  answer: string;
  weight: number;
}

/**
 * Join answered Profiler rows to their question bank entry and attach the
 * priority weight, dropping skipped/blank rows. Sorted by weight descending so
 * the highest-signal answers lead the generation prompt.
 */
export function scoreProfilerAnswers(
  rows: Array<{ questionId: string; answerText: string | null }> | null | undefined,
): ScoredProfilerAnswer[] {
  const scored: ScoredProfilerAnswer[] = [];
  if (!Array.isArray(rows)) return scored;
  for (const row of rows) {
    const answer = row.answerText?.trim();
    if (!answer) continue;
    const question = profilerQuestionById(row.questionId);
    if (!question) continue;
    scored.push({ question, answer, weight: profilerPriorityWeight(question.priority) });
  }
  return scored.sort((a, b) => b.weight - a.weight);
}

/**
 * Render scored answers into a weighted text block for an LLM prompt, in the
 * reader's language. Returns null when there's nothing to render so callers can
 * fall back to the psychological summary. Each line is tagged with its weight
 * so the model emphasises high-priority answers (spec §5.3).
 */
export function formatProfilerAnswersBlock(
  scored: ScoredProfilerAnswer[],
  language: Language,
): string | null {
  if (scored.length === 0) return null;
  return scored
    .map(
      (s) =>
        `- [weight ${s.weight.toFixed(1)}] ${profilerQuestionText(s.question, language)} → ${s.answer}`,
    )
    .join("\n");
}
