import { DAY_MS, dayRange, toDayKey } from "../admin/utils/activity.js";
import {
  loadActivations,
  loadFunnelEvents,
  loadSignups,
  replaceViralityCohorts,
  replaceViralityDays,
  type ScopedCohortMetrics,
  type ScopedDayMetrics,
} from "../admin/utils/virality-source.js";
import {
  BASELINE_WINDOW_DAYS,
  GLOBAL_SCOPE,
  MATURITY_DAYS,
  aggregateDays,
  computeCohort,
  groupActivations,
  scopesOf,
  withOrganicBaseline,
  type ActivationRow,
  type FunnelEventRow,
  type SignupRow,
} from "../admin/utils/virality.js";

/**
 * Фоновый пересчёт виральности в `virality_days` / `virality_cohorts`.
 *
 * Почему это задача, а не вычисление на запросе: чтобы получить K-фактор одной
 * когорты, нужно пройти регистрации за окно наблюдения, воронку шеринга за то
 * же окно и активации приглашённых, которые могли случиться позже, — и всё это
 * для каждого из пяти дней зрелости и каждого кластера. На запросе это скан
 * `users` за месяцы с джойном на профили, а читателей у метрики двое, и оба
 * ходят регулярно: дашборд и агент Hermes.
 *
 * Прогон ИДЕМПОТЕНТЕН и переписывает окно целиком (см. `replaceViralityDays`).
 * Поэтому пропущенный по любой причине запуск не оставляет дыры: следующий
 * пересчитает то же окно заново.
 */

/**
 * Сколько дней истории пересчитывается за прогон.
 *
 * Не «только вчера»: когорта дозревает 30 дней, и её строка D30 меняется через
 * месяц после того, как сама когорта закрылась. Окно в 120 дней означает, что
 * любая когорта пересчитывается на каждом дне зрелости хотя бы раз после того,
 * как этот день наступил.
 */
export const ROLLUP_WINDOW_DAYS = 120;

/**
 * Минимальный размер кластера, при котором он получает собственные строки.
 *
 * Город с тремя регистрациями даёт K-фактор, который меняется втрое от одного
 * человека. Такие срезы не «неточные», они бессмысленные, и хранить их значит
 * заполнить таблицу шумом, в котором настоящий кластерный сигнал утонет.
 * Глобальный срез порогу не подчиняется — он существует всегда.
 */
export const MIN_CLUSTER_SIGNUPS = 5;

export interface ViralityRollupResult {
  /** Границы пересчитанного окна, UTC-дни. */
  from: string;
  to: string;
  /** Сколько срезов прошло порог (включая `global`). */
  scopes: number;
  dayRows: number;
  cohortRows: number;
}

/** Полночь UTC того же календарного дня. */
function utcMidnight(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Один прогон.
 *
 * Порядок здесь важен и не случаен:
 *   1. Регистрации грузятся с ЗАПАСОМ в `BASELINE_WINDOW_DAYS` назад — иначе у
 *      самого раннего дня окна не из чего построить базовую линию, и первые две
 *      недели отчёта навсегда оставались бы `immature`.
 *   2. Активации грузятся по окну наблюдения, а не по окну регистраций: человек
 *      из мартовской когорты мог активироваться сегодня.
 *   3. Дневной ряд считается ДО когорт, потому что `K_wom` дня привлечения
 *      входит в `K_total` когорты этого дня.
 */
export async function viralityRollupTick(
  now: Date = new Date(),
  options: { windowDays?: number; includeTest?: boolean } = {},
): Promise<ViralityRollupResult> {
  const windowDays = options.windowDays ?? ROLLUP_WINDOW_DAYS;
  const includeTest = options.includeTest ?? false;
  const today = utcMidnight(now);
  const rangeStart = new Date(today.getTime() - (windowDays - 1) * DAY_MS);
  const warmupStart = new Date(rangeStart.getTime() - BASELINE_WINDOW_DAYS * DAY_MS);
  // Верхняя граница — конец сегодняшнего дня: сегодняшняя когорта незрелая, но
  // её строка нужна, иначе матрица обрывается вчерашним днём.
  const rangeEnd = new Date(today.getTime() + DAY_MS - 1);

  const [signups, activations, events] = await Promise.all([
    loadSignups(warmupStart, rangeEnd, { includeTest }),
    // Активации — за то же окно наблюдения, что и события: приглашённый
    // когорты из начала окна может активироваться в самом его конце.
    loadActivations(warmupStart, rangeEnd, { includeTest }),
    loadFunnelEvents(warmupStart, rangeEnd),
  ]);

  const scopes = selectScopes(signups, rangeStart);
  const warmupDays = dayRange(warmupStart, today);
  const reportedDays = dayRange(rangeStart, today);
  const reported = new Set(reportedDays);
  const activationsByReferrer = groupActivations(activations);
  const computedAt = new Date();

  const dayRows: ScopedDayMetrics[] = [];
  const cohortRows: ScopedCohortMetrics[] = [];

  for (const scope of scopes) {
    const scopeSignups = signups.filter((s) => scopesOf(s).includes(scope));

    // Ряд строится по РАСШИРЕННОМУ окну (с разгоном), а сохраняется только
    // отчётная его часть: разгон нужен базовой линии, но сам по себе он
    // пересчитывается не полностью и хранить его было бы враньём.
    const series = withOrganicBaseline(aggregateDays(scopeSignups, warmupDays));
    const womByDay = new Map(series.map((d) => [d.day, d.kWom]));

    for (const day of series) {
      if (reported.has(day.day)) dayRows.push({ ...day, scope });
    }

    const membersByDay = new Map<string, SignupRow[]>();
    for (const row of scopeSignups) {
      const key = toDayKey(row.createdAt);
      if (!reported.has(key)) continue;
      const list = membersByDay.get(key);
      if (list) list.push(row);
      else membersByDay.set(key, [row]);
    }

    for (const cohortDate of reportedDays) {
      const members = membersByDay.get(cohortDate) ?? [];
      // Пустая когорта пропускается: строка с нулевым знаменателем не несёт
      // информации, а в матрице занимает место, которое читатель прочтёт как
      // «K = 0» вместо «в этот день никто не пришёл».
      if (members.length === 0) continue;
      const cohortDay = new Date(`${cohortDate}T00:00:00.000Z`);
      for (const maturityDay of MATURITY_DAYS) {
        cohortRows.push({
          scope,
          ...computeCohort({
            cohortDate,
            cohortDay,
            maturityDay,
            members,
            events,
            activationsByReferrer,
            kWom: womByDay.get(cohortDate) ?? null,
            now,
          }),
        });
      }
    }
  }

  const [days, cohorts] = await Promise.all([
    replaceViralityDays(rangeStart, today, dayRows, computedAt),
    replaceViralityCohorts(rangeStart, today, cohortRows, computedAt),
  ]);

  return {
    from: toDayKey(rangeStart),
    to: toDayKey(today),
    scopes: scopes.length,
    dayRows: days,
    cohortRows: cohorts,
  };
}

/**
 * Какие срезы считать: глобальный плюс всякий кластер, набравший
 * `MIN_CLUSTER_SIGNUPS` регистраций внутри ОТЧЁТНОГО окна.
 *
 * Порог проверяется по отчётному окну, а не по загруженному с разгоном: иначе
 * город, живший две недели до начала окна и заглохший, продолжал бы получать
 * строки, состоящие из одних нулей.
 */
export function selectScopes(
  signups: readonly SignupRow[],
  rangeStart: Date,
): string[] {
  const counts = new Map<string, number>();
  for (const row of signups) {
    if (row.createdAt < rangeStart) continue;
    for (const scope of scopesOf(row)) {
      counts.set(scope, (counts.get(scope) ?? 0) + 1);
    }
  }

  const out = [GLOBAL_SCOPE];
  for (const [scope, count] of counts) {
    if (scope === GLOBAL_SCOPE) continue;
    if (count >= MIN_CLUSTER_SIGNUPS) out.push(scope);
  }
  return out.sort();
}

/** Реэкспорт типов, которыми пользуется тест воркера. */
export type { ActivationRow, FunnelEventRow, SignupRow };
