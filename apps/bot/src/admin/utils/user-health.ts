/**
 * Классификация «здоровья» аккаунтов — чистая логика, без Prisma и без LLM.
 *
 * Зачем: в базе лежат вперемешку живые люди, тестовые аккаунты, те кто открыл
 * бота и ушёл, и те кто застрял в онбординге. Пока их считают одним числом
 * `users.total`, любая конверсия врёт — в частности `activeRate` делился на
 * ВСЕХ, включая тестовый аккаунт.
 *
 * Правило безопасности: здесь только классификация и флаги. Никаких удалений,
 * банов и записей в базу — решение «забанить/удалить» ручное.
 *
 * Загрузка данных живёт в `user-health-source.ts`; этот модуль намеренно
 * принимает готовый снимок, чтобы каждое правило можно было проверить юнит-
 * тестом без базы.
 */

// ---------------------------------------------------------------------------
// Конфигурация порогов
// ---------------------------------------------------------------------------
/**
 * Все пороги в одном месте, а не зашиты в глубине правил.
 *
 * `bot_batch_*` — самый чувствительный к стадии продукта порог: во время
 * рекламного залива 3 живые регистрации за 10 минут — норма, и правило начнёт
 * помечать реальных людей. Это флаг, а не бан, но перед запуском рекламы
 * значения стоит поднять.
 */
export interface HealthConfig {
  /** Через сколько дней молчания активный аккаунт считается остывшим. */
  inactive_days: number;
  /** Сколько часов ждём первого сообщения, прежде чем считать «зашёл и ушёл». */
  cold_open_hours: number;
  /** Минимум сообщений, чтобы считать человека реально пообщавшимся. */
  min_messages_for_stuck: number;
  /** Порог «много писал» для подозрительных правил. */
  suspicious_min_messages: number;
  /** Медиана ответа быстрее этого — уже не человек. */
  suspicious_max_response_sec: number;
  /** Окно, в котором ищем всплеск регистраций. */
  bot_batch_window_min: number;
  /** Сколько аккаунтов в окне делают всплеск подозрительным. */
  bot_batch_min_users: number;
  /** Классы, которые пускаются в матчинг. По умолчанию только `live`. */
  eligible_classes: readonly UserHealthClass[];
  /** Потолок разового скана, чтобы админский эндпоинт не стал O(вся база). */
  max_scan_users: number;
  /** Telegram id тестовых аккаунтов (заполняется вручную/через env). */
  test_telegram_ids: readonly string[];
  /** Имя, по которому аккаунт опознаётся как тестовый. */
  test_name_pattern: RegExp;
  /** Email, по которому аккаунт опознаётся как тестовый. */
  test_email_pattern: RegExp;
}

export const HEALTH_CONFIG: HealthConfig = {
  inactive_days: 30,
  cold_open_hours: 24,
  min_messages_for_stuck: 1,
  suspicious_min_messages: 10,
  suspicious_max_response_sec: 2,
  bot_batch_window_min: 10,
  bot_batch_min_users: 3,
  eligible_classes: ["live"],
  max_scan_users: 20000,
  test_telegram_ids: [],
  test_name_pattern: /^\s*(test|тест|qa|demo)\b/i,
  test_email_pattern: /(^test[@+._-]|[@+._-]test@|@example\.(com|org)$|\.test$)/i,
};

// ---------------------------------------------------------------------------
// Классы
// ---------------------------------------------------------------------------
export type UserHealthClass =
  | "test"
  | "suspicious"
  | "stuck_onboarding"
  | "cold_open_unengaged"
  | "inactive"
  | "live"
  /**
   * Всё, что не попало ни в один из шести классов: paused / frozen /
   * suspended / banned, активные но не дотягивающие до `live`, и совсем
   * свежие регистрации моложе `cold_open_hours`. Отдельная корзина нужна,
   * чтобы сумма по классам всегда сходилась с общим числом пользователей —
   * иначе цифры на дашборде тихо не сойдутся.
   */
  | "other";

/** Порядок разбора: первый сработавший класс выигрывает. */
export const USER_HEALTH_CLASSES: readonly UserHealthClass[] = [
  "test",
  "suspicious",
  "stuck_onboarding",
  "cold_open_unengaged",
  "inactive",
  "live",
  "other",
];

/** Идентификаторы правил — стабильные строки, их читает Hermes и дашборд. */
export type HealthRule =
  | "test_known_id"
  | "test_name_pattern"
  | "test_email_pattern"
  | "suspicious_unverified_spoke"
  | "suspicious_missing_face"
  | "suspicious_instant_replies"
  | "suspicious_batch_registration";

// ---------------------------------------------------------------------------
// Вход/выход
// ---------------------------------------------------------------------------
export interface HealthUserInput {
  id: string;
  /** Строкой: BigInt не переживает JSON, и сравнение всё равно по строке. */
  telegramId: string;
  firstName: string | null;
  email: string | null;
  status: string;
  onboardingStep: string;
  verificationStatus: string;
  faceMatchScore: number | null;
  faceMatchedAt: Date | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  /** Сколько фото реально лежит в профиле. */
  photoCount: number;
  /**
   * Сообщения ОТ юзера, посчитанные по `chat_events` (direction = 'in').
   * Намеренно НЕ по `messageHistory`: там нет времени события, поэтому по нему
   * нельзя измерить скорость ответа, и он копил реплики агента ещё до того,
   * как таймлайн начали писать. Следствие, о котором стоит помнить: у старых
   * аккаунтов счётчик занижен.
   */
  messageCountIn: number;
  /** Медиана «бот написал → юзер ответил», секунды. null = мало замеров. */
  medianResponseSec: number | null;
  /** Сколько пар «вопрос-ответ» удалось замерить. */
  responseSamples: number;
  /** Размер всплеска регистраций вокруг этого аккаунта, включая его самого. */
  registrationBurstSize: number;
}

export interface HealthVerdict {
  classification: UserHealthClass;
  /** Подкласс: для `stuck_onboarding` — шаг, на котором человек встал. */
  subclass: string | null;
  /** Человекочитаемое «почему», одной строкой. */
  reason: string;
  rules_fired: HealthRule[];
  matchmaking_eligible: boolean;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

// ---------------------------------------------------------------------------
// Правила
// ---------------------------------------------------------------------------
/** Тестовый аккаунт: явный список id, либо имя/почта по шаблону. */
function testRules(u: HealthUserInput, cfg: HealthConfig): HealthRule[] {
  const fired: HealthRule[] = [];
  if (cfg.test_telegram_ids.includes(u.telegramId)) fired.push("test_known_id");
  if (u.firstName && cfg.test_name_pattern.test(u.firstName)) fired.push("test_name_pattern");
  if (u.email && cfg.test_email_pattern.test(u.email)) fired.push("test_email_pattern");
  return fired;
}

/**
 * Подозрительные признаки. Любого одного достаточно, чтобы поднять флаг —
 * это метка для ручного разбора, а не приговор.
 */
function suspiciousRules(u: HealthUserInput, cfg: HealthConfig): HealthRule[] {
  const fired: HealthRule[] = [];

  // 1. Много общался с ботом, но верификацию так и не прошёл.
  if (u.messageCountIn >= cfg.suspicious_min_messages && u.verificationStatus !== "verified") {
    fired.push("suspicious_unverified_spoke");
  }

  // 2. Фото загружены, но лицо ни разу не сверялось — ни балла, ни отметки.
  if (u.photoCount > 0 && u.faceMatchScore === null && u.faceMatchedAt === null) {
    fired.push("suspicious_missing_face");
  }

  // 3. Отвечает быстрее живого человека. Требуем достаточную выборку, иначе
  //    один быстрый тап на кнопку выглядел бы как бот.
  if (
    u.medianResponseSec !== null &&
    u.responseSamples >= cfg.suspicious_min_messages &&
    u.medianResponseSec < cfg.suspicious_max_response_sec
  ) {
    fired.push("suspicious_instant_replies");
  }

  // 4. Зарегистрирован в пачке с другими аккаунтами.
  //
  // Верифицированных сюда не пускаем: liveness — это доказанное живое лицо,
  // оно весит больше, чем совпадение по времени регистрации. Без этой оговорки
  // во время рекламного залива правило пометило бы живых людей и занизило
  // ликвидность — то самое число, ради которого всё и считается. Порог
  // `bot_batch_min_users` всё равно стоит поднять перед крупным заливом.
  if (
    u.registrationBurstSize >= cfg.bot_batch_min_users &&
    u.verificationStatus !== "verified"
  ) {
    fired.push("suspicious_batch_registration");
  }

  return fired;
}

const RULE_TEXT: Record<HealthRule, string> = {
  test_known_id: "telegram id is on the test-account list",
  test_name_pattern: "first name matches the test-account pattern",
  test_email_pattern: "email matches the test-account pattern",
  suspicious_unverified_spoke:
    "spoke to the bot a lot but verification != verified",
  suspicious_missing_face: "photos uploaded but faceMatchScore absent",
  suspicious_instant_replies: "median reply time is faster than a human",
  suspicious_batch_registration: "registered inside a burst of accounts",
};

function describe(rules: HealthRule[]): string {
  return rules.map((r) => RULE_TEXT[r]).join("; ");
}

// ---------------------------------------------------------------------------
// Классификатор
// ---------------------------------------------------------------------------
export function classifyUser(
  u: HealthUserInput,
  now: Date = new Date(),
  cfg: HealthConfig = HEALTH_CONFIG,
): HealthVerdict {
  const verdict = (
    classification: UserHealthClass,
    reason: string,
    rules_fired: HealthRule[] = [],
    subclass: string | null = null,
  ): HealthVerdict => ({
    classification,
    subclass,
    reason,
    rules_fired,
    matchmaking_eligible: isMatchmakingEligible(classification, cfg),
  });

  // 1. Тестовые — вне всякой статистики, поэтому проверяются первыми.
  const test = testRules(u, cfg);
  if (test.length > 0) {
    return verdict("test", `test account: ${describe(test)}`, test);
  }

  // 2. Подозрительные — раньше «застрял», иначе бот-ферма растворится
  //    в обычной воронке онбординга.
  const suspicious = suspiciousRules(u, cfg);
  if (suspicious.length > 0) {
    return verdict("suspicious", describe(suspicious), suspicious);
  }

  // «Реально общался» — либо есть отметка последнего сообщения, либо в
  // таймлайне набралось достаточно входящих. Достаточно одного из двух:
  // `lastMessageAt` есть у старых аккаунтов, у которых таймлайна ещё не было,
  // а счётчик входящих переживает ручной сброс `lastMessageAt`.
  const spoke = u.lastMessageAt !== null || u.messageCountIn >= cfg.min_messages_for_stuck;
  const ageMs = now.getTime() - u.createdAt.getTime();
  const silentMs = u.lastMessageAt ? now.getTime() - u.lastMessageAt.getTime() : null;

  // 3. Застрял в онбординге: писал боту, но так и не дошёл до конца.
  if (u.status === "onboarding" && spoke) {
    return verdict(
      "stuck_onboarding",
      `real person: talked to the bot but never finished onboarding (stopped at "${u.onboardingStep}")`,
      [],
      u.onboardingStep,
    );
  }

  // 4. Холодное открытие: не написал ни разу и прошли сутки.
  if (u.lastMessageAt === null && ageMs > cfg.cold_open_hours * HOUR_MS) {
    return verdict(
      "cold_open_unengaged",
      `opened the bot and left: no message ever, registered ${formatAge(ageMs)} ago`,
    );
  }

  // 5. Остыл: был активен, но давно молчит.
  if (u.status === "active" && silentMs !== null && silentMs > cfg.inactive_days * DAY_MS) {
    return verdict(
      "inactive",
      `active but silent for ${Math.floor(silentMs / DAY_MS)} days (threshold ${cfg.inactive_days})`,
    );
  }

  // 6. Живой: активен, верифицирован, недавно писал, с фото.
  if (
    u.status === "active" &&
    u.verificationStatus === "verified" &&
    silentMs !== null &&
    silentMs <= cfg.inactive_days * DAY_MS &&
    u.photoCount > 0
  ) {
    return verdict("live", "active, verified, recently engaged, has photos");
  }

  // Всё остальное. Причина объясняет, что именно не сошлось, чтобы корзина
  // не превратилась в «непонятно».
  return verdict("other", otherReason(u, cfg, ageMs, silentMs));
}

function otherReason(
  u: HealthUserInput,
  cfg: HealthConfig,
  ageMs: number,
  silentMs: number | null,
): string {
  if (u.lastMessageAt === null && ageMs <= cfg.cold_open_hours * HOUR_MS) {
    return `registered ${formatAge(ageMs)} ago with no activity yet — too early to classify`;
  }
  if (u.status !== "active" && u.status !== "onboarding") {
    return `lifecycle status "${u.status}" — outside the health funnel`;
  }
  if (u.status === "active" && u.verificationStatus !== "verified") {
    return `active but verification is "${u.verificationStatus}" — not matchable`;
  }
  if (u.status === "active" && u.photoCount === 0) {
    return "active and verified but has no photos";
  }
  if (u.status === "onboarding") {
    return `onboarding at "${u.onboardingStep}", no messages recorded`;
  }
  return silentMs === null ? "no activity recorded" : "does not match any health class";
}

function formatAge(ms: number): string {
  const hours = Math.floor(ms / HOUR_MS);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(ms / DAY_MS)}d`;
}

/**
 * Флаг допуска в матчинг. Диагностический — реальный движок подбора его не
 * читает и по-прежнему фильтрует по `status`/`verificationStatus` сам.
 */
export function isMatchmakingEligible(
  classification: UserHealthClass,
  cfg: HealthConfig = HEALTH_CONFIG,
): boolean {
  return cfg.eligible_classes.includes(classification);
}

// ---------------------------------------------------------------------------
// Всплески регистраций
// ---------------------------------------------------------------------------
/**
 * Для каждого аккаунта — сколько всего аккаунтов (включая его) создано в
 * пределах `bot_batch_window_min` минут от него. Один проход по отсортированному
 * массиву: на каждом шаге сдвигаем левую границу окна.
 */
export function computeRegistrationBursts(
  users: ReadonlyArray<{ id: string; createdAt: Date }>,
  cfg: HealthConfig = HEALTH_CONFIG,
): Map<string, number> {
  const windowMs = cfg.bot_batch_window_min * 60 * 1000;
  const sorted = [...users].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const out = new Map<string, number>();

  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!.createdAt.getTime();
    let lo = i;
    while (lo > 0 && t - sorted[lo - 1]!.createdAt.getTime() <= windowMs) lo--;
    let hi = i;
    while (hi < sorted.length - 1 && sorted[hi + 1]!.createdAt.getTime() - t <= windowMs) hi++;
    out.set(sorted[i]!.id, hi - lo + 1);
  }

  return out;
}

/** Медиана, вынесена отдельно: её же считает загрузчик по времени ответов. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

// ---------------------------------------------------------------------------
// Агрегаты: здоровье базы + воронка
// ---------------------------------------------------------------------------
export interface UserHealthSummary {
  byClass: Record<UserHealthClass, number>;
  matchmaking_eligible: { count: number; of_total: number };
  /** Всего аккаунтов в скане (сумма byClass сходится именно с ним). */
  total: number;
  /** Тестовые исключены — знаменатель всех конверсий. */
  real: number;
  config: {
    inactive_days: number;
    cold_open_hours: number;
    suspicious_min_messages: number;
    suspicious_max_response_sec: number;
    bot_batch_window_min: number;
    bot_batch_min_users: number;
  };
}

export interface OnboardingFunnel {
  registered_real: number;
  gave_consent: number;
  completed_onboarding: number;
  active_verified: number;
  conversion_consent_to_active_pct: number | null;
  conversion_registered_to_active_pct: number | null;
}

/** Процент с одним знаком; null вместо деления на ноль. */
export function pct(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return +((numerator / denominator) * 100).toFixed(1);
}

/** Доля 0..1 с четырьмя знаками — формат, в котором дашборд читает `derived`. */
export function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return +(numerator / denominator).toFixed(4);
}

export interface ClassifiedUser extends HealthUserInput {
  verdict: HealthVerdict;
}

export function summarizeHealth(
  users: readonly ClassifiedUser[],
  cfg: HealthConfig = HEALTH_CONFIG,
): UserHealthSummary {
  const byClass = Object.fromEntries(
    USER_HEALTH_CLASSES.map((c) => [c, 0]),
  ) as Record<UserHealthClass, number>;

  let eligible = 0;
  let real = 0;

  for (const u of users) {
    byClass[u.verdict.classification]++;
    if (u.verdict.classification !== "test") real++;
    if (u.verdict.matchmaking_eligible) eligible++;
  }

  return {
    byClass,
    // Знаменатель — реальные пользователи: доля ликвидности от тестовых
    // аккаунтов зависеть не должна.
    matchmaking_eligible: { count: eligible, of_total: real },
    total: users.length,
    real,
    config: {
      inactive_days: cfg.inactive_days,
      cold_open_hours: cfg.cold_open_hours,
      suspicious_min_messages: cfg.suspicious_min_messages,
      suspicious_max_response_sec: cfg.suspicious_max_response_sec,
      bot_batch_window_min: cfg.bot_batch_window_min,
      bot_batch_min_users: cfg.bot_batch_min_users,
    },
  };
}

/**
 * Воронка. ВСЕ знаменатели — реальные пользователи: тестовый аккаунт из
 * конверсии исключён (ровно тот баг, из-за которого activeRate считался как
 * 5/19 вместо 5/16).
 *
 * «Дал согласие» считается по `onboardingStep`: всё, что дальше шага
 * `consent`, значит человек его прошёл.
 */
export function computeFunnel(users: readonly ClassifiedUser[]): OnboardingFunnel {
  let registered_real = 0;
  let gave_consent = 0;
  let completed_onboarding = 0;
  let active_verified = 0;

  for (const u of users) {
    if (u.verdict.classification === "test") continue;
    registered_real++;
    if (u.onboardingStep !== "consent") gave_consent++;
    if (u.onboardingStep === "completed") completed_onboarding++;
    if (u.status === "active" && u.verificationStatus === "verified") active_verified++;
  }

  return {
    registered_real,
    gave_consent,
    completed_onboarding,
    active_verified,
    conversion_consent_to_active_pct: pct(active_verified, gave_consent),
    conversion_registered_to_active_pct: pct(active_verified, registered_real),
  };
}
