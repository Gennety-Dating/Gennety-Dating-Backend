import {
  type AiMemoryExportPreference,
  type Gender,
  type GenderPreference,
  type Language,
  Prisma,
  prisma,
} from "@gennety/db";
import { openaiFetch } from "./openai-fetch.js";
import {
  contextDumpInstruction,
  MAX_AGE,
  MIN_AGE,
  MIN_PHOTOS,
} from "@gennety/shared";
import { env } from "../config.js";
import type { ChatMessage } from "./onboarding-agent.js";

export const ONBOARDING_COLLECTOR_VERSION = 1;

export const ONBOARDING_FIELDS = [
  "first_name",
  "age",
  "gender",
  "preference",
  "height",
  "hobbies",
  "partner_preferences",
  "ethnicity",
  "friday_vibe",
  "vibe_focus",
  "ai_memory",
  "context_dump",
  "photos",
] as const;

export type OnboardingField = (typeof ONBOARDING_FIELDS)[number];

export const ONBOARDING_QUESTIONS = [
  "first_name_age",
  "gender",
  "preference",
  "height",
  "hobbies",
  "partner_preferences",
  "ethnicity",
  "friday_vibe",
  "vibe_focus",
  "ai_memory",
  "context_dump",
  "photos",
  "complete",
] as const;

export type OnboardingQuestion = (typeof ONBOARDING_QUESTIONS)[number];

export type OnboardingInput =
  | { kind: "user_text"; text: string }
  | { kind: "resume" }
  | { kind: "context_dump"; text: string }
  | { kind: "photos_updated"; count?: number }
  | { kind: "photos_continue" };

type CandidateValue = string | number | string[];

export interface FactCandidate {
  field: OnboardingField;
  evidence: string;
  value: CandidateValue;
}

/**
 * Per-message intent classification from the extractor. The server still owns
 * progress; this only tells the collector whether the user actually answered,
 * is correcting a previous value, or asked a clarifying question instead of
 * answering (so we must not record their question as the answer).
 */
export type OnboardingIntent =
  | "answer"
  | "clarifying_question"
  | "correction"
  | "refusal";

export const ONBOARDING_INTENTS = [
  "answer",
  "clarifying_question",
  "correction",
  "refusal",
] as const;

export interface ExtractionResult {
  candidates: FactCandidate[];
  intent: OnboardingIntent;
}

export interface RejectedCandidate {
  field: OnboardingField;
  reason: string;
}

export interface CollectorSnapshot {
  userId: string;
  language: Language;
  completedFields: OnboardingField[];
  skippedFields: OnboardingField[];
  askedFields: OnboardingField[];
  currentQuestion: OnboardingQuestion;
  revision: number;
  acceptedFields: OnboardingField[];
  rejectedFields: RejectedCandidate[];
  /**
   * True when the user asked a clarifying question instead of answering. The
   * collector recorded nothing and did not advance; the caller should answer
   * briefly and re-pose the same question.
   */
  needsClarification: boolean;
  /**
   * True when a real text answer produced no accepted fact and the question
   * did not move — the caller should explain what kind of answer works
   * instead of silently re-asking the same question verbatim.
   */
  unparsedAnswer: boolean;
}

export interface CollectorDeps {
  extractFacts?: (
    text: string,
    question: OnboardingQuestion,
    language: Language,
  ) => Promise<ExtractionResult>;
  fetchFn?: typeof fetch;
}

interface CollectorUser {
  id: string;
  telegramId: bigint;
  language: Language | null;
  firstName: string | null;
  age: number | null;
  gender: Gender | null;
  preference: GenderPreference | null;
  aiMemoryExportPreference: AiMemoryExportPreference;
  messageHistory: Prisma.JsonValue[];
  profile: {
    ethnicity: string | null;
    height: number | null;
    hobbies: string[];
    partnerPreferences: string | null;
    fridayVibeText: string | null;
    vibeFocusText: string | null;
    psychologicalSummary: string | null;
    photos: string[];
  } | null;
  onboardingProgress: {
    completedFields: string[];
    skippedFields: string[];
    askedFields: string[];
    currentQuestion: string | null;
    collectorVersion: number;
    revision: number;
    backfilledAt: Date | null;
  } | null;
}

interface MutableProgress {
  completed: Set<OnboardingField>;
  skipped: Set<OnboardingField>;
  asked: Set<OnboardingField>;
}

class RevisionConflict extends Error {}

const USER_SELECT = {
  id: true,
  telegramId: true,
  language: true,
  firstName: true,
  age: true,
  gender: true,
  preference: true,
  aiMemoryExportPreference: true,
  messageHistory: true,
  profile: {
    select: {
      ethnicity: true,
      height: true,
      hobbies: true,
      partnerPreferences: true,
      fridayVibeText: true,
      vibeFocusText: true,
      psychologicalSummary: true,
      photos: true,
    },
  },
  onboardingProgress: {
    select: {
      completedFields: true,
      skippedFields: true,
      askedFields: true,
      currentQuestion: true,
      collectorVersion: true,
      revision: true,
      backfilledAt: true,
    },
  },
} satisfies Prisma.UserSelect;

const PLACEHOLDERS = new Set([
  "",
  "idk",
  "i don't know",
  "i dont know",
  "not sure",
  "unknown",
  "n/a",
  "none",
  "не знаю",
  "неизвестно",
  "не указано",
  "не вказано",
  "weiß nicht",
  "weiss nicht",
  "nie wiem",
]);

const SKIP_RE =
  /^(?:skip|pass|prefer not|rather not|no answer|пропуст[\p{L}]*|не хочу отвечать|не хочу відповідати|без ответа|без відповіді|überspring[\p{L}]*|möchte ich nicht|pomi(?:ń|jam)|nie chcę odpowiadać)[\s.!?]*$/iu;

// Bare one-word replies to the name+age question are usually the name itself
// ("Максим"), but greetings and interjections must never be saved as a name.
// Deliberately small — the LLM extractor remains the primary path for
// anything ambiguous.
const NOT_A_NAME = new Set([
  "hi", "hello", "hey", "yo", "ok", "okay", "yes", "no", "thanks", "sure",
  "привет", "здравствуй", "здравствуйте", "хай", "ку", "да", "нет", "ок",
  "окей", "ага", "угу", "спасибо", "хорошо", "ладно",
  "привіт", "вітаю", "так", "ні", "дякую", "добре", "гаразд",
  "hallo", "servus", "moin", "ja", "nein", "danke", "gut",
  "cześć", "hej", "siema", "tak", "nie", "dzięki", "dziękuję", "dobrze",
  "start", "старт",
]);

const NO_HOBBIES_RE =
  /(?:no hobbies|don't have (?:any )?hobbies|do not have (?:any )?hobbies|нет хобби|немає хобі|не маю хобі|keine hobbies|mam żadnych hobby|nie mam hobby)/iu;

// High-precision meta-question detector. Kept deliberately narrow so a real
// free-text answer is never misread as a question: it fires on explicit
// "what do you mean / why do you ask" phrasings, or a very short message that
// is only a question mark. The LLM extractor's `intent` field is the primary
// signal; this is the deterministic floor when the extractor is unavailable.
const META_QUESTION_RE =
  /(what (?:do|did) you mean|what does that mean|why (?:do|are) you (?:ask|asking)|can you explain|could you explain|not sure what you (?:mean|are asking)|что (?:ты |вы )?имеешь в виду|что (?:это )?значит|в смысле\?|зачем (?:тебе |вам )?(?:это|знать|спрашива)|не (?:совсем )?пон(?:ял|яла|имаю)|поясни|объясни|що (?:ти |ви )?маєш на увазі|що це означає|навіщо (?:тобі |вам )?(?:це|знати)|поясни|was meinst du|wie meinst du (?:das)?|warum fragst|kannst du das erklären|co masz na myśli|dlaczego pytasz|wyjaśnij)/iu;

/**
 * Whether a message is most likely a question/confusion aimed at the bot
 * rather than an answer. Used to (a) stop the free-text fallback from saving a
 * question as the answer and (b) route the turn to a clarification reply.
 */
export function isLikelyMetaQuestion(text: string): boolean {
  const trimmed = normalizeText(text);
  if (!trimmed) return false;
  if (META_QUESTION_RE.test(trimmed)) return true;
  // A short message ending in a question mark with no substantive content.
  // Bounded to ≤6 words so a longer answer that happens to contain a "?" is
  // not swallowed.
  return /\?\s*$/.test(trimmed) && trimmed.split(/\s+/).length <= 6;
}

function asField(value: string): OnboardingField | null {
  return (ONBOARDING_FIELDS as readonly string[]).includes(value)
    ? (value as OnboardingField)
    : null;
}

function asQuestion(value: string | null): OnboardingQuestion | null {
  return value && (ONBOARDING_QUESTIONS as readonly string[]).includes(value)
    ? (value as OnboardingQuestion)
    : null;
}

function languageOf(user: CollectorUser): Language {
  return user.language ?? "en";
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizedPlaceholder(value: string): boolean {
  return PLACEHOLDERS.has(normalizeText(value).toLowerCase().replace(/[.!?]+$/g, ""));
}

// Lowercased, punctuation-stripped, whitespace-collapsed view of a message for
// matching short categorical answers: "И тех, и тех." must compare equal to
// "и тех и тех". Hyphens are kept (names like Анна-Мария).
function matchableText(value: string): string {
  return normalizeText(value.replace(/[.,!?;:…()[\]{}«»„“”"'`]+/gu, " ")).toLocaleLowerCase();
}

// Some extractor models (e.g. gpt-5.4-mini) wrap the `evidence` quote in
// literal quotation marks ("\"I prefer women\""). The raw user message has no
// such characters, so a strict substring check would reject every
// LLM-extracted fact and silently degrade the collector to regex-only,
// re-asking questions the user already answered. Strip wrapping quotes (ASCII
// and smart/guillemet variants) before comparing, keeping the direct check
// first so clean evidence is unaffected.
const WRAPPING_QUOTES = /^[\s"'`«»„“”‚‘’]+|[\s"'`«»„“”‚‘’]+$/gu;

function stripWrappingQuotes(value: string): string {
  return value.replace(WRAPPING_QUOTES, "");
}

function exactEvidence(text: string, evidence: string): boolean {
  // Whitespace-normalize the haystack too — a double space in the user
  // message must not reject otherwise-exact evidence.
  const haystack = normalizeText(text).toLocaleLowerCase();
  const direct = normalizeText(evidence);
  if (direct.length > 0 && haystack.includes(direct.toLocaleLowerCase())) {
    return true;
  }
  const unquoted = normalizeText(stripWrappingQuotes(evidence));
  if (unquoted.length > 0 && haystack.includes(unquoted.toLocaleLowerCase())) {
    return true;
  }
  // Punctuation-insensitive tier: extractors quote "и тех и тех" for the
  // message "И тех, и тех". The words must still appear contiguously and in
  // order, so this stays an anti-hallucination check.
  const matchableNeedle = matchableText(stripWrappingQuotes(evidence));
  return (
    matchableNeedle.length > 0 && matchableText(text).includes(matchableNeedle)
  );
}

function uniqueFields(values: Iterable<OnboardingField>): OnboardingField[] {
  return [...new Set(values)];
}

function progressFromUser(user: CollectorUser): MutableProgress {
  const completed = new Set<OnboardingField>();
  const skipped = new Set<OnboardingField>();
  const asked = new Set<OnboardingField>();

  for (const value of user.onboardingProgress?.completedFields ?? []) {
    const field = asField(value);
    if (field) completed.add(field);
  }
  for (const value of user.onboardingProgress?.skippedFields ?? []) {
    const field = asField(value);
    if (field) skipped.add(field);
  }
  for (const value of user.onboardingProgress?.askedFields ?? []) {
    const field = asField(value);
    if (field) asked.add(field);
  }

  if (user.firstName) completed.add("first_name");
  if (user.age !== null) completed.add("age");
  if (user.gender) completed.add("gender");
  if (user.preference) completed.add("preference");
  if (user.profile?.height !== null && user.profile?.height !== undefined) {
    completed.add("height");
  }
  if (user.profile?.partnerPreferences) completed.add("partner_preferences");
  if (user.profile?.ethnicity) completed.add("ethnicity");
  if (user.profile?.fridayVibeText) completed.add("friday_vibe");
  if (user.profile?.vibeFocusText) completed.add("vibe_focus");
  if ((user.profile?.hobbies.length ?? 0) > 0) completed.add("hobbies");
  if (user.aiMemoryExportPreference !== "undecided") completed.add("ai_memory");
  if (
    user.aiMemoryExportPreference === "declined" ||
    user.profile?.psychologicalSummary
  ) {
    completed.add("context_dump");
    if (user.aiMemoryExportPreference === "declined") skipped.add("context_dump");
  }
  if ((user.profile?.photos.length ?? 0) >= MIN_PHOTOS) completed.add("photos");

  return { completed, skipped, asked };
}

export function nextOnboardingQuestion(
  progress: MutableProgress,
): OnboardingQuestion {
  if (
    !progress.completed.has("first_name") ||
    !progress.completed.has("age")
  ) {
    return "first_name_age";
  }
  if (!progress.completed.has("gender")) return "gender";
  if (!progress.completed.has("preference")) return "preference";
  if (!progress.completed.has("height")) return "height";
  if (!progress.completed.has("hobbies")) return "hobbies";
  if (!progress.completed.has("partner_preferences")) {
    return "partner_preferences";
  }
  if (
    !progress.completed.has("ethnicity") &&
    !progress.skipped.has("ethnicity")
  ) {
    return "ethnicity";
  }
  // Vibe questions sit right before the Magic Prompt step so every user — even
  // those who decline AI-memory export — supplies the signal (PRODUCT_SPEC §1.3).
  if (!progress.completed.has("friday_vibe")) return "friday_vibe";
  if (!progress.completed.has("vibe_focus")) return "vibe_focus";
  if (!progress.completed.has("ai_memory")) return "ai_memory";
  if (!progress.completed.has("context_dump")) return "context_dump";
  if (!progress.completed.has("photos")) return "photos";
  return "complete";
}

function questionField(question: OnboardingQuestion): OnboardingField | null {
  if (question === "first_name_age" || question === "complete") return null;
  return question;
}

function inferQuestionFromAssistant(text: string): OnboardingQuestion | null {
  const lower = text.toLowerCase();
  if (
    /(how tall|height|рост|зріст|wzrost|groß bist|größe)/iu.test(lower)
  ) {
    return "height";
  }
  if (
    /(hobb|interests|увлека|захоп|інтерес|zainteres|freizeit)/iu.test(lower)
  ) {
    return "hobbies";
  }
  if (
    /(nationality|ethnic|background|националь|національ|етніч|narodowo|pochodzen|herkunft)/iu.test(
      lower,
    )
  ) {
    return "ethnicity";
  }
  if (
    /(friday night|пятниц|п'ятниц|freitagabend|piątkowy wieczór|piątkowy wieczor)/iu.test(
      lower,
    )
  ) {
    return "friday_vibe";
  }
  if (
    /(experience itself|who's with you|сам процесс или кто|сам процес чи хто|erlebnis selbst|samo przeżycie czy)/iu.test(
      lower,
    )
  ) {
    return "vibe_focus";
  }
  if (
    /(looking for in a partner|what kind of (?:person|partner)|ideal partner|важно в партн|ищешь в партн|какого партн|шукаєш у партн|якого партн|partnerze|partnerin|partner wichtig)/iu.test(
      lower,
    )
  ) {
    return "partner_preferences";
  }
  if (
    /(who (?:do|are) you (?:want|like|looking)|men, women|парни|девушки|хлопці|дівчата|mężczy|kobiet|männer|frauen)/iu.test(
      lower,
    )
  ) {
    return "preference";
  }
  if (
    /(your gender|man or woman|парень или девушка|хлопець чи дівчина|mężczyzną czy kobietą|mann oder frau)/iu.test(
      lower,
    )
  ) {
    return "gender";
  }
  if (
    /(your name|call you|how old|как.*зовут|сколько.*лет|як.*звати|скільки.*років|wie.*heiß|wie alt|jak.*masz na imię|ile masz lat)/iu.test(
      lower,
    )
  ) {
    return "first_name_age";
  }
  return null;
}

function heightCandidate(text: string): FactCandidate | null {
  const metric = text.match(
    /(?<!\d)(1[4-9]\d|2[01]\d|220)\s*(?:cm|cms|centimet(?:er|re)s?|см|сантиметр(?:а|ов|ів|и)?|zentimeter|centymetr(?:y|ów)?)(?!\p{L})/iu,
  );
  if (metric) {
    return { field: "height", evidence: metric[0], value: Number(metric[1]) };
  }

  const imperial = text.match(
    /(?<!\d)([4-7])\s*(?:'|ft|feet|foot)\s*(?:(1[01]|\d)\s*(?:"|in|inches?))?/iu,
  );
  if (imperial) {
    const inches = Number(imperial[1]) * 12 + Number(imperial[2] ?? 0);
    return {
      field: "height",
      evidence: imperial[0],
      value: Math.round(inches * 2.54),
    };
  }
  return null;
}

function ageCandidate(text: string, question: OnboardingQuestion): FactCandidate | null {
  // `(?<!\d)(\d{2})(?!\d)` keeps the two digits a standalone number so a
  // height like "I'm 183cm" cannot be misread as age 18.
  const patterns = [
    /(?:i am|i'm|im|aged)\s+(?<!\d)(\d{2})(?!\d)(?:\s*(?:years? old))?/iu,
    /(?:мне|мені)\s+(?<!\d)(\d{2})(?!\d)(?:\s*(?:лет|год|года|років|роки))?/iu,
    /(?:ich bin)\s+(?<!\d)(\d{2})(?!\d)(?:\s*jahre)?/iu,
    /(?:mam)\s+(?<!\d)(\d{2})(?!\d)\s+lat/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { field: "age", evidence: match[0], value: Number(match[1]) };
  }
  if (question === "first_name_age") {
    const match = text.match(/(?:^|[,;])\s*(\d{2})\s*(?:$|[.!?])/u);
    if (match) return { field: "age", evidence: match[1], value: Number(match[1]) };
  }
  return null;
}

function nameCandidate(
  text: string,
  question: OnboardingQuestion,
  completed?: ReadonlySet<OnboardingField>,
): FactCandidate | null {
  const patterns = [
    /(?:my name is|call me)\s+([\p{L}'-]{2,40})/iu,
    /(?:меня зовут|мене звати)\s+([\p{L}'-]{2,40})/iu,
    /(?:ich heiße|ich heisse)\s+([\p{L}'-]{2,40})/iu,
    /(?:mam na imię)\s+([\p{L}'-]{2,40})/iu,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return { field: "first_name", evidence: match[1], value: match[1] };
  }
  if (question === "first_name_age") {
    const match = text.match(/^\s*([\p{L}'-]{2,40})\s*(?:,|;|\s+\d{2}\b)/u);
    if (match) return { field: "first_name", evidence: match[1], value: match[1] };
    // A bare one-word reply to the name+age question is the name itself —
    // unless the name is already on file (a lone word is then more likely a
    // stray remark than a rename) or the word is a greeting/interjection.
    const bare = text.match(/^\s*([\p{L}'-]{2,40})[\s.!?]*$/u);
    if (
      bare &&
      !completed?.has("first_name") &&
      !NOT_A_NAME.has(bare[1].toLocaleLowerCase()) &&
      !normalizedPlaceholder(bare[1])
    ) {
      return { field: "first_name", evidence: bare[1], value: bare[1] };
    }
  }
  return null;
}

function genderCandidate(text: string, question: OnboardingQuestion): FactCandidate | null {
  const female =
    /\b(?:i am|i'm|im)\s+(?:a\s+)?(?:woman|girl|female)\b|я\s+(?:девушка|девочка|женщина|дівчина|жінка)|jestem\s+(?:kobietą|dziewczyną)|ich bin\s+(?:eine\s+)?frau/iu;
  const male =
    /\b(?:i am|i'm|im)\s+(?:a\s+)?(?:man|guy|boy|male)\b|я\s+(?:парень|мужчина|хлопець|чоловік)|jestem\s+(?:mężczyzną|chłopakiem)|ich bin\s+(?:ein\s+)?mann/iu;
  const femaleMatch = text.match(female);
  if (femaleMatch) {
    return { field: "gender", evidence: femaleMatch[0], value: "female" };
  }
  const maleMatch = text.match(male);
  if (maleMatch) {
    return { field: "gender", evidence: maleMatch[0], value: "male" };
  }
  if (question === "gender") {
    const bare = matchableText(text);
    if (
      /^(?:female|woman|girl|девушка|девочка|женщина|дівчина|жінка|kobieta|dziewczyna|frau|ж|f|w|k)$/iu.test(
        bare,
      )
    ) {
      return { field: "gender", evidence: text.trim(), value: "female" };
    }
    if (
      /^(?:male|man|guy|boy|парень|мужчина|хлопець|чоловік|mężczyzna|chłopak|mann|м|m)$/iu.test(
        bare,
      )
    ) {
      return { field: "gender", evidence: text.trim(), value: "male" };
    }
  }
  return null;
}

function preferenceCandidate(
  text: string,
  question: OnboardingQuestion,
): FactCandidate | null {
  // Matched against the punctuation-stripped view so "И тех, и тех." works.
  // Cyrillic/Polish tokens use \p{L} lookarounds instead of \b (which only
  // understands ASCII word characters), so short forms like "оба" cannot fire
  // inside another word ("обаятельный").
  const matchable = matchableText(text);
  const both = matchable.match(
    /\b(?:both|men and women|women and men|all genders)\b|(?<!\p{L})(?:и парни и девушки|и мужчины и женщины|і хлопці і дівчата|обоих|обох|mężczyźni i kobiety|männer und frauen)(?!\p{L})/iu,
  );
  if (both) return { field: "preference", evidence: both[0], value: "both" };

  // Colloquial "both" forms that only make sense as a direct answer to the
  // preference question ("и тех, и тех", "either", "оба") — scoped to the
  // current question so they can never fire inside unrelated free text.
  if (question === "preference") {
    const colloquialBoth = matchable.match(
      /\b(?:both of them|everyone|either|anyone|beide)\b|(?<!\p{L})(?:тех и тех|тих і тих|оба|обе|обеих|обоє|обидва|обидві|oboje|obie grupy)(?!\p{L})/iu,
    );
    if (colloquialBoth) {
      return { field: "preference", evidence: colloquialBoth[0], value: "both" };
    }
  }

  const men = matchable.match(
    /(?:looking for|interested in|like|date|ищу|нравятся|подобаються|шукаю|szukam|lubię|suche)\s+(?:a\s+)?(?:men|man|guys|boys|мужчин|мужчину|парней|парня|чоловіків|хлопців|mężczyzn|männer)/iu,
  );
  if (men) return { field: "preference", evidence: men[0], value: "men" };

  const women = matchable.match(
    /(?:looking for|interested in|like|date|ищу|нравятся|подобаються|шукаю|szukam|lubię|suche)\s+(?:a\s+)?(?:women|woman|girls|girl|женщин|женщину|девушек|девушку|жінок|дівчат|kobiet|frauen)/iu,
  );
  if (women) return { field: "preference", evidence: women[0], value: "women" };

  if (question === "preference") {
    // Bare-token answers include the declensions the question text itself
    // offers ("парней, девушек или обоих?" → "парней").
    if (
      /^(?:men|guys|boys|мужчины|мужчин|парни|парней|парня|чоловіки|чоловіків|хлопці|хлопців|mężczyźni|mężczyzn|männer|männern)$/iu.test(
        matchable,
      )
    ) {
      return { field: "preference", evidence: text.trim(), value: "men" };
    }
    if (
      /^(?:women|girls|женщины|женщин|девушки|девушек|девушку|жінки|жінок|дівчата|дівчат|kobiety|kobiet|frauen)$/iu.test(
        matchable,
      )
    ) {
      return { field: "preference", evidence: text.trim(), value: "women" };
    }
  }
  return null;
}

function aiMemoryCandidate(
  text: string,
  question: OnboardingQuestion,
): FactCandidate | null {
  if (question !== "ai_memory") return null;
  if (/^(?:yes|accept|connect|да|так|ja|yes please|давай)[\s.!?]*$/iu.test(text.trim())) {
    return { field: "ai_memory", evidence: text.trim(), value: "accepted" };
  }
  if (/^(?:no|decline|skip|нет|ні|nein|nie)[\s.!?]*$/iu.test(text.trim())) {
    return { field: "ai_memory", evidence: text.trim(), value: "declined" };
  }
  return null;
}

export function deterministicCandidates(
  text: string,
  question: OnboardingQuestion,
  completed?: ReadonlySet<OnboardingField>,
): FactCandidate[] {
  const candidates = [
    nameCandidate(text, question, completed),
    ageCandidate(text, question),
    genderCandidate(text, question),
    preferenceCandidate(text, question),
    heightCandidate(text),
    aiMemoryCandidate(text, question),
  ].filter((candidate): candidate is FactCandidate => candidate !== null);

  const trimmed = text.trim();
  if (question === "height" && !candidates.some((candidate) => candidate.field === "height")) {
    const match = trimmed.match(/^(1[4-9]\d|2[01]\d|220)$/u);
    if (match) {
      candidates.push({ field: "height", evidence: match[0], value: Number(match[1]) });
    }
  }
  const containsOtherExplicitField = candidates.some(
    (candidate) => candidate.field !== question,
  );
  // A free-text question/confusion ("what do you mean?") must NOT be captured
  // as the answer. Guard the whole-message fallbacks for the free-text fields.
  const freeTextLooksLikeQuestion = isLikelyMetaQuestion(trimmed);
  if (
    question === "hobbies" &&
    !containsOtherExplicitField &&
    !freeTextLooksLikeQuestion
  ) {
    candidates.push({
      field: "hobbies",
      evidence: trimmed,
      value: NO_HOBBIES_RE.test(trimmed)
        ? []
        : trimmed
            .split(/[,;]|\s+(?:and|и|та|und|i)\s+/iu)
            .map((value) => value.trim())
            .filter(Boolean),
    });
  }
  if (
    question === "partner_preferences" &&
    !containsOtherExplicitField &&
    !freeTextLooksLikeQuestion
  ) {
    candidates.push({
      field: "partner_preferences",
      evidence: trimmed,
      value: trimmed,
    });
  }
  if (
    question === "friday_vibe" &&
    !containsOtherExplicitField &&
    !freeTextLooksLikeQuestion
  ) {
    candidates.push({ field: "friday_vibe", evidence: trimmed, value: trimmed });
  }
  if (
    question === "vibe_focus" &&
    !containsOtherExplicitField &&
    !freeTextLooksLikeQuestion
  ) {
    candidates.push({ field: "vibe_focus", evidence: trimmed, value: trimmed });
  }
  if (
    question === "ethnicity" &&
    !containsOtherExplicitField &&
    !SKIP_RE.test(trimmed) &&
    !freeTextLooksLikeQuestion
  ) {
    candidates.push({ field: "ethnicity", evidence: trimmed, value: trimmed });
  }
  return candidates;
}

function extractorSchema() {
  return {
    name: "onboarding_fact_candidates",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        intent: { type: "string", enum: [...ONBOARDING_INTENTS] },
        candidates: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              field: { type: "string", enum: [...ONBOARDING_FIELDS] },
              evidence: { type: "string" },
              string_value: { type: ["string", "null"] },
              number_value: { type: ["number", "null"] },
              array_value: {
                type: ["array", "null"],
                items: { type: "string" },
              },
            },
            required: [
              "field",
              "evidence",
              "string_value",
              "number_value",
              "array_value",
            ],
          },
        },
      },
      required: ["intent", "candidates"],
    },
  };
}

const EMPTY_EXTRACTION: ExtractionResult = { candidates: [], intent: "answer" };

function asIntent(value: string | undefined): OnboardingIntent {
  return value && (ONBOARDING_INTENTS as readonly string[]).includes(value)
    ? (value as OnboardingIntent)
    : "answer";
}

// Canonical enum values per question, surfaced to the extractor so it can
// normalize colloquial answers ("и тех, и тех" → "both") instead of refusing.
const EXTRACTOR_ALLOWED_VALUES: Partial<
  Record<OnboardingQuestion, readonly string[]>
> = {
  gender: ["male", "female"],
  preference: ["men", "women", "both"],
  ai_memory: ["accepted", "declined"],
};

export async function extractWithOpenAI(
  text: string,
  question: OnboardingQuestion,
  language: Language,
  fetchFn: typeof fetch,
): Promise<ExtractionResult> {
  if (!env.OPENAI_API_KEY) return EMPTY_EXTRACTION;
  const response = await fetchFn("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: "gpt-5.4-mini",
      messages: [
        {
          role: "system",
          content:
            "Extract every fact the user explicitly states, even if it does not match current_question. The user may answer colloquially, in any language, or by pointing at the options offered in question_text (e.g. 'both of them', 'и тех, и тех'). When the meaning of their answer to current_question is clear in context, normalize it to the canonical value — for enum questions the value must be exactly one of allowed_values — and quote the user's answer phrase as evidence. Every candidate must include an exact contiguous quote from the user message as evidence. Normalizing a clearly stated answer is required; inventing a fact the user did not state is forbidden. Never infer gender from a name. Return no candidate for guesses, placeholders ('idk', 'не знаю'), ambiguous replies, or assistant text. Also classify `intent`: 'answer' when they answered, 'correction' when they change a previously given value, 'clarifying_question' when they ask you a question or express confusion instead of answering, 'refusal' when they decline to answer.",
        },
        {
          role: "user",
          content: JSON.stringify({
            language,
            current_question: question,
            question_text: onboardingQuestionText(language, question),
            allowed_values: EXTRACTOR_ALLOWED_VALUES[question] ?? null,
            message: text,
          }),
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: extractorSchema(),
      },
      temperature: 0,
      max_completion_tokens: 800,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    console.warn("[onboarding-collector] extractor failed", response.status);
    return EMPTY_EXTRACTION;
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) return EMPTY_EXTRACTION;
  try {
    const parsed = JSON.parse(content) as {
      intent?: string;
      candidates?: Array<{
        field?: string;
        evidence?: string;
        string_value?: string | null;
        number_value?: number | null;
        array_value?: string[] | null;
      }>;
    };
    const candidates = (parsed.candidates ?? []).flatMap((candidate) => {
      const field = candidate.field ? asField(candidate.field) : null;
      if (!field || !candidate.evidence) return [];
      const value =
        candidate.number_value ??
        candidate.array_value ??
        candidate.string_value;
      if (value === null || value === undefined) return [];
      return [{ field, evidence: candidate.evidence, value }];
    });
    return { candidates, intent: asIntent(parsed.intent) };
  } catch {
    return EMPTY_EXTRACTION;
  }
}

export function validateFactCandidate(
  candidate: FactCandidate,
  text: string,
): { candidate?: FactCandidate; reason?: string } {
  if (!exactEvidence(text, candidate.evidence)) return { reason: "evidence_not_exact" };

  switch (candidate.field) {
    case "first_name": {
      if (typeof candidate.value !== "string") return { reason: "invalid_type" };
      const value = normalizeText(candidate.value);
      if (
        normalizedPlaceholder(value) ||
        !/^[\p{L}'-]{2,40}$/u.test(value)
      ) {
        return { reason: "invalid_name" };
      }
      return { candidate: { ...candidate, value } };
    }
    case "age": {
      if (typeof candidate.value !== "number") return { reason: "invalid_type" };
      const value = Math.round(candidate.value);
      if (value < MIN_AGE || value > MAX_AGE) return { reason: "age_out_of_range" };
      return { candidate: { ...candidate, value } };
    }
    case "gender":
      // A whole-message placeholder ("не знаю") must never be mapped to an
      // enum value, even if an over-helpful extractor tries.
      if (normalizedPlaceholder(text)) return { reason: "placeholder_answer" };
      if (candidate.value !== "male" && candidate.value !== "female") {
        return { reason: "invalid_gender" };
      }
      return { candidate };
    case "preference":
      if (normalizedPlaceholder(text)) return { reason: "placeholder_answer" };
      if (
        candidate.value !== "men" &&
        candidate.value !== "women" &&
        candidate.value !== "both"
      ) {
        return { reason: "invalid_preference" };
      }
      return { candidate };
    case "height": {
      if (typeof candidate.value !== "number") return { reason: "invalid_type" };
      const value = Math.round(candidate.value);
      if (value < 140 || value > 220) return { reason: "height_out_of_range" };
      return { candidate: { ...candidate, value } };
    }
    case "hobbies": {
      if (!Array.isArray(candidate.value)) return { reason: "invalid_type" };
      const value = candidate.value
        .map(normalizeText)
        .filter((item) => item && !normalizedPlaceholder(item))
        .slice(0, 20);
      return { candidate: { ...candidate, value } };
    }
    case "partner_preferences":
    case "ethnicity":
    case "friday_vibe":
    case "vibe_focus": {
      if (typeof candidate.value !== "string") return { reason: "invalid_type" };
      const value = normalizeText(candidate.value);
      if (normalizedPlaceholder(value) || value.length < 2 || value.length > 500) {
        return { reason: "placeholder_or_invalid" };
      }
      return { candidate: { ...candidate, value } };
    }
    case "ai_memory":
      if (normalizedPlaceholder(text)) return { reason: "placeholder_answer" };
      if (candidate.value !== "accepted" && candidate.value !== "declined") {
        return { reason: "invalid_ai_memory_preference" };
      }
      return { candidate };
    case "context_dump":
    case "photos":
      return { reason: "synthetic_field_not_extractable" };
  }
}

function mergeCandidates(
  deterministic: FactCandidate[],
  extracted: FactCandidate[],
): FactCandidate[] {
  const byField = new Map<OnboardingField, FactCandidate>();
  for (const candidate of [...extracted, ...deterministic]) {
    byField.set(candidate.field, candidate);
  }
  return [...byField.values()];
}

function updatesForCandidates(
  candidates: FactCandidate[],
): {
  user: Prisma.UserUpdateInput;
  profileCreate: Prisma.ProfileUncheckedCreateWithoutUserInput;
  profileUpdate: Prisma.ProfileUpdateInput;
} {
  const user: Prisma.UserUpdateInput = {};
  const profileCreate: Prisma.ProfileUncheckedCreateWithoutUserInput = {};
  const profileUpdate: Prisma.ProfileUpdateInput = {};

  for (const candidate of candidates) {
    switch (candidate.field) {
      case "first_name":
        user.firstName = candidate.value as string;
        break;
      case "age":
        user.age = candidate.value as number;
        break;
      case "gender":
        user.gender = candidate.value as Gender;
        break;
      case "preference":
        user.preference = candidate.value as GenderPreference;
        break;
      case "height":
        profileCreate.height = candidate.value as number;
        profileUpdate.height = candidate.value as number;
        break;
      case "hobbies":
        profileCreate.hobbies = candidate.value as string[];
        profileUpdate.hobbies = candidate.value as string[];
        break;
      case "partner_preferences":
        profileCreate.partnerPreferences = candidate.value as string;
        profileUpdate.partnerPreferences = candidate.value as string;
        break;
      case "ethnicity":
        profileCreate.ethnicity = candidate.value as string;
        profileUpdate.ethnicity = candidate.value as string;
        break;
      case "friday_vibe":
        profileCreate.fridayVibeText = candidate.value as string;
        profileUpdate.fridayVibeText = candidate.value as string;
        break;
      case "vibe_focus":
        profileCreate.vibeFocusText = candidate.value as string;
        profileUpdate.vibeFocusText = candidate.value as string;
        break;
      case "ai_memory":
        user.aiMemoryExportPreference = candidate.value as AiMemoryExportPreference;
        user.aiMemoryExportPreferenceAt = new Date();
        break;
      case "context_dump":
      case "photos":
        break;
    }
  }
  return { user, profileCreate, profileUpdate };
}

function rawHistoryMessages(history: Prisma.JsonValue[]): ChatMessage[] {
  return history.flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const message = value as unknown as ChatMessage;
    return message.role ? [message] : [];
  });
}

export function backfillCandidates(history: Prisma.JsonValue[]): {
  candidates: FactCandidate[];
  completed: Set<OnboardingField>;
  skipped: Set<OnboardingField>;
  asked: Set<OnboardingField>;
} {
  const candidates = new Map<OnboardingField, FactCandidate>();
  const completed = new Set<OnboardingField>();
  const skipped = new Set<OnboardingField>();
  const asked = new Set<OnboardingField>();
  let inferredQuestion: OnboardingQuestion = "first_name_age";

  for (const message of rawHistoryMessages(history)) {
    if (message.role === "assistant" && typeof message.content === "string") {
      const inferred = inferQuestionFromAssistant(message.content);
      if (inferred) {
        inferredQuestion = inferred;
        const field = questionField(inferred);
        if (field) asked.add(field);
      }
      continue;
    }
    if (message.role !== "user" || typeof message.content !== "string") continue;
    const text = message.content.trim();
    if (!text || text.startsWith("[")) continue;

    if (inferredQuestion === "ethnicity" && SKIP_RE.test(text)) {
      skipped.add("ethnicity");
      asked.add("ethnicity");
      inferredQuestion = "ai_memory";
      continue;
    }

    for (const candidate of deterministicCandidates(text, inferredQuestion, completed)) {
      const validated = validateFactCandidate(candidate, text);
      if (!validated.candidate) continue;
      candidates.set(validated.candidate.field, validated.candidate);
      completed.add(validated.candidate.field);
    }

    const simulated: MutableProgress = {
      completed: new Set(completed),
      skipped: new Set(skipped),
      asked: new Set(asked),
    };
    inferredQuestion = nextOnboardingQuestion(simulated);
  }
  return { candidates: [...candidates.values()], completed, skipped, asked };
}

async function ensureProgress(user: CollectorUser): Promise<CollectorUser> {
  if (user.onboardingProgress?.backfilledAt) return user;

  const base = progressFromUser(user);
  const backfill = backfillCandidates(user.messageHistory);
  for (const field of backfill.completed) base.completed.add(field);
  for (const field of backfill.skipped) base.skipped.add(field);
  for (const field of backfill.asked) base.asked.add(field);
  const updates = updatesForCandidates(backfill.candidates);
  const next = nextOnboardingQuestion(base);

  await prisma.$transaction(async (tx) => {
    if (Object.keys(updates.user).length > 0) {
      await tx.user.update({ where: { id: user.id }, data: updates.user });
    }
    if (
      Object.keys(updates.profileCreate).length > 0 ||
      Object.keys(updates.profileUpdate).length > 0
    ) {
      await tx.profile.upsert({
        where: { userId: user.id },
        create: { userId: user.id, ...updates.profileCreate },
        update: updates.profileUpdate,
      });
    }
    await tx.onboardingProgress.upsert({
      where: { userId: user.id },
      create: {
        userId: user.id,
        completedFields: uniqueFields(base.completed),
        skippedFields: uniqueFields(base.skipped),
        askedFields: uniqueFields(base.asked),
        currentQuestion: next,
        collectorVersion: ONBOARDING_COLLECTOR_VERSION,
        revision: 1,
        backfilledAt: new Date(),
      },
      update: {
        completedFields: uniqueFields(base.completed),
        skippedFields: uniqueFields(base.skipped),
        askedFields: uniqueFields(base.asked),
        currentQuestion: next,
        collectorVersion: ONBOARDING_COLLECTOR_VERSION,
        revision: { increment: 1 },
        backfilledAt: new Date(),
      },
    });
  });

  return prisma.user.findUniqueOrThrow({
    where: { id: user.id },
    select: USER_SELECT,
  }) as Promise<CollectorUser>;
}

function logCollector(
  telegramId: bigint,
  accepted: OnboardingField[],
  rejected: RejectedCandidate[],
  next: OnboardingQuestion,
): void {
  const opaqueUser = telegramId.toString().slice(-4).padStart(4, "0");
  console.info("[onboarding-collector]", {
    user: `…${opaqueUser}`,
    accepted,
    rejected: rejected.map(({ field, reason }) => ({ field, reason })),
    next,
    version: ONBOARDING_COLLECTOR_VERSION,
  });
}

export async function collectOnboardingInput(
  telegramId: bigint,
  input: OnboardingInput,
  deps: CollectorDeps = {},
): Promise<CollectorSnapshot> {
  let initial = (await prisma.user.findUniqueOrThrow({
    where: { telegramId },
    select: USER_SELECT,
  })) as CollectorUser;
  initial = await ensureProgress(initial);

  if (input.kind !== "user_text") {
    return refreshCollectorSnapshot(initial.id, [], []);
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const user = (attempt === 0
      ? initial
      : ((await prisma.user.findUniqueOrThrow({
          where: { telegramId },
          select: USER_SELECT,
        })) as CollectorUser));
    const progress = progressFromUser(user);
    const current =
      asQuestion(user.onboardingProgress?.currentQuestion ?? null) ??
      nextOnboardingQuestion(progress);
    const deterministic = deterministicCandidates(
      input.text,
      current,
      progress.completed,
    );
    const extractor =
      deps.extractFacts ??
      ((text, question, language) =>
        extractWithOpenAI(text, question, language, deps.fetchFn ?? openaiFetch));
    let extraction: ExtractionResult = EMPTY_EXTRACTION;
    try {
      extraction = await extractor(input.text, current, languageOf(user));
    } catch (error) {
      console.warn("[onboarding-collector] extractor error", error);
    }

    // When the extractor itself flags a clarifying question it sometimes still
    // echoes the question text back as a candidate. Those are suspect, so trust
    // only the high-precision deterministic layer in that case — a genuine
    // structured fact stated in the same message (e.g. "why height? I'm 183cm")
    // is still captured deterministically.
    const extractedCandidates =
      extraction.intent === "clarifying_question" ? [] : extraction.candidates;
    const accepted: FactCandidate[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const candidate of mergeCandidates(deterministic, extractedCandidates)) {
      const validated = validateFactCandidate(candidate, input.text);
      if (validated.candidate) accepted.push(validated.candidate);
      else rejected.push({ field: candidate.field, reason: validated.reason ?? "invalid" });
    }

    // Clarifying question: the user asked us something instead of answering.
    // Record nothing and don't advance — the caller answers briefly and
    // re-poses the same question. Conservative: only when no fact was
    // extracted, so a real answer phrased with a "?" still saves. No revision
    // bump, so a clarifying turn can't race the optimistic-concurrency guard.
    if (
      accepted.length === 0 &&
      (extraction.intent === "clarifying_question" ||
        isLikelyMetaQuestion(input.text))
    ) {
      logCollector(telegramId, [], rejected, current);
      return refreshCollectorSnapshot(user.id, [], rejected, true);
    }

    if (current === "ethnicity") {
      progress.asked.add("ethnicity");
      if (SKIP_RE.test(input.text.trim())) progress.skipped.add("ethnicity");
    }
    for (const candidate of accepted) {
      progress.completed.add(candidate.field);
      progress.skipped.delete(candidate.field);
    }
    const updates = updatesForCandidates(accepted);
    const next = nextOnboardingQuestion(progress);
    const nextField = questionField(next);
    if (nextField) progress.asked.add(nextField);
    const expectedRevision = user.onboardingProgress?.revision ?? 0;

    try {
      await prisma.$transaction(async (tx) => {
        if (Object.keys(updates.user).length > 0) {
          await tx.user.update({ where: { id: user.id }, data: updates.user });
        }
        if (
          Object.keys(updates.profileCreate).length > 0 ||
          Object.keys(updates.profileUpdate).length > 0
        ) {
          await tx.profile.upsert({
            where: { userId: user.id },
            create: { userId: user.id, ...updates.profileCreate },
            update: updates.profileUpdate,
          });
        }
        const result = await tx.onboardingProgress.updateMany({
          where: { userId: user.id, revision: expectedRevision },
          data: {
            completedFields: uniqueFields(progress.completed),
            skippedFields: uniqueFields(progress.skipped),
            askedFields: uniqueFields(progress.asked),
            currentQuestion: next,
            collectorVersion: ONBOARDING_COLLECTOR_VERSION,
            revision: { increment: 1 },
          },
        });
        if (result.count !== 1) throw new RevisionConflict();
      });
      const acceptedFields = uniqueFields(accepted.map(({ field }) => field));
      logCollector(telegramId, acceptedFields, rejected, next);
      // Nothing was saved and the question did not advance (an ethnicity skip
      // advances `next`, so it is not flagged): the answer went unparsed.
      const unparsedAnswer = acceptedFields.length === 0 && next === current;
      return refreshCollectorSnapshot(
        user.id,
        acceptedFields,
        rejected,
        false,
        unparsedAnswer,
      );
    } catch (error) {
      if (error instanceof RevisionConflict && attempt < 2) continue;
      throw error;
    }
  }
  throw new Error("Onboarding progress revision conflict");
}

export async function markOnboardingField(
  telegramId: bigint,
  field: "context_dump" | "photos",
  skipped = false,
): Promise<CollectorSnapshot> {
  const user = (await prisma.user.findUniqueOrThrow({
    where: { telegramId },
    select: USER_SELECT,
  })) as CollectorUser;
  const ensured = await ensureProgress(user);
  const progress = progressFromUser(ensured);
  progress.completed.add(field);
  if (skipped) progress.skipped.add(field);
  const next = nextOnboardingQuestion(progress);
  const nextField = questionField(next);
  if (nextField) progress.asked.add(nextField);

  await prisma.onboardingProgress.update({
    where: { userId: ensured.id },
    data: {
      completedFields: uniqueFields(progress.completed),
      skippedFields: uniqueFields(progress.skipped),
      askedFields: uniqueFields(progress.asked),
      currentQuestion: next,
      collectorVersion: ONBOARDING_COLLECTOR_VERSION,
      revision: { increment: 1 },
    },
  });
  logCollector(telegramId, [field], [], next);
  return refreshCollectorSnapshot(ensured.id, [field], []);
}

async function refreshCollectorSnapshot(
  userId: string,
  acceptedFields: OnboardingField[],
  rejectedFields: RejectedCandidate[],
  needsClarification = false,
  unparsedAnswer = false,
): Promise<CollectorSnapshot> {
  const user = (await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: USER_SELECT,
  })) as CollectorUser;
  const progress = progressFromUser(user);
  const currentQuestion = nextOnboardingQuestion(progress);
  return {
    userId,
    language: languageOf(user),
    completedFields: uniqueFields(progress.completed),
    skippedFields: uniqueFields(progress.skipped),
    askedFields: uniqueFields(progress.asked),
    currentQuestion,
    revision: user.onboardingProgress?.revision ?? 0,
    acceptedFields,
    rejectedFields,
    needsClarification,
    unparsedAnswer,
  };
}

const QUESTIONS: Record<Language, Record<OnboardingQuestion, string>> = {
  en: {
    first_name_age: "What should I call you, and how old are you?",
    gender: "What is your gender? Please answer directly: man or woman.",
    preference: "Who would you like to date: men, women, or both?",
    height: "How tall are you? You can answer in centimeters or feet and inches.",
    hobbies: "What do you enjoy doing? One hobby is enough, and “no hobbies” is a valid answer.",
    partner_preferences: "What matters most to you in a partner? One short sentence is enough.",
    ethnicity: "Optional: what is your nationality or ethnic background? You can skip this.",
    friday_vibe: "Describe your ideal Friday night — money and logistics no object. Be honest — not what sounds “right”.",
    vibe_focus: "And what matters most in that night — the experience itself, or who's with you?",
    ai_memory: "Would you like to import context from an AI chat? Answer yes or no.",
    context_dump: contextDumpInstruction("en"),
    photos: `Send at least ${MIN_PHOTOS} clear photos of yourself.`,
    complete: "Your onboarding is complete.",
  },
  ru: {
    first_name_age: "Как тебя зовут и сколько тебе лет?",
    gender: "Укажи свой пол прямо: парень или девушка.",
    preference: "Кого ты хочешь найти: парней, девушек или обоих?",
    height: "Какой у тебя рост? Можно ответить в сантиметрах.",
    hobbies: "Чем тебе нравится заниматься? Достаточно одного увлечения, а «нет хобби» тоже считается ответом.",
    partner_preferences: "Что для тебя важнее всего в партнёре? Достаточно одного короткого предложения.",
    ethnicity: "Как ты описываешь своё происхождение или национальность? Можно пропустить",
    friday_vibe: "Опиши идеальный вечер пятницы — без ограничений по деньгам и логистике. Только честно — а не так, как «правильно» звучало бы.",
    vibe_focus: "А что в этом вечере главное — сам процесс или кто рядом?",
    ai_memory: "Хочешь импортировать контекст из AI-чата? Ответь да или нет.",
    context_dump: contextDumpInstruction("ru"),
    photos: `Пришли минимум ${MIN_PHOTOS} чёткие фотографии, где хорошо видно тебя.`,
    complete: "Онбординг завершён.",
  },
  uk: {
    first_name_age: "Як тебе звати і скільки тобі років?",
    gender: "Вкажи свою стать прямо: хлопець чи дівчина.",
    preference: "Кого ти хочеш знайти: хлопців, дівчат чи обох?",
    height: "Який у тебе зріст? Можна відповісти в сантиметрах.",
    hobbies: "Чим тобі подобається займатися? Достатньо одного захоплення, а «немає хобі» теж є відповіддю.",
    partner_preferences: "Що для тебе найважливіше в партнері? Достатньо одного короткого речення.",
    ethnicity: "Необов’язково: яка в тебе національність або етнічне походження? Можна пропустити.",
    friday_vibe: "Опиши ідеальний вечір п’ятниці — без обмежень щодо грошей і логістики. Тільки чесно — а не так, як «правильно» звучало б.",
    vibe_focus: "А що в цьому вечорі головне — сам процес чи хто поруч?",
    ai_memory: "Хочеш імпортувати контекст з AI-чату? Відповідай так або ні.",
    context_dump: contextDumpInstruction("uk"),
    photos: `Надішли щонайменше ${MIN_PHOTOS} чіткі фотографії, де добре видно тебе.`,
    complete: "Онбординг завершено.",
  },
  de: {
    first_name_age: "Wie soll ich dich nennen und wie alt bist du?",
    gender: "Was ist dein Geschlecht? Bitte antworte direkt: Mann oder Frau.",
    preference: "Wen möchtest du daten: Männer, Frauen oder beide?",
    height: "Wie groß bist du? Du kannst in Zentimetern antworten.",
    hobbies: "Was machst du gern? Ein Hobby reicht, und „keine Hobbys“ ist ebenfalls eine gültige Antwort.",
    partner_preferences: "Was ist dir bei einem Partner am wichtigsten? Ein kurzer Satz reicht.",
    ethnicity: "Optional: Welche Nationalität oder ethnische Herkunft hast du? Du kannst überspringen.",
    friday_vibe: "Beschreib deinen idealen Freitagabend — ohne Geld- oder Logistikgrenzen. Sei ehrlich — nicht das, was „richtig“ klingt.",
    vibe_focus: "Und was ist an diesem Abend am wichtigsten — das Erlebnis selbst oder wer dabei ist?",
    ai_memory: "Möchtest du Kontext aus einem AI-Chat importieren? Antworte mit Ja oder Nein.",
    context_dump: contextDumpInstruction("de"),
    photos: `Sende mindestens ${MIN_PHOTOS} klare Fotos von dir.`,
    complete: "Dein Onboarding ist abgeschlossen.",
  },
  pl: {
    first_name_age: "Jak mam się do Ciebie zwracać i ile masz lat?",
    gender: "Jaka jest Twoja płeć? Odpowiedz wprost: mężczyzna czy kobieta.",
    preference: "Z kim chcesz się umawiać: z mężczyznami, kobietami czy z obiema grupami?",
    height: "Jaki masz wzrost? Możesz odpowiedzieć w centymetrach.",
    hobbies: "Co lubisz robić? Jedno hobby wystarczy, a „nie mam hobby” też jest poprawną odpowiedzią.",
    partner_preferences: "Co jest dla Ciebie najważniejsze u partnera? Wystarczy jedno krótkie zdanie.",
    ethnicity: "Opcjonalnie: jaka jest Twoja narodowość lub pochodzenie etniczne? Możesz pominąć.",
    friday_vibe: "Opisz swój idealny piątkowy wieczór — bez ograniczeń finansowych i logistycznych. Szczerze — a nie tak, jak „wypada”.",
    vibe_focus: "A co w tym wieczorze jest najważniejsze — samo przeżycie czy to, kto jest obok?",
    ai_memory: "Chcesz zaimportować kontekst z czatu AI? Odpowiedz tak lub nie.",
    context_dump: contextDumpInstruction("pl"),
    photos: `Wyślij co najmniej ${MIN_PHOTOS} wyraźne zdjęcia, na których dobrze Cię widać.`,
    complete: "Onboarding został zakończony.",
  },
};

export function onboardingQuestionText(
  language: Language,
  question: OnboardingQuestion,
  completedFields: readonly OnboardingField[] = [],
): string {
  if (question === "first_name_age") {
    const completed = new Set(completedFields);
    if (completed.has("first_name") && !completed.has("age")) {
      return {
        en: "How old are you?",
        ru: "Сколько тебе лет?",
        uk: "Скільки тобі років?",
        de: "Wie alt bist du?",
        pl: "Ile masz lat?",
      }[language];
    }
    if (completed.has("age") && !completed.has("first_name")) {
      return {
        en: "What should I call you?",
        ru: "Как тебя зовут?",
        uk: "Як тебе звати?",
        de: "Wie soll ich dich nennen?",
        pl: "Jak mam się do Ciebie zwracać?",
      }[language];
    }
  }
  return QUESTIONS[language][question];
}

export function onboardingValidationText(
  language: Language,
  rejectedFields: readonly RejectedCandidate[],
): string | null {
  const age = rejectedFields.find(
    (item) => item.field === "age" && item.reason === "age_out_of_range",
  );
  if (age) {
    return {
      en: `Right now Gennety is only available for people aged ${MIN_AGE}-${MAX_AGE}. Please enter an age in that range to continue testing.`,
      ru: `Сейчас Gennety доступен только для возраста ${MIN_AGE}-${MAX_AGE}. Чтобы продолжить тест, укажи возраст в этом диапазоне.`,
      uk: `Зараз Gennety доступний тільки для віку ${MIN_AGE}-${MAX_AGE}. Щоб продовжити тест, вкажи вік у цьому діапазоні.`,
      de: `Gennety ist aktuell nur für Personen von ${MIN_AGE}-${MAX_AGE} verfügbar. Gib bitte ein Alter in diesem Bereich ein, um den Test fortzusetzen.`,
      pl: `Gennety jest teraz dostępne tylko dla osób w wieku ${MIN_AGE}-${MAX_AGE}. Podaj wiek z tego zakresu, aby kontynuować test.`,
    }[language];
  }

  const height = rejectedFields.find(
    (item) => item.field === "height" && item.reason === "height_out_of_range",
  );
  if (height) {
    return {
      en: "That height looks outside the supported range. Please send a plausible height in cm, for example 180 cm.",
      ru: "Этот рост выглядит вне допустимого диапазона. Напиши реалистичный рост в сантиметрах, например 180 см.",
      uk: "Цей зріст виглядає поза допустимим діапазоном. Напиши реалістичний зріст у сантиметрах, наприклад 180 см.",
      de: "Diese Größe liegt außerhalb des unterstützten Bereichs. Sende bitte eine realistische Größe in Zentimetern, zum Beispiel 180 cm.",
      pl: "Ten wzrost wygląda poza obsługiwanym zakresem. Podaj realistyczny wzrost w centymetrach, na przykład 180 cm.",
    }[language];
  }

  return null;
}

type NotUnderstoodHintKey =
  | "name_age"
  | "age_only"
  | "name_only"
  | Exclude<
      OnboardingQuestion,
      "first_name_age" | "context_dump" | "photos" | "complete"
    >;

const NOT_UNDERSTOOD_LEAD: Record<Language, string> = {
  en: "Sorry, I didn't quite get that 🙂",
  ru: "Я не совсем понял 🙂",
  uk: "Я не зовсім зрозумів 🙂",
  de: "Das habe ich nicht ganz verstanden 🙂",
  pl: "Nie do końca zrozumiałem 🙂",
};

const NOT_UNDERSTOOD_HINTS: Record<
  Language,
  Record<NotUnderstoodHintKey, string>
> = {
  en: {
    name_age: "You can answer like: “Alex, 21”.",
    age_only: "Just send your age as a number, for example 21.",
    name_only: "Just send your first name, for example Alex.",
    gender: "“Man” or “woman” works — your own words are fine too.",
    preference: "“Men”, “women”, or “both” works — your own words are fine too.",
    height: "For example: 180 cm or 5'11\".",
    hobbies: "Name one or two things you enjoy — “no hobbies” is fine too.",
    partner_preferences: "One short sentence about what matters to you is enough.",
    ethnicity: "A short answer is enough — or reply “skip”.",
    friday_vibe: "Tell me in a sentence or two how you'd actually spend it.",
    vibe_focus: "Is it more about the experience itself, or who you're with?",
    ai_memory: "Please answer yes or no.",
  },
  ru: {
    name_age: "Можно ответить так: «Максим, 21».",
    age_only: "Просто напиши возраст числом, например 21.",
    name_only: "Просто напиши своё имя, например Максим.",
    gender: "Подойдёт «парень» или «девушка» — можно своими словами.",
    preference: "Подойдёт «парней», «девушек» или «обоих» — можно своими словами.",
    height: "Например: 180 см.",
    hobbies: "Назови одно-два увлечения — «нет хобби» тоже подойдёт.",
    partner_preferences: "Достаточно одного короткого предложения о том, что для тебя важно.",
    ethnicity: "Достаточно короткого ответа — или напиши «пропустить».",
    friday_vibe: "Опиши в паре предложений, как бы ты его реально провёл.",
    vibe_focus: "Тебе важнее сам процесс или компания рядом?",
    ai_memory: "Ответь, пожалуйста, «да» или «нет».",
  },
  uk: {
    name_age: "Можна відповісти так: «Максим, 21».",
    age_only: "Просто напиши вік числом, наприклад 21.",
    name_only: "Просто напиши своє ім’я, наприклад Максим.",
    gender: "Підійде «хлопець» або «дівчина» — можна своїми словами.",
    preference: "Підійде «хлопців», «дівчат» або «обох» — можна своїми словами.",
    height: "Наприклад: 180 см.",
    hobbies: "Назви одне-два захоплення — «немає хобі» теж підійде.",
    partner_preferences: "Достатньо одного короткого речення про те, що для тебе важливо.",
    ethnicity: "Достатньо короткої відповіді — або напиши «пропустити».",
    friday_vibe: "Опиши в кількох реченнях, як би ти його реально провів.",
    vibe_focus: "Тобі важливіший сам процес чи компанія поруч?",
    ai_memory: "Відповідай, будь ласка, «так» або «ні».",
  },
  de: {
    name_age: "Du kannst zum Beispiel antworten: „Alex, 21“.",
    age_only: "Schick einfach dein Alter als Zahl, zum Beispiel 21.",
    name_only: "Schick einfach deinen Vornamen, zum Beispiel Alex.",
    gender: "„Mann“ oder „Frau“ reicht — eigene Worte gehen auch.",
    preference: "„Männer“, „Frauen“ oder „beide“ reicht — eigene Worte gehen auch.",
    height: "Zum Beispiel: 180 cm.",
    hobbies: "Nenn ein oder zwei Dinge, die du gern machst — „keine Hobbys“ geht auch.",
    partner_preferences: "Ein kurzer Satz darüber, was dir wichtig ist, reicht.",
    ethnicity: "Eine kurze Antwort reicht — oder schreib „überspringen“.",
    friday_vibe: "Beschreib in ein, zwei Sätzen, wie du ihn wirklich verbringen würdest.",
    vibe_focus: "Geht es dir mehr um das Erlebnis oder um die Leute dabei?",
    ai_memory: "Antworte bitte mit Ja oder Nein.",
  },
  pl: {
    name_age: "Możesz odpowiedzieć na przykład: „Alex, 21”.",
    age_only: "Po prostu napisz swój wiek liczbą, na przykład 21.",
    name_only: "Po prostu napisz swoje imię, na przykład Alex.",
    gender: "Wystarczy „mężczyzna” lub „kobieta” — możesz też własnymi słowami.",
    preference: "Wystarczy „mężczyźni”, „kobiety” lub „oboje” — możesz też własnymi słowami.",
    height: "Na przykład: 180 cm.",
    hobbies: "Wymień jedno lub dwa hobby — „nie mam hobby” też jest OK.",
    partner_preferences: "Wystarczy jedno krótkie zdanie o tym, co jest dla Ciebie ważne.",
    ethnicity: "Wystarczy krótka odpowiedź — możesz też napisać „pomiń”.",
    friday_vibe: "Opisz w jednym–dwóch zdaniach, jak naprawdę byś go spędził.",
    vibe_focus: "Chodzi bardziej o samo przeżycie czy o to, z kim jesteś?",
    ai_memory: "Odpowiedz proszę „tak” lub „nie”.",
  },
};

/**
 * Honest feedback when an answer could not be parsed: a short localized
 * "didn't get that" plus a per-question example of what works. The caller
 * appends the (partial-progress-aware) canonical question after it. Returns
 * null for stages where free text is not the expected input.
 */
export function onboardingNotUnderstoodText(
  language: Language,
  question: OnboardingQuestion,
  completedFields: readonly OnboardingField[] = [],
): string | null {
  if (
    question === "context_dump" ||
    question === "photos" ||
    question === "complete"
  ) {
    return null;
  }
  let key: NotUnderstoodHintKey;
  if (question === "first_name_age") {
    const completed = new Set(completedFields);
    key = completed.has("first_name")
      ? "age_only"
      : completed.has("age")
        ? "name_only"
        : "name_age";
  } else {
    key = question;
  }
  return `${NOT_UNDERSTOOD_LEAD[language]} ${NOT_UNDERSTOOD_HINTS[language][key]}`;
}
