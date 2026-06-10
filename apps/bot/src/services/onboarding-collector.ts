import {
  type AiMemoryExportPreference,
  type Gender,
  type GenderPreference,
  type Language,
  Prisma,
  prisma,
} from "@gennety/db";
import { MAX_AGE, MIN_AGE, MIN_PHOTOS } from "@gennety/shared";
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
  | { kind: "photos_updated"; count?: number };

type CandidateValue = string | number | string[];

export interface FactCandidate {
  field: OnboardingField;
  evidence: string;
  value: CandidateValue;
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
}

export interface CollectorDeps {
  extractFacts?: (
    text: string,
    question: OnboardingQuestion,
    language: Language,
  ) => Promise<FactCandidate[]>;
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
  /^(?:skip|pass|prefer not|rather not|no answer|пропуст|не хочу отвечать|не хочу відповідати|без ответа|без відповіді|überspring|möchte ich nicht|pomiń|nie chcę odpowiadać)[\s.!?]*$/iu;

const NO_HOBBIES_RE =
  /(?:no hobbies|don't have (?:any )?hobbies|do not have (?:any )?hobbies|нет хобби|немає хобі|не маю хобі|keine hobbies|mam żadnych hobby|nie mam hobby)/iu;

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
  const haystack = text.toLocaleLowerCase();
  const direct = normalizeText(evidence);
  if (direct.length > 0 && haystack.includes(direct.toLocaleLowerCase())) {
    return true;
  }
  const unquoted = normalizeText(stripWrappingQuotes(evidence));
  return unquoted.length > 0 && haystack.includes(unquoted.toLocaleLowerCase());
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

function nameCandidate(text: string, question: OnboardingQuestion): FactCandidate | null {
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
    if (/^(?:female|woman|girl|девушка|женщина|дівчина|жінка|kobieta|frau)$/iu.test(text.trim())) {
      return { field: "gender", evidence: text.trim(), value: "female" };
    }
    if (/^(?:male|man|guy|boy|парень|мужчина|хлопець|чоловік|mężczyzna|mann)$/iu.test(text.trim())) {
      return { field: "gender", evidence: text.trim(), value: "male" };
    }
  }
  return null;
}

function preferenceCandidate(
  text: string,
  question: OnboardingQuestion,
): FactCandidate | null {
  const both = text.match(
    /\b(?:both|men and women|women and men|all genders)\b|(?:и парни и девушки|и мужчины и женщины|і хлопці і дівчата|обоих|обох|mężczyźni i kobiety|männer und frauen)/iu,
  );
  if (both) return { field: "preference", evidence: both[0], value: "both" };

  const men = text.match(
    /(?:looking for|interested in|like|date|ищу|нравятся|подобаються|шукаю|szukam|lubię|suche)\s+(?:a\s+)?(?:men|man|guys|boys|мужчин|мужчину|парней|парня|чоловіків|хлопців|mężczyzn|männer)/iu,
  );
  if (men) return { field: "preference", evidence: men[0], value: "men" };

  const women = text.match(
    /(?:looking for|interested in|like|date|ищу|нравятся|подобаються|шукаю|szukam|lubię|suche)\s+(?:a\s+)?(?:women|woman|girls|girl|женщин|женщину|девушек|девушку|жінок|дівчат|kobiet|frauen)/iu,
  );
  if (women) return { field: "preference", evidence: women[0], value: "women" };

  if (question === "preference") {
    const value = text.trim();
    if (/^(?:men|guys|boys|мужчины|парни|чоловіки|хлопці|mężczyźni|männer)$/iu.test(value)) {
      return { field: "preference", evidence: value, value: "men" };
    }
    if (/^(?:women|girls|женщины|девушки|жінки|дівчата|kobiety|frauen)$/iu.test(value)) {
      return { field: "preference", evidence: value, value: "women" };
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
): FactCandidate[] {
  const candidates = [
    nameCandidate(text, question),
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
  if (question === "hobbies" && !containsOtherExplicitField) {
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
  if (question === "partner_preferences" && !containsOtherExplicitField) {
    candidates.push({
      field: "partner_preferences",
      evidence: trimmed,
      value: trimmed,
    });
  }
  if (
    question === "ethnicity" &&
    !containsOtherExplicitField &&
    !SKIP_RE.test(trimmed)
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
      required: ["candidates"],
    },
  };
}

async function extractWithOpenAI(
  text: string,
  question: OnboardingQuestion,
  language: Language,
  fetchFn: typeof fetch,
): Promise<FactCandidate[]> {
  if (!env.OPENAI_API_KEY) return [];
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
            "Extract only facts explicitly stated by the user. Every candidate must include an exact contiguous quote from the user message as evidence. Never infer gender from a name. Return no candidate for guesses, placeholders, assistant text, or implied facts.",
        },
        {
          role: "user",
          content: JSON.stringify({ language, current_question: question, message: text }),
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
    return [];
  }
  const body = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  const content = body.choices?.[0]?.message?.content;
  if (!content) return [];
  try {
    const parsed = JSON.parse(content) as {
      candidates?: Array<{
        field?: string;
        evidence?: string;
        string_value?: string | null;
        number_value?: number | null;
        array_value?: string[] | null;
      }>;
    };
    return (parsed.candidates ?? []).flatMap((candidate) => {
      const field = candidate.field ? asField(candidate.field) : null;
      if (!field || !candidate.evidence) return [];
      const value =
        candidate.number_value ??
        candidate.array_value ??
        candidate.string_value;
      if (value === null || value === undefined) return [];
      return [{ field, evidence: candidate.evidence, value }];
    });
  } catch {
    return [];
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
      if (candidate.value !== "male" && candidate.value !== "female") {
        return { reason: "invalid_gender" };
      }
      return { candidate };
    case "preference":
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
    case "ethnicity": {
      if (typeof candidate.value !== "string") return { reason: "invalid_type" };
      const value = normalizeText(candidate.value);
      if (normalizedPlaceholder(value) || value.length < 2 || value.length > 500) {
        return { reason: "placeholder_or_invalid" };
      }
      return { candidate: { ...candidate, value } };
    }
    case "ai_memory":
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

    for (const candidate of deterministicCandidates(text, inferredQuestion)) {
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
    const deterministic = deterministicCandidates(input.text, current);
    const extractor =
      deps.extractFacts ??
      ((text, question, language) =>
        extractWithOpenAI(text, question, language, deps.fetchFn ?? fetch));
    let extracted: FactCandidate[] = [];
    try {
      extracted = await extractor(input.text, current, languageOf(user));
    } catch (error) {
      console.warn("[onboarding-collector] extractor error", error);
    }

    const accepted: FactCandidate[] = [];
    const rejected: RejectedCandidate[] = [];
    for (const candidate of mergeCandidates(deterministic, extracted)) {
      const validated = validateFactCandidate(candidate, input.text);
      if (validated.candidate) accepted.push(validated.candidate);
      else rejected.push({ field: candidate.field, reason: validated.reason ?? "invalid" });
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
      return refreshCollectorSnapshot(user.id, acceptedFields, rejected);
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
    ai_memory: "Would you like to import context from an AI chat? Answer yes or no.",
    context_dump: contextDumpQuestion("en"),
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
    ethnicity: "Необязательно: какая у тебя национальность или этнический бэкграунд? Можно пропустить.",
    ai_memory: "Хочешь импортировать контекст из AI-чата? Ответь да или нет.",
    context_dump: contextDumpQuestion("ru"),
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
    ai_memory: "Хочеш імпортувати контекст з AI-чату? Відповідай так або ні.",
    context_dump: contextDumpQuestion("uk"),
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
    ai_memory: "Möchtest du Kontext aus einem AI-Chat importieren? Antworte mit Ja oder Nein.",
    context_dump: contextDumpQuestion("de"),
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
    ai_memory: "Chcesz zaimportować kontekst z czatu AI? Odpowiedz tak lub nie.",
    context_dump: contextDumpQuestion("pl"),
    photos: `Wyślij co najmniej ${MIN_PHOTOS} wyraźne zdjęcia, na których dobrze Cię widać.`,
    complete: "Onboarding został zakończony.",
  },
};

function contextDumpQuestion(language: Language): string {
  switch (language) {
    case "ru":
      return (
        "Скопируй Magic Prompt выше и вставь его в ChatGPT, Claude, Gemini или другой AI-чат, которым ты уже пользуешься.\n\n" +
        "Зачем это нужно: Gennety не свайпает людей наугад. Мы просим твой AI-чат собрать честный психологический профиль по тому, что он уже знает о тебе: ценности, стиль общения, интересы, паттерны и то, кто тебе реально подходит. Такой же глубокий разбор проходит каждый пользователь, поэтому матчинг сравнивает не анкеты из пары строк, а нормальный контекст.\n\n" +
        "Когда AI вернёт ответ, пришли его сюда полностью. Если Telegram разделит длинный ответ на несколько сообщений, отправь все части по порядку — я обработаю их автоматически после короткой паузы."
      );
    case "uk":
      return (
        "Скопіюй Magic Prompt вище і встав його в ChatGPT, Claude, Gemini або інший AI-чат, яким ти вже користуєшся.\n\n" +
        "Навіщо це потрібно: Gennety не свайпає людей навмання. Ми просимо твій AI-чат зібрати чесний психологічний профіль за тим, що він уже знає про тебе: цінності, стиль спілкування, інтереси, патерни й те, хто тобі справді підходить. Такий самий глибокий розбір проходить кожен користувач, тому матчинг порівнює не анкети з кількох рядків, а нормальний контекст.\n\n" +
        "Коли AI поверне відповідь, надішли її сюди повністю. Якщо Telegram розділить довгу відповідь на кілька повідомлень, надішли всі частини по черзі — я оброблю їх автоматично після короткої паузи."
      );
    case "de":
      return (
        "Kopiere den Magic Prompt oben und füge ihn in ChatGPT, Claude, Gemini oder einen anderen AI-Chat ein, den du bereits nutzt.\n\n" +
        "Warum das wichtig ist: Gennety matcht Menschen nicht zufällig per Swipe. Wir bitten deinen AI-Chat, aus dem vorhandenen Kontext ein ehrliches psychologisches Profil zu erstellen: Werte, Kommunikationsstil, Interessen, Muster und wer wirklich zu dir passt. Alle Nutzer durchlaufen dieselbe tiefe Analyse, damit das Matching nicht nur kurze Fragebögen, sondern echten Kontext vergleicht.\n\n" +
        "Wenn die AI antwortet, schick mir die vollständige Antwort hierher. Falls Telegram eine lange Antwort in mehrere Nachrichten teilt, sende alle Teile der Reihe nach — ich verarbeite sie nach einer kurzen Pause automatisch."
      );
    case "pl":
      return (
        "Skopiuj Magic Prompt powyżej i wklej go do ChatGPT, Claude, Gemini albo innego czatu AI, z którego już korzystasz.\n\n" +
        "Po co to robimy: Gennety nie dobiera ludzi losowo przez swipe. Prosimy Twój czat AI, żeby z istniejącego kontekstu stworzył szczery profil psychologiczny: wartości, styl komunikacji, zainteresowania, wzorce i to, kto naprawdę do Ciebie pasuje. Każdy użytkownik przechodzi taką samą pogłębioną analizę, więc matching porównuje realny kontekst, a nie tylko krótką ankietę.\n\n" +
        "Gdy AI zwróci odpowiedź, wyślij ją tutaj w całości. Jeśli Telegram podzieli długą odpowiedź na kilka wiadomości, wyślij wszystkie części po kolei — przetworzę je automatycznie po krótkiej pauzie."
      );
    default:
      return (
        "Copy the Magic Prompt above and paste it into ChatGPT, Claude, Gemini, or any other AI chat you already use.\n\n" +
        "Why we do this: Gennety does not match people from a shallow swipe profile. We ask your AI chat to turn the context it already has about you into an honest psychological profile: values, communication style, interests, patterns, and the kind of person who would genuinely fit you. Every user goes through the same deep read, so matching compares real context rather than a few questionnaire lines.\n\n" +
        "When the AI returns its answer, send the full response back here. If Telegram splits a long response into several messages, send every part in order — I will process everything automatically after a short pause."
      );
  }
}

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
