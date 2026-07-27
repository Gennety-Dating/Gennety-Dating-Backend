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
 *
 * De-duplication note (PRODUCT_SPEC §3.2): the "vibe" axis is now collected at
 * onboarding via the two free-text questions (`friday_vibe` / `vibe_focus`),
 * so the Profiler questions that duplicated it were removed — `f_activity_pref`
 * ("active vs calm" = the energy axis) and `m_ideal_evening` (≈ the Friday
 * question). The remaining bank is icebreaker-only flavor that onboarding does
 * NOT capture (chronotype, sport, turn-offs, shared-interests, media, surprises,
 * communication style).
 *
 * Two kinds of question live here (`refresh`):
 *   - **`"once"`** (default) — a stable trait. Asked once, answered forever
 *     (lark/owl doesn't change).
 *   - **`"cycle"`** — a *situational* question whose answer is a snapshot of
 *     right now ("what are you watching", "plans for the weekend"). Re-asked
 *     each drop cycle, its answer overwriting the previous one. Without these
 *     the bank simply runs out after a couple of days and the Profiler goes
 *     quiet; with them the icebreaker fuel stays current, which is the whole
 *     point of asking weekly rather than at signup.
 */

export type ProfilerPriority = "high" | "medium" | "low";

/**
 * Whether a question is asked once for good, or re-asked every drop cycle
 * because its answer is a snapshot of the present.
 */
export type ProfilerRefresh = "once" | "cycle";

export interface ProfilerQuestion {
  /** Stable identifier persisted on `ProfilerAnswer.questionId`. */
  id: string;
  /** Which gender's bank this question belongs to. */
  gender: Gender;
  priority: ProfilerPriority;
  /** Re-ask policy; omitted = `"once"`. */
  refresh?: ProfilerRefresh;
  /** Localized prompt text, keyed by language. */
  text: Record<Language, string>;
}

/** True when the question's answer goes stale and should be re-asked each cycle. */
export function isRefreshableProfilerQuestion(question: ProfilerQuestion): boolean {
  return question.refresh === "cycle";
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
    id: "f_weekend_plans",
    gender: "female",
    priority: "high",
    refresh: "cycle",
    text: {
      en: "Any plans for the coming weekend?",
      ru: "Какие планы на ближайшие выходные?",
      uk: "Які плани на найближчі вихідні?",
      de: "Hast du Pläne für das kommende Wochenende?",
      pl: "Masz jakieś plany na najbliższy weekend?",
    },
  },
  {
    id: "f_initiative",
    gender: "female",
    priority: "high",
    text: {
      en: "Do you like it when a guy plans the date himself, or would you rather decide together?",
      ru: "Тебе нравится, когда парень сам планирует свидание, или лучше решать вместе?",
      uk: "Тобі подобається, коли хлопець сам планує побачення, чи краще вирішувати разом?",
      de: "Magst du es, wenn ein Typ das Date selbst plant, oder entscheidest du lieber gemeinsam?",
      pl: "Lubisz, gdy chłopak sam planuje randkę, czy wolisz decydować wspólnie?",
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
    id: "f_food",
    gender: "female",
    priority: "medium",
    text: {
      en: "What food could you eat any day — and is there anything you never eat?",
      ru: "Какую еду ты могла бы есть хоть каждый день — и есть ли то, что не ешь совсем?",
      uk: "Яку їжу ти могла б їсти хоч щодня — і чи є те, чого не їси зовсім?",
      de: "Welches Essen könntest du jeden Tag essen — und gibt es etwas, das du gar nicht isst?",
      pl: "Jakie jedzenie mogłabyś jeść codziennie — i czy jest coś, czego w ogóle nie jesz?",
    },
  },
  {
    id: "f_humor",
    gender: "female",
    priority: "medium",
    text: {
      en: "What actually makes you laugh?",
      ru: "Что тебя правда смешит?",
      uk: "Що тебе справді смішить?",
      de: "Worüber lachst du wirklich?",
      pl: "Co naprawdę cię śmieszy?",
    },
  },
  {
    id: "f_week_highlight",
    gender: "female",
    priority: "medium",
    refresh: "cycle",
    text: {
      en: "What was the best part of your week?",
      ru: "Что было самым классным на этой неделе?",
      uk: "Що було найкращим цього тижня?",
      de: "Was war das Beste an deiner Woche?",
      pl: "Co było najlepsze w twoim tygodniu?",
    },
  },
  {
    id: "f_media",
    gender: "female",
    priority: "low",
    refresh: "cycle",
    text: {
      en: "What are you watching, reading, or listening to right now?",
      ru: "Что ты сейчас смотришь, читаешь или слушаешь?",
      uk: "Що ти зараз дивишся, читаєш або слухаєш?",
      de: "Was schaust, liest oder hörst du gerade?",
      pl: "Co teraz oglądasz, czytasz albo czego słuchasz?",
    },
  },
  {
    id: "f_travel",
    gender: "female",
    priority: "low",
    text: {
      en: "If you could leave for anywhere tomorrow, where would you go?",
      ru: "Если бы завтра можно было уехать куда угодно — куда бы поехала?",
      uk: "Якби завтра можна було поїхати куди завгодно — куди б поїхала?",
      de: "Wenn du morgen überallhin könntest — wohin würdest du fahren?",
      pl: "Gdybyś jutro mogła wyjechać gdziekolwiek — dokąd byś pojechała?",
    },
  },
  {
    id: "f_learning",
    gender: "female",
    priority: "low",
    text: {
      en: "Is there something you'd love to learn but keep putting off?",
      ru: "Есть что-то, чему хотела бы научиться, но всё откладываешь?",
      uk: "Є щось, чого хотіла б навчитися, але все відкладаєш?",
      de: "Gibt es etwas, das du gern lernen würdest, aber immer aufschiebst?",
      pl: "Jest coś, czego chciałabyś się nauczyć, ale ciągle to odkładasz?",
    },
  },
  {
    id: "f_pets",
    gender: "female",
    priority: "low",
    text: {
      en: "Animals — do you have any, or want to?",
      ru: "Животные — есть или хотелось бы?",
      uk: "Тварини — є чи хотілося б?",
      de: "Tiere — hast du welche oder hättest du gern welche?",
      pl: "Zwierzaki — masz jakieś albo chciałabyś mieć?",
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
    id: "m_chronotype",
    gender: "male",
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
    id: "m_weekend_plans",
    gender: "male",
    priority: "high",
    refresh: "cycle",
    text: {
      en: "Any plans for the coming weekend?",
      ru: "Какие планы на ближайшие выходные?",
      uk: "Які плани на найближчі вихідні?",
      de: "Hast du Pläne für das kommende Wochenende?",
      pl: "Masz jakieś plany na najbliższy weekend?",
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
      ru: "Что в тебе удивляет людей, когда они узнают тебя поближе?",
      uk: "Що в тобі дивує людей, коли вони пізнають тебе ближче?",
      de: "Was überrascht Leute an dir, wenn sie dich näher kennenlernen?",
      pl: "Co zaskakuje ludzi w tobie, gdy poznają cię bliżej?",
    },
  },
  {
    id: "m_food",
    gender: "male",
    priority: "medium",
    text: {
      en: "What food could you eat any day — and is there anything you never eat?",
      ru: "Какую еду ты мог бы есть хоть каждый день — и есть ли то, что не ешь совсем?",
      uk: "Яку їжу ти міг би їсти хоч щодня — і чи є те, чого не їси зовсім?",
      de: "Welches Essen könntest du jeden Tag essen — und gibt es etwas, das du gar nicht isst?",
      pl: "Jakie jedzenie mógłbyś jeść codziennie — i czy jest coś, czego w ogóle nie jesz?",
    },
  },
  {
    id: "m_humor",
    gender: "male",
    priority: "medium",
    text: {
      en: "What actually makes you laugh?",
      ru: "Что тебя правда смешит?",
      uk: "Що тебе справді смішить?",
      de: "Worüber lachst du wirklich?",
      pl: "Co naprawdę cię śmieszy?",
    },
  },
  {
    id: "m_friends_say",
    gender: "male",
    priority: "medium",
    text: {
      en: "How would your friends describe you in three words?",
      ru: "Как тебя описали бы друзья тремя словами?",
      uk: "Як тебе описали б друзі трьома словами?",
      de: "Wie würden dich deine Freunde in drei Worten beschreiben?",
      pl: "Jak opisaliby cię znajomi w trzech słowach?",
    },
  },
  {
    id: "m_week_highlight",
    gender: "male",
    priority: "medium",
    refresh: "cycle",
    text: {
      en: "What was the best part of your week?",
      ru: "Что было самым классным на этой неделе?",
      uk: "Що було найкращим цього тижня?",
      de: "Was war das Beste an deiner Woche?",
      pl: "Co było najlepsze w twoim tygodniu?",
    },
  },
  {
    id: "m_media",
    gender: "male",
    priority: "low",
    refresh: "cycle",
    text: {
      en: "What are you watching, reading, or listening to right now?",
      ru: "Что ты сейчас смотришь, читаешь или слушаешь?",
      uk: "Що ти зараз дивишся, читаєш або слухаєш?",
      de: "Was schaust, liest oder hörst du gerade?",
      pl: "Co teraz oglądasz, czytasz albo czego słuchasz?",
    },
  },
  {
    id: "m_travel",
    gender: "male",
    priority: "low",
    text: {
      en: "If you could leave for anywhere tomorrow, where would you go?",
      ru: "Если бы завтра можно было уехать куда угодно — куда бы поехал?",
      uk: "Якби завтра можна було поїхати куди завгодно — куди б поїхав?",
      de: "Wenn du morgen überallhin könntest — wohin würdest du fahren?",
      pl: "Gdybyś jutro mógł wyjechać gdziekolwiek — dokąd byś pojechał?",
    },
  },
  {
    id: "m_learning",
    gender: "male",
    priority: "low",
    text: {
      en: "Is there something you'd love to learn but keep putting off?",
      ru: "Есть что-то, чему хотел бы научиться, но всё откладываешь?",
      uk: "Є щось, чого хотів би навчитися, але все відкладаєш?",
      de: "Gibt es etwas, das du gern lernen würdest, aber immer aufschiebst?",
      pl: "Jest coś, czego chciałbyś się nauczyć, ale ciągle to odkładasz?",
    },
  },
  {
    id: "m_pets",
    gender: "male",
    priority: "low",
    text: {
      en: "Animals — do you have any, or want to?",
      ru: "Животные — есть или хотелось бы?",
      uk: "Тварини — є чи хотілося б?",
      de: "Tiere — hast du welche oder hättest du gern welche?",
      pl: "Zwierzaki — masz jakieś albo chciałbyś mieć?",
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
