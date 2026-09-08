/**
 * Виральность: прямой K-фактор, непрямой (сарафанный) и их сумма.
 *
 * Файл ЧИСТЫЙ — ни prisma, ни часов, ни env. Загрузка живёт в
 * `virality-source.ts`, тот же раздел, что у `activity.ts` / `activity-source.ts`
 * и `user-health.ts` / `user-health-source.ts`, и по той же причине: здесь лежат
 * ПРОДУКТОВЫЕ решения (что считается когортой, что активацией, когда число
 * вообще разрешено показывать), а их надо проверять тестом, а не базой.
 *
 * Три правила проходят через весь файл; без них числа отсюда вредны:
 *
 *   • **Невычислимое — `null`, никогда не `0`.** «Виральности нет» и «посчитать
 *     было нельзя» — разные утверждения, и фаундер принимает по ним разные
 *     решения. Каждый `null` сопровождается кодом причины (`womStatus`,
 *     `mature`), потому что «нет данных» тоже бывает двух видов.
 *   • **Незрелая когорта помечена, а не спрятана.** Когорте сегодняшнего дня
 *     неоткуда взять D7. Строка всё равно возвращается (иначе матрица зияет), но
 *     с `mature: false`, и читатель обязан показывать её иначе.
 *   • **Знаменатель называется вслух.** `K = i × c` разложен на составляющие
 *     (`invitesPerUser`, `clickRate`, `activationRate`), потому что падение K
 *     без разложения не подсказывает ни одного действия.
 *
 * ## Что чем считается
 *
 * **Прямой K-фактор когорты.** `K_direct = активации / размер когорты`, где
 * активация — приглашённый, ДОШЕДШИЙ до верификации (`User.referralCountedAt`),
 * а не просто зарегистрировавшийся. Это ровно та точка, в которой продукт платит
 * рефереру (`services/referral.ts`), и мерить виральность по более раннему шагу
 * значило бы считать вирусным то, за что продукт сам отказывается платить.
 *
 * **Непрямой (WOM).** Органика сверх базовой линии, отнесённая к «семенной»
 * когорте: `K_wom = max(0, органика − база) / платно-размеченные регистрации`.
 * База — скользящее среднее ТОЛЬКО по неразмеченному притоку, поэтому
 * рекламные всплески в неё не попадают по построению, а не по вычитанию.
 *
 * **Blended.** `K_total = K_direct + K_wom`. Сумма, а не среднее: это два
 * непересекающихся источника новых пользователей (по ссылке и без ссылки), и
 * каждый умножает базу самостоятельно.
 */

import { DAY_MS, toDayKey } from "./activity.js";

// ---------------------------------------------------------------------------
// Константы
// ---------------------------------------------------------------------------

/**
 * Дни зрелости когортной матрицы. D1/D3 отвечают на «делятся ли сразу»,
 * D7/D14 — на «доходит ли приглашённый», D30 закрывает цикл: медианный
 * `cycleTime` продукта с недельным ритмом матчинга физически не помещается в
 * неделю, поэтому K, снятый на D7, всегда занижен, и это не повод его не
 * показывать — это повод показывать его рядом с D30.
 */
export const MATURITY_DAYS: readonly number[] = [1, 3, 7, 14, 30];

/**
 * Окно скользящей базы органики.
 *
 * 14 дней, а не 30: продукт запускается по городам, и месячное окно тащит в
 * базу состояние рынка, которого в этом городе уже нет. Две недели — это
 * компромисс между «база не успевает набраться» и «база помнит другой продукт».
 */
export const BASELINE_WINDOW_DAYS = 14;

/** Порог аномалии в сигмах от базы (ТЗ: 2σ). */
export const ANOMALY_SIGMA = 2;

/**
 * Минимальное покрытие опроса, при котором его ответам разрешено вытеснить
 * базовую линию как источник оценки WOM.
 *
 * Ниже этого ответы всё равно показываются (распределение интересно само по
 * себе), но `K_wom` продолжает считаться по базе: доля «друг рассказал» среди
 * 5% ответивших — это не доля среди всех пришедших, и подставлять одну вместо
 * другой значит умножать шум на объём.
 */
export const HDYHAU_MIN_COVERAGE = 0.2;

/** Сколько точек ряда нужно, чтобы СКО имело смысл. */
const MIN_POINTS_FOR_STDDEV = 3;

// ---------------------------------------------------------------------------
// Срезы (scope)
// ---------------------------------------------------------------------------

/**
 * Срез хранится строкой (`global` / `city:kyiv` / `university:kpi.ua`), а не
 * парой колонок, ровно по причине из модели: число кластеров растёт с каждым
 * запущенным городом, а число колонок расти не должно.
 */
export const GLOBAL_SCOPE = "global";

export type ScopeDimension = "global" | "city" | "university";

export function cityScope(cityKey: string): string {
  return `city:${cityKey}`;
}

export function universityScope(domain: string): string {
  return `university:${domain.toLowerCase()}`;
}

export function parseScope(scope: string): { dimension: ScopeDimension; key: string | null } {
  if (scope === GLOBAL_SCOPE) return { dimension: "global", key: null };
  const idx = scope.indexOf(":");
  if (idx <= 0) return { dimension: "global", key: null };
  const head = scope.slice(0, idx);
  const key = scope.slice(idx + 1);
  if (head === "city") return { dimension: "city", key };
  if (head === "university") return { dimension: "university", key };
  return { dimension: "global", key: null };
}

// ---------------------------------------------------------------------------
// Входные строки
// ---------------------------------------------------------------------------

/** Одна регистрация — то, из чего собираются и дни, и когорты. */
export interface SignupRow {
  userId: string;
  createdAt: Date;
  /** `normalizeChannel(referralSource)` — `organic` | `referral` | `tg:*` | … */
  channel: string;
  /** `parseReferrer(referralSource)` — кто привёл, если это была инвайт-ссылка. */
  referrerId: string | null;
  /**
   * `User.referralCountedAt` — момент, когда ЭТОТ пользователь засчитан
   * рефереру. Null, пока он не прошёл верификацию.
   */
  activatedAt: Date | null;
  cityKey: string | null;
  universityDomain: string | null;
}

/** Одно событие воронки шеринга. */
export interface FunnelEventRow {
  kind: "share_sheet_opened" | "invite_sent" | "invite_link_clicked";
  referrerId: string | null;
  occurredAt: Date;
}

/** Один ответ опроса вместе с тем, по какой ссылке человек на самом деле пришёл. */
export interface HdyhauRow {
  answer: string;
  /** `normalizeChannel(referralSource)` того же пользователя. */
  channel: string;
  answeredAt: Date;
  /** Считается ли ответ устной рекомендацией (`shared/hdyhau.ts`). */
  wordOfMouth: boolean;
}

// ---------------------------------------------------------------------------
// Мелкая арифметика
// ---------------------------------------------------------------------------

/**
 * Округление до `dp` знаков. Четыре знака по умолчанию, а не два, как в
 * `growth.ts`: там округляются доли (0..1), а здесь — K-фактор, который на
 * ранней стадии живёт в третьем знаке, и два знака превратили бы всю раннюю
 * виральность в ноль.
 */
export function round(value: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

/** Деление, у которого нулевой знаменатель даёт `null`, а не ноль или Infinity. */
export function ratio(numerator: number, denominator: number, dp = 4): number | null {
  if (denominator <= 0) return null;
  return round(numerator / denominator, dp);
}

/**
 * Доля шага воронки — то же деление, но с проверкой, что знаменатель вообще
 * может быть знаменателем.
 *
 * Числитель больше знаменателя означает не рекордную конверсию, а НЕДОСЧЁТ
 * предыдущего шага, и это здесь не гипотетический случай, а норма для всей
 * истории до появления `referral_events`: активации восстанавливаются из
 * `referralCountedAt`, который существовал всегда, а клики и инвайты — только с
 * момента, когда завели таблицу. Показать в такой строке «конверсию 200%»
 * значило бы выдать дыру в инструменте за поведение пользователей.
 *
 * Поэтому `null`: доля не измерена. Проверить это утверждение читатель может по
 * той же строке — числитель и знаменатель лежат рядом.
 */
export function funnelRate(numerator: number, denominator: number, dp = 4): number | null {
  if (denominator <= 0 || numerator > denominator) return null;
  return round(numerator / denominator, dp);
}

/** Медиана. Пустой ряд — `null` (медианы у пустоты нет, а не ноль). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface Stats {
  mean: number;
  /** Выборочное СКО (n−1). Null, пока точек меньше `MIN_POINTS_FOR_STDDEV`. */
  stdDev: number | null;
}

/**
 * Среднее и выборочное СКО ряда.
 *
 * Делитель `n−1`, а не `n`: окно базы — это выборка из потока регистраций, а не
 * вся генеральная совокупность, и оценка по `n` систематически занижает разброс,
 * то есть делает порог 2σ более чувствительным, чем заявлено.
 */
export function stats(values: readonly number[]): Stats {
  if (values.length === 0) return { mean: 0, stdDev: null };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  if (values.length < MIN_POINTS_FOR_STDDEV) return { mean, stdDev: null };
  const variance =
    values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (values.length - 1);
  return { mean, stdDev: Math.sqrt(variance) };
}

// ---------------------------------------------------------------------------
// Классификация притока
// ---------------------------------------------------------------------------

export type SignupClass = "organic" | "referral" | "seed";

/**
 * К какому из трёх типов притока относится регистрация.
 *
 * `referral` — пришёл по личной инвайт-ссылке, это прямая виральность и она
 * считается отдельно. `organic` — атрибуции нет вообще, именно этот ряд
 * образует базовую линию и её превышение. Всё остальное (`tg:<кампания>`,
 * `mobile`, `web:*`) — `seed`: размеченное привлечение, которое и порождает
 * последующее сарафанное радио, то есть знаменатель `K_wom`.
 */
export function classifySignup(channel: string): SignupClass {
  if (channel === "organic") return "organic";
  if (channel === "referral") return "referral";
  return "seed";
}

/** К каким срезам относится эта регистрация (всегда включая `global`). */
export function scopesOf(row: SignupRow): string[] {
  const out = [GLOBAL_SCOPE];
  if (row.cityKey) out.push(cityScope(row.cityKey));
  if (row.universityDomain) out.push(universityScope(row.universityDomain));
  return out;
}

// ---------------------------------------------------------------------------
// Дневной ряд
// ---------------------------------------------------------------------------

export interface DayCounts {
  day: string;
  signups: number;
  organicSignups: number;
  referralSignups: number;
  seedSignups: number;
}

/**
 * Свернуть регистрации в дневной ряд, БЕЗ пропусков.
 *
 * Дни с нулём регистраций обязаны присутствовать нулевыми строками: скользящая
 * база — среднее по последним N ДНЯМ, а не по последним N НЕПУСТЫМ дням. Если
 * пропустить пустые, окно молча растянется на месяц назад и база начнёт
 * описывать другой период продукта.
 */
export function aggregateDays(
  rows: readonly SignupRow[],
  days: readonly string[],
): DayCounts[] {
  const byDay = new Map<string, DayCounts>();
  for (const day of days) {
    byDay.set(day, {
      day,
      signups: 0,
      organicSignups: 0,
      referralSignups: 0,
      seedSignups: 0,
    });
  }

  for (const row of rows) {
    const bucket = byDay.get(toDayKey(row.createdAt));
    if (!bucket) continue; // регистрация вне запрошенного окна
    bucket.signups += 1;
    switch (classifySignup(row.channel)) {
      case "organic":
        bucket.organicSignups += 1;
        break;
      case "referral":
        bucket.referralSignups += 1;
        break;
      case "seed":
        bucket.seedSignups += 1;
        break;
    }
  }

  return days.map((day) => byDay.get(day)!);
}

/** Почему `kWom` невычислим (или вычислим). */
export type WomStatus = "ok" | "immature" | "no-seed";

export interface DayMetrics extends DayCounts {
  baselineOrganic: number | null;
  baselineStdDev: number | null;
  organicUplift: number | null;
  kWom: number | null;
  womStatus: WomStatus;
}

/**
 * Достроить дневной ряд базовой линией органики и `K_wom`.
 *
 * База для дня `i` — среднее органики за `windowDays` ПРЕДЫДУЩИХ дней, сам день
 * в неё не входит. Иначе всплеск, который мы ищем, поднимал бы собственную
 * планку и переставал быть всплеском — классическая ошибка, из-за которой
 * скользящее среднее «не видит» ровно то событие, ради которого его считают.
 *
 * Окно требуется ПОЛНЫМ: пока предыдущих дней меньше `windowDays`, база не
 * возвращается вовсе (`immature`). Считать среднее по трём дням и называть его
 * базовой линией — это выдавать точность, которой нет.
 */
export function withOrganicBaseline(
  series: readonly DayCounts[],
  windowDays: number = BASELINE_WINDOW_DAYS,
): DayMetrics[] {
  const out: DayMetrics[] = [];

  for (let i = 0; i < series.length; i += 1) {
    const day = series[i];
    const haveFullWindow = i >= windowDays;
    const window = haveFullWindow
      ? series.slice(i - windowDays, i).map((d) => d.organicSignups)
      : [];

    if (!haveFullWindow) {
      out.push({
        ...day,
        baselineOrganic: null,
        baselineStdDev: null,
        organicUplift: null,
        kWom: null,
        womStatus: "immature",
      });
      continue;
    }

    const { mean, stdDev } = stats(window);
    // Прирост округляется ОДИН раз, и `kWom` считается уже из округлённого:
    // иначе делённые друг на друга показанные числа не дают показанную ставку,
    // и первый же человек, проверивший строку на калькуляторе, перестаёт
    // доверять всей таблице.
    const uplift = round(Math.max(0, day.organicSignups - mean), 2);
    const kWom = day.seedSignups > 0 ? round(uplift / day.seedSignups) : null;

    out.push({
      ...day,
      baselineOrganic: round(mean, 2),
      baselineStdDev: stdDev === null ? null : round(stdDev, 2),
      organicUplift: uplift,
      kWom,
      womStatus: day.seedSignups > 0 ? "ok" : "no-seed",
    });
  }

  return out;
}

/**
 * `K_wom` за ПЕРИОД: суммарный прирост, делённый на суммарное семя.
 *
 * Считается отдельно от подневного, а не усредняется из него, и это не
 * придирка: среднее подневных отношений — это не отношение сумм, а на малых
 * числах расхождение между ними больше самой метрики. День с одной платной
 * регистрацией и приростом в три человека дал бы `K_wom = 3` и в среднем
 * перевесил бы неделю честных данных. Читать фаундеру нужно именно это число.
 */
export function periodWom(days: readonly DayMetrics[]): PeriodWom {
  const measurable = days.filter((d) => d.organicUplift !== null);
  const seed = measurable.reduce((a, d) => a + d.seedSignups, 0);
  const organic = measurable.reduce((a, d) => a + d.organicSignups, 0);
  if (measurable.length === 0) {
    return {
      uplift: null,
      seed: 0,
      organic: 0,
      kWom: null,
      measurableDays: 0,
      upliftShareOfOrganic: null,
    };
  }
  const uplift = measurable.reduce((a, d) => a + (d.organicUplift ?? 0), 0);
  return {
    uplift: round(uplift, 2),
    seed,
    organic,
    kWom: ratio(uplift, seed),
    measurableDays: measurable.length,
    upliftShareOfOrganic: ratio(uplift, organic),
  };
}

export interface PeriodWom {
  uplift: number | null;
  seed: number;
  organic: number;
  kWom: number | null;
  measurableDays: number;
  /**
   * Какая доля всей органики объявлена приростом над базой.
   *
   * Это проверка ПРЕДПОСЫЛКИ метода, а не ещё одна метрика. Скользящая база
   * описывает «сколько органики приходит, когда ничего не происходит», и это
   * утверждение имеет смысл только на более-менее стационарном ряде. На
   * растущем продукте органика каждый день выше вчерашней, поэтому база всегда
   * отстаёт, и «прирост» получается каждый день — то есть весь рост продукта
   * записывается в сарафанное радио. Когда эта доля близка к единице, база
   * ничего не объясняет, и `K_wom` меряет не WOM, а наклон кривой.
   */
  upliftShareOfOrganic: number | null;
}

// ---------------------------------------------------------------------------
// Когортный K-фактор
// ---------------------------------------------------------------------------

/**
 * Активация приглашённого, отнесённая к рефереру.
 *
 * Грузится БЕЗ фильтра по срезу намеренно: когорта киевлян, приведшая человека
 * во Львов, всё равно её привела. Отфильтровать приглашённых по городу реферера
 * значило бы приписать виральность географии приглашённого, а не тому, кто
 * поделился.
 */
export interface ActivationRow {
  referrerId: string;
  activatedAt: Date;
}

export interface CohortMetrics {
  cohortDate: string;
  maturityDay: number;
  cohortSize: number;
  sharers: number;
  invitesSent: number;
  linkClicks: number;
  activations: number;
  invitesPerUser: number;
  clickRate: number | null;
  activationRate: number | null;
  kDirect: number;
  cycleTimeMedianHours: number | null;
  kWom: number | null;
  kTotal: number;
  mature: boolean;
}

/** Конец окна наблюдения: `T0` + `maturityDay` суток, полуинтервал. */
function windowEnd(cohortDay: Date, maturityDay: number): Date {
  return new Date(cohortDay.getTime() + maturityDay * DAY_MS);
}

/**
 * Одна ячейка когортной матрицы.
 *
 * `members` — те, кто зарегистрировался в день когорты (в этом срезе).
 * `events` — вся воронка шеринга за период; фильтр по членам и по окну делается
 * здесь, чтобы вызывающему не пришлось повторять определение окна.
 * `activationsByReferrer` — активации приглашённых, сгруппированные по рефереру.
 *
 * Про исторические данные: `invitesSent`/`linkClicks` появились вместе с
 * таблицей `referral_events`, поэтому у когорт до неё они нули, а `clickRate`
 * и `activationRate` — `null`. `kDirect` при этом считается честно с первого
 * дня, потому что стоит на `referralCountedAt`, который существовал всегда.
 * Именно поэтому воронка и K-фактор возвращаются как разные поля, а не одно
 * произведение: одно из них старше другого.
 */
export function computeCohort(params: {
  cohortDate: string;
  cohortDay: Date;
  maturityDay: number;
  members: readonly SignupRow[];
  events: readonly FunnelEventRow[];
  activationsByReferrer: ReadonlyMap<string, readonly ActivationRow[]>;
  kWom: number | null;
  now: Date;
}): CohortMetrics {
  const { cohortDate, cohortDay, maturityDay, members, events, activationsByReferrer } = params;
  const end = windowEnd(cohortDay, maturityDay);
  const memberIds = new Set(members.map((m) => m.userId));
  const registeredAt = new Map(members.map((m) => [m.userId, m.createdAt]));

  let invitesSent = 0;
  let linkClicks = 0;
  const sharerIds = new Set<string>();

  for (const ev of events) {
    if (!ev.referrerId || !memberIds.has(ev.referrerId)) continue;
    if (ev.occurredAt < cohortDay || ev.occurredAt >= end) continue;
    switch (ev.kind) {
      case "share_sheet_opened":
        sharerIds.add(ev.referrerId);
        break;
      case "invite_sent":
        invitesSent += 1;
        // Отправивший приглашение — заведомо поделившийся, даже если события
        // открытия шторки не сохранилось (старый клиент, потерянный батч).
        sharerIds.add(ev.referrerId);
        break;
      case "invite_link_clicked":
        linkClicks += 1;
        break;
    }
  }

  let activations = 0;
  const cycleTimes: number[] = [];
  for (const memberId of memberIds) {
    const rows = activationsByReferrer.get(memberId);
    if (!rows) continue;
    const referrerRegisteredAt = registeredAt.get(memberId);
    for (const row of rows) {
      if (row.activatedAt < cohortDay || row.activatedAt >= end) continue;
      activations += 1;
      if (referrerRegisteredAt) {
        cycleTimes.push(
          (row.activatedAt.getTime() - referrerRegisteredAt.getTime()) / 3_600_000,
        );
      }
    }
  }

  const cohortSize = members.length;
  const kDirect = cohortSize > 0 ? round(activations / cohortSize) : 0;
  const cycleMedian = median(cycleTimes);

  return {
    cohortDate,
    maturityDay,
    cohortSize,
    sharers: sharerIds.size,
    invitesSent,
    linkClicks,
    activations,
    invitesPerUser: cohortSize > 0 ? round(invitesSent / cohortSize) : 0,
    clickRate: funnelRate(linkClicks, invitesSent),
    activationRate: funnelRate(activations, linkClicks),
    kDirect,
    cycleTimeMedianHours: cycleMedian === null ? null : round(cycleMedian, 1),
    kWom: params.kWom,
    kTotal: round(kDirect + (params.kWom ?? 0)),
    // Окно закрыто, только когда ВЕСЬ период уже в прошлом. Строка за сегодня
    // с `mature: true` означала бы «D7 измерен» через час после регистрации.
    mature: params.now.getTime() >= end.getTime(),
  };
}

export interface CohortAggregate {
  maturityDay: number;
  /** Сколько когорт попало в период. */
  cohorts: number;
  /** Из них зрелых — только они и посчитаны ниже. */
  matureCohorts: number;
  cohortSize: number;
  sharers: number;
  invitesSent: number;
  linkClicks: number;
  activations: number;
  /** Доля когорты, открывшей шеринг хоть раз. */
  shareRate: number | null;
  invitesPerUser: number | null;
  clickRate: number | null;
  activationRate: number | null;
  /** `i × c` за период. */
  kDirect: number | null;
  cycleTimeMedianHours: number | null;
}

/**
 * Свести когорты одного дня зрелости за период в одно число.
 *
 * Отношение сумм, а не среднее отношений. Когорта из двух человек, один из
 * которых кого-то привёл, даёт `K = 0.5`; усреднив её с честной сотней, где
 * `K = 0.04`, получаем 0.27 — число, которого не наблюдал никто. Правило то же,
 * что в `periodWom`, и нарушать его на маленькой базе особенно дорого.
 *
 * Считаются ТОЛЬКО зрелые когорты. Незрелые остаются в `cohorts`, чтобы
 * читатель видел, сколько данных ещё не пришло, но в числитель не попадают:
 * когорта, прожившая три дня из тридцати, занижает D30 просто тем, что она
 * молодая, и подмешивать её значит объявлять падением течение времени.
 *
 * `null` вместо нуля, когда зрелых когорт нет вовсе, — то же правило, что
 * всюду в файле.
 */
export function aggregateCohorts(
  rows: readonly CohortMetrics[],
  options: { matureOnly?: boolean } = {},
): CohortAggregate | null {
  if (rows.length === 0) return null;
  const matureOnly = options.matureOnly ?? true;
  const maturityDay = rows[0].maturityDay;
  const counted = matureOnly ? rows.filter((r) => r.mature) : [...rows];

  const sum = (pick: (r: CohortMetrics) => number): number =>
    counted.reduce((acc, r) => acc + pick(r), 0);

  const cohortSize = sum((r) => r.cohortSize);
  const invitesSent = sum((r) => r.invitesSent);
  const linkClicks = sum((r) => r.linkClicks);
  const activations = sum((r) => r.activations);
  const sharers = sum((r) => r.sharers);

  // Медиана медиан, а не медиана всех циклов: подневные значения уже свёрнуты
  // при записи предагрегата, и восстанавливать из них исходное распределение
  // нельзя. Это оценка, и она названа медианой когорт, а не медианой циклов.
  const cycle = median(
    counted
      .map((r) => r.cycleTimeMedianHours)
      .filter((v): v is number => v !== null),
  );

  return {
    maturityDay,
    cohorts: rows.length,
    matureCohorts: counted.length,
    cohortSize,
    sharers,
    invitesSent,
    linkClicks,
    activations,
    shareRate: funnelRate(sharers, cohortSize),
    invitesPerUser: ratio(invitesSent, cohortSize),
    clickRate: funnelRate(linkClicks, invitesSent),
    activationRate: funnelRate(activations, linkClicks),
    kDirect: ratio(activations, cohortSize),
    cycleTimeMedianHours: cycle === null ? null : round(cycle, 1),
  };
}

/** Сгруппировать активации по рефереру — вход для `computeCohort`. */
export function groupActivations(
  rows: readonly ActivationRow[],
): Map<string, ActivationRow[]> {
  const out = new Map<string, ActivationRow[]>();
  for (const row of rows) {
    const list = out.get(row.referrerId);
    if (list) list.push(row);
    else out.set(row.referrerId, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Опрос HDYHAU и калибровка WOM
// ---------------------------------------------------------------------------

export interface HdyhauDistributionRow {
  answer: string;
  count: number;
  /** Доля от всех ответивших, 0..1. */
  share: number;
}

export interface HdyhauSummary {
  total: number;
  byAnswer: HdyhauDistributionRow[];
  /** Доля устных рекомендаций среди ВСЕХ ответивших. */
  womShare: number | null;
  /** Сколько ответивших пришли БЕЗ атрибуции вообще. */
  organicRespondents: number;
  /**
   * Доля устных рекомендаций среди тех, кто пришёл неразмеченной органикой, —
   * та самая величина, ради которой опрос существует. Пришёл «ниоткуда», а
   * говорит «друг рассказал» — значит, привёл его человек, а не канал.
   */
  womShareOfOrganic: number | null;
}

export function summarizeHdyhau(rows: readonly HdyhauRow[]): HdyhauSummary {
  const counts = new Map<string, number>();
  let wom = 0;
  let organicRespondents = 0;
  let organicWom = 0;

  for (const row of rows) {
    counts.set(row.answer, (counts.get(row.answer) ?? 0) + 1);
    if (row.wordOfMouth) wom += 1;
    if (classifySignup(row.channel) === "organic") {
      organicRespondents += 1;
      if (row.wordOfMouth) organicWom += 1;
    }
  }

  const total = rows.length;
  return {
    total,
    byAnswer: [...counts.entries()]
      .map(([answer, count]) => ({
        answer,
        count,
        share: round(count / total, 4),
      }))
      .sort((a, b) => b.count - a.count || a.answer.localeCompare(b.answer)),
    womShare: ratio(wom, total),
    organicRespondents,
    womShareOfOrganic: ratio(organicWom, organicRespondents),
  };
}

export interface WomCalibration {
  /** Какой оценкой посчитан `kWom`. */
  method: "hdyhau" | "baseline" | "none";
  /** Ответивших-органиков / всех органиков за период, 0..1. */
  coverage: number | null;
  /** Прирост по скользящей базе. */
  upliftFromBaseline: number | null;
  /** Прирост по опросу: органика × доля «меня привёл человек». */
  upliftFromSurvey: number | null;
  kWom: number | null;
  /** Почему выбран именно этот метод — для агента, а не для человека. */
  reason: string;
  /**
   * Можно ли на это число опираться. Число возвращается в любом случае —
   * прятать его значило бы лишить читателя возможности увидеть, что метод
   * сломался, — но `low` обязано быть показано рядом с ним.
   */
  confidence: "ok" | "low";
  /** Что именно подрывает доверие. Пусто при `ok`. */
  confidenceReasons: string[];
}

/**
 * Минимальная «семенная» когорта, при которой делить на неё осмысленно.
 *
 * И абсолютный порог, и доля: десять платных регистраций на полторы тысячи
 * органических — это не знаменатель, а случайность, и весь органический рост
 * продукта, поделённый на них, даёт `K_wom` в единицах, которых не бывает.
 */
export const WOM_MIN_SEED = 10;
export const WOM_MIN_SEED_SHARE = 0.05;

/**
 * Доля органики, объявленная приростом, выше которой базовая линия перестаёт
 * что-либо объяснять (продукт в фазе роста — см. `upliftShareOfOrganic`).
 */
export const WOM_MAX_UPLIFT_SHARE = 0.5;

/**
 * Свести две независимые оценки устной виральности в одну.
 *
 * Они меряют одно разными инструментами: база — по форме кривой органики,
 * опрос — прямым вопросом человеку. Опрос точнее по смыслу и слабее по
 * покрытию, поэтому он вытесняет базу только когда ответила заметная доля
 * органического притока (`HDYHAU_MIN_COVERAGE`). Обе оценки возвращаются
 * всегда: расхождение между ними — само по себе сигнал, что одна из двух
 * методик врёт, и прятать его значит лишить читателя единственной проверки.
 */
export function calibrateWom(params: {
  organicSignups: number;
  seedSignups: number;
  baselineUplift: number | null;
  hdyhau: HdyhauSummary;
  minCoverage?: number;
  /** `uplift / organic` за тот же период — проверка предпосылки метода. */
  upliftShareOfOrganic?: number | null;
}): WomCalibration {
  const minCoverage = params.minCoverage ?? HDYHAU_MIN_COVERAGE;
  const coverage =
    params.organicSignups > 0
      ? round(Math.min(1, params.hdyhau.organicRespondents / params.organicSignups), 4)
      : null;

  const surveyUplift =
    params.hdyhau.womShareOfOrganic === null
      ? null
      : round(params.organicSignups * params.hdyhau.womShareOfOrganic, 2);

  const surveyUsable =
    surveyUplift !== null && coverage !== null && coverage >= minCoverage;

  const uplift = surveyUsable ? surveyUplift : params.baselineUplift;
  const method: WomCalibration["method"] =
    uplift === null ? "none" : surveyUsable ? "hdyhau" : "baseline";

  const reason = surveyUsable
    ? `survey coverage ${coverage} >= ${minCoverage}`
    : coverage === null
      ? "no organic signups in period"
      : surveyUplift === null
        ? "no survey answers from organic arrivals"
        : `survey coverage ${coverage} < ${minCoverage}`;

  // Доверие проверяется ОТДЕЛЬНО от выбора метода: оба метода делят на одну и
  // ту же семенную когорту, и слишком маленький знаменатель ломает их одинаково.
  const confidenceReasons: string[] = [];
  const totalSignups = params.organicSignups + params.seedSignups;
  if (params.seedSignups > 0 && params.seedSignups < WOM_MIN_SEED) {
    confidenceReasons.push(
      `seed cohort is ${params.seedSignups} (< ${WOM_MIN_SEED}) — too small a denominator to divide by`,
    );
  }
  if (
    params.seedSignups > 0 &&
    totalSignups > 0 &&
    params.seedSignups / totalSignups < WOM_MIN_SEED_SHARE
  ) {
    confidenceReasons.push(
      `seed cohort is ${round((params.seedSignups / totalSignups) * 100, 1)}% of acquisition — ` +
        `attributing all organic uplift to it overstates K_wom`,
    );
  }
  if (
    params.upliftShareOfOrganic !== null &&
    params.upliftShareOfOrganic !== undefined &&
    params.upliftShareOfOrganic > WOM_MAX_UPLIFT_SHARE
  ) {
    confidenceReasons.push(
      `${round(params.upliftShareOfOrganic * 100, 1)}% of organic reads as uplift — the trailing ` +
        `baseline explains almost nothing, which is what a growth ramp looks like, not word of mouth`,
    );
  }

  return {
    method,
    coverage,
    upliftFromBaseline: params.baselineUplift,
    upliftFromSurvey: surveyUplift,
    kWom: uplift === null ? null : ratio(uplift, params.seedSignups),
    reason,
    confidence: confidenceReasons.length > 0 ? "low" : "ok",
    confidenceReasons,
  };
}

// ---------------------------------------------------------------------------
// Аномалии
// ---------------------------------------------------------------------------

export type AnomalyKind = "organic_spike" | "organic_drop" | "cycle_time_shift";

export interface Anomaly {
  kind: AnomalyKind;
  /** Ключ точки: UTC-день для органики, дата когорты для цикла. */
  at: string;
  scope: string;
  observed: number;
  expected: number;
  stdDev: number;
  /** Отклонение в сигмах, со знаком. */
  zScore: number;
  direction: "up" | "down";
}

/**
 * Всплески и провалы неразмеченной органики относительно её собственной базы.
 *
 * Провалы возвращаются наравне со всплесками, хотя ТЗ просит только всплески:
 * обвал органики на 2σ — это сломавшаяся ссылка, отвалившийся редирект или
 * забаненный аккаунт, и узнавать о нём из недельного отчёта дороже, чем
 * добавить сюда одно сравнение.
 */
export function detectOrganicAnomalies(
  series: readonly DayMetrics[],
  scope: string,
  sigma: number = ANOMALY_SIGMA,
): Anomaly[] {
  const out: Anomaly[] = [];
  for (const day of series) {
    const { baselineOrganic, baselineStdDev } = day;
    if (baselineOrganic === null) continue; // база не набрана — судить не о чем
    const spread = effectiveSpread(baselineOrganic, baselineStdDev);
    if (spread === null) continue;

    const z = (day.organicSignups - baselineOrganic) / spread;
    if (Math.abs(z) < sigma) continue;
    out.push({
      kind: z > 0 ? "organic_spike" : "organic_drop",
      at: day.day,
      scope,
      observed: day.organicSignups,
      expected: baselineOrganic,
      // Возвращается ИМЕННО тот разброс, на который поделено, а не хранимое
      // выборочное СКО: иначе читатель, перемноживший показанные числа, не
      // получит показанный z и решит, что ошибся кто-то другой.
      stdDev: round(spread, 2),
      zScore: round(z, 2),
      direction: z > 0 ? "up" : "down",
    });
  }
  return out;
}

/**
 * Разброс, относительно которого меряется отклонение дня.
 *
 * Пуассоновский пол `√base`, а не голое выборочное СКО, и вот почему это не
 * украшение. Ряд регистраций — счётные данные: у потока со средним λ разброс
 * сам по себе около `√λ`, даже когда ничего не происходит. Ровный на вид
 * участок (пять дней ровно по 2) даёт выборочное σ = 0, а с нулём в знаменателе
 * порог 2σ вырождается: либо любое отличие бесконечно велико, либо — как было
 * здесь до этой правки — такие дни молча выпадают из проверки. Второе хуже
 * первого: слепой оказывается ровно та ситуация, ради которой метрика заведена,
 * — тихий маленький город, в котором вдруг случился кампусный дроп.
 *
 * Берётся МАКСИМУМ из наблюдённого и пуассоновского: на шумном ряде остаётся
 * наблюдённый (не выдумываем чувствительности, которой нет), на ровном
 * появляется пол (не теряем всплеск). Нулевая база порога всё равно не даёт —
 * там и истории никакой нет.
 */
function effectiveSpread(baseline: number, sampleStdDev: number | null): number | null {
  const poisson = Math.sqrt(Math.max(0, baseline));
  const spread = Math.max(sampleStdDev ?? 0, poisson);
  return spread > 0 ? spread : null;
}

/**
 * Сдвиг времени вирального цикла.
 *
 * Ряд — медианный `cycleTime` зрелых когорт на ОДНОМ дне зрелости; сравнивать
 * D7 с D30 нельзя, потому что более длинное окно всегда впускает более медленные
 * активации и медиана растёт сама собой, без единого изменения в продукте.
 * Порог — тот же 2σ по скользящему окну предыдущих когорт.
 */
export function detectCycleTimeAnomalies(
  cohorts: readonly CohortMetrics[],
  scope: string,
  sigma: number = ANOMALY_SIGMA,
  windowSize: number = BASELINE_WINDOW_DAYS,
): Anomaly[] {
  const points = cohorts
    .filter((c) => c.mature && c.cycleTimeMedianHours !== null)
    .sort((a, b) => a.cohortDate.localeCompare(b.cohortDate));

  const out: Anomaly[] = [];
  for (let i = windowSize; i < points.length; i += 1) {
    const window = points
      .slice(i - windowSize, i)
      .map((c) => c.cycleTimeMedianHours as number);
    const { mean, stdDev } = stats(window);
    if (stdDev === null || stdDev <= 0) continue;
    const observed = points[i].cycleTimeMedianHours as number;
    const z = (observed - mean) / stdDev;
    if (Math.abs(z) < sigma) continue;
    out.push({
      kind: "cycle_time_shift",
      at: points[i].cohortDate,
      scope,
      observed: round(observed, 1),
      expected: round(mean, 1),
      stdDev: round(stdDev, 2),
      zScore: round(z, 2),
      direction: z > 0 ? "up" : "down",
    });
  }
  return out;
}
