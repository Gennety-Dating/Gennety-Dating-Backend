import { Router, type Request, type Response } from "express";
import { DAY_MS, parseDayKey, toDayKey } from "../utils/activity.js";
import { bucketLabel, bucketRangeOf, type CohortBucket } from "../utils/cohort-retention.js";
import { getOrCompute } from "../utils/cache.js";
import {
  lastViralityRollupAt,
  listViralityScopes,
  loadHdyhauRows,
  readViralityCohorts,
  readViralityDays,
  type StoredCohortRow,
  type StoredDayRow,
} from "../utils/virality-source.js";
import {
  ANOMALY_SIGMA,
  GLOBAL_SCOPE,
  MATURITY_DAYS,
  aggregateCohorts,
  calibrateWom,
  detectCycleTimeAnomalies,
  detectOrganicAnomalies,
  parseScope,
  periodWom,
  round,
  summarizeHdyhau,
  type Anomaly,
  type CohortAggregate,
  type CohortMetrics,
  type DayMetrics,
} from "../utils/virality.js";

/**
 * Виральность: `/admin/analytics/virality/*`.
 *
 * **Почему не отдельный `/api/analytics/*` со своим сервисным токеном.** Агент
 * Hermes уже ходит СЮДА, на `api-admin.gennety.com`, с `Authorization: Bearer
 * <ADMIN_API_KEY>` (`docs/operations/hermes-agent-prompt.md`), и уже читает
 * этим ключом диалоги и стоимость привлечения. Второй базовый URL со вторым
 * ключом означал бы два места ротации секрета и два ответа на вопрос «кто
 * такой Hermes»; ровно поэтому маршруты живут за тем же гейтом, что и весь
 * остальной admin-API.
 *
 * **PII здесь нет и появиться не может.** Всё, что отдаётся, читается из
 * предагрегата (`virality_days`, `virality_cohorts`) — таблиц, в которых нет ни
 * одного пользовательского идентификатора: они хранят счётчики по дню и по
 * срезу. Распределение опроса складывается из закрытого перечня вариантов.
 * Единственные строки в ответе — ключ города, домен вуза и код варианта ответа.
 *
 * **Числа читаются из предагрегата, а не считаются на запросе.** Смысл фоновой
 * задачи в том, что запрос агента не превращается в скан `users` за четыре
 * месяца. Отсюда `rollupAt` в каждом ответе: у виральности нет «сейчас», есть
 * «на момент прогона», и не показать этот момент значит позволить прочитать
 * незапустившийся крон как падение метрики.
 */
export const viralityRouter: Router = Router();

/** Дольше этого запрашивать нельзя — тот же потолок, что у активности. */
const MAX_RANGE_DAYS = 400;
const DEFAULT_RANGE_DAYS = 30;
const CACHE_TTL_SECONDS = 600;

/**
 * Насколько старый предагрегат уже считается несвежим.
 *
 * 36 часов, а не 24: крон суточный, и ровно 24 объявляли бы просрочку при
 * любом сдвиге прогона на час. Полтора суток означают «одну ночь пропустили», и
 * это первое, что обязан увидеть агент, прежде чем объяснять просевшие числа
 * продуктом.
 */
const STALE_AFTER_HOURS = 36;

function badRequest(res: Response, error: string): void {
  res.status(400).json({ error });
}

interface Range {
  from: Date;
  to: Date;
}

/**
 * `?from=&to=` в UTC-днях. По умолчанию — последние 30 дней, включая сегодня.
 *
 * Сегодня НЕ отрезается, в отличие от `/admin/analytics/dau`: там метрика за
 * сегодня растёт весь день и читается как обвал каждое утро, а здесь ряд
 * рисуется целиком и незрелость дня видна по флагу `mature`, а не по его
 * отсутствию. Отрезать сегодняшнюю когорту значило бы прятать ровно тот день,
 * на который смотрят после запуска кампании.
 */
function parseRange(req: Request): Range | { error: string } {
  const rawFrom = req.query["from"];
  const rawTo = req.query["to"];

  const to = rawTo === undefined ? todayUtc() : parseDayKey(String(rawTo));
  if (!to) return { error: "to must be YYYY-MM-DD" };

  const from =
    rawFrom === undefined
      ? new Date(to.getTime() - (DEFAULT_RANGE_DAYS - 1) * DAY_MS)
      : parseDayKey(String(rawFrom));
  if (!from) return { error: "from must be YYYY-MM-DD" };

  if (from.getTime() > to.getTime()) return { error: "from must not be after to" };
  const days = Math.round((to.getTime() - from.getTime()) / DAY_MS) + 1;
  if (days > MAX_RANGE_DAYS) return { error: `range must be at most ${MAX_RANGE_DAYS} days` };

  return { from, to };
}

function todayUtc(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function parseScopeParam(req: Request): string {
  const raw = req.query["scope"];
  const scope = raw === undefined ? GLOBAL_SCOPE : String(raw).trim();
  return scope.length > 0 ? scope : GLOBAL_SCOPE;
}

/**
 * Свежесть предагрегата — одинаковая шапка у всех четырёх ответов.
 *
 * Возвращается ВСЕГДА, включая случай, когда прогона не было ни разу
 * (`rollupAt: null`, `stale: true`): пустой ответ без этой пометки читается как
 * «виральности нет», хотя на самом деле её ни разу не считали.
 */
async function freshness(): Promise<{
  rollupAt: string | null;
  rollupAgeHours: number | null;
  stale: boolean;
}> {
  const at = await lastViralityRollupAt();
  if (!at) return { rollupAt: null, rollupAgeHours: null, stale: true };
  const ageHours = (Date.now() - at.getTime()) / 3_600_000;
  return {
    rollupAt: at.toISOString(),
    rollupAgeHours: round(ageHours, 1),
    stale: ageHours > STALE_AFTER_HOURS,
  };
}

/** Хранимая строка → чистый `DayMetrics` (без `scope`/`computedAt`). */
function toDayMetrics(row: StoredDayRow): DayMetrics {
  return {
    day: row.day,
    signups: row.signups,
    organicSignups: row.organicSignups,
    referralSignups: row.referralSignups,
    seedSignups: row.seedSignups,
    baselineOrganic: row.baselineOrganic,
    baselineStdDev: row.baselineStdDev,
    organicUplift: row.organicUplift,
    kWom: row.kWom,
    womStatus: row.womStatus,
  };
}

function toCohortMetrics(row: StoredCohortRow): CohortMetrics {
  return {
    cohortDate: row.cohortDate,
    maturityDay: row.maturityDay,
    cohortSize: row.cohortSize,
    sharers: row.sharers,
    invitesSent: row.invitesSent,
    linkClicks: row.linkClicks,
    activations: row.activations,
    invitesPerUser: row.invitesPerUser,
    clickRate: row.clickRate,
    activationRate: row.activationRate,
    kDirect: row.kDirect,
    cycleTimeMedianHours: row.cycleTimeMedianHours,
    kWom: row.kWom,
    kTotal: row.kTotal,
    mature: row.mature,
  };
}

/** Сгруппировать дни в бакеты `day` / `week` для графика. */
function bucketDays(
  days: readonly DayMetrics[],
  granularity: CohortBucket,
): Array<{ bucket: string; days: DayMetrics[] }> {
  const out = new Map<string, DayMetrics[]>();
  for (const day of days) {
    const at = new Date(`${day.day}T00:00:00.000Z`);
    const label = bucketLabel(bucketRangeOf(at, granularity).start, granularity);
    const list = out.get(label);
    if (list) list.push(day);
    else out.set(label, [day]);
  }
  return [...out.entries()]
    .map(([bucket, list]) => ({ bucket, days: list }))
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/virality/summary
// ---------------------------------------------------------------------------

/**
 * Сводка: K_direct / K_wom / K_total, время цикла, воронка шеринга, ряд по дням
 * или неделям и распределение ответов опроса.
 *
 * `?granularity=day|week` управляет только рядом; KPI считаются по всему
 * периоду, потому что «K-фактор недели» и «K-фактор периода, показанный
 * понедельно» — разные числа, и складывать вторые в первое нельзя.
 */
viralityRouter.get(
  "/admin/analytics/virality/summary",
  async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ("error" in range) return badRequest(res, range.error);

    const rawGranularity = String(req.query["granularity"] ?? "day");
    if (rawGranularity !== "day" && rawGranularity !== "week") {
      return badRequest(res, "granularity must be day or week");
    }
    const granularity: CohortBucket = rawGranularity;
    const scope = parseScopeParam(req);

    try {
      const key =
        `virality_summary:v1:${toDayKey(range.from)}:${toDayKey(range.to)}` +
        `:${granularity}:${scope}`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          const [dayRows, cohortRows, hdyhauRows, fresh] = await Promise.all([
            readViralityDays(range.from, range.to, scope),
            readViralityCohorts(range.from, range.to, { scope }),
            // Опрос читается живьём: таблица размером с базу пользователей, а
            // не с журналом событий, и предагрегировать её значило бы завести
            // второй источник правды ради экономии одного индексного скана.
            loadHdyhauRows(range.from, endOfDay(range.to)),
            freshness(),
          ]);

          const days = dayRows.map(toDayMetrics);
          const cohorts = cohortRows.map(toCohortMetrics);
          const wom = periodWom(days);
          const hdyhau = summarizeHdyhau(hdyhauRows);
          const calibration = calibrateWom({
            organicSignups: wom.organic,
            seedSignups: wom.seed,
            baselineUplift: wom.uplift,
            hdyhau,
          });

          const byMaturity: Record<string, CohortAggregate & { kTotal: number | null }> = {};
          for (const maturityDay of MATURITY_DAYS) {
            const agg = aggregateCohorts(cohorts.filter((c) => c.maturityDay === maturityDay));
            if (!agg) continue;
            byMaturity[String(maturityDay)] = {
              ...agg,
              kTotal:
                agg.kDirect === null
                  ? null
                  : round(agg.kDirect + (calibration.kWom ?? 0)),
            };
          }

          // Заголовочная цифра — самый ДЛИННЫЙ день зрелости, у которого есть
          // хотя бы одна зрелая когорта: он ближе всех к полному циклу. Брать
          // D1 «потому что данных больше» значило бы публиковать заведомо
          // заниженный K и объяснять им отсутствие роста.
          const headlineDay = [...MATURITY_DAYS]
            .sort((a, b) => b - a)
            .find((d) => (byMaturity[String(d)]?.matureCohorts ?? 0) > 0);
          const headline = headlineDay ? byMaturity[String(headlineDay)] : null;

          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            ...fresh,
            range: { from: toDayKey(range.from), to: toDayKey(range.to) },
            scope,
            granularity,
            kpi: {
              maturityDay: headlineDay ?? null,
              kDirect: headline?.kDirect ?? null,
              kWom: calibration.kWom,
              kTotal: headline?.kTotal ?? null,
              cycleTimeMedianHours: headline?.cycleTimeMedianHours ?? null,
              matureCohorts: headline?.matureCohorts ?? 0,
              cohorts: headline?.cohorts ?? 0,
            },
            byMaturity,
            shareFunnel: headline
              ? {
                  cohortSize: headline.cohortSize,
                  sharers: headline.sharers,
                  shareRate: headline.shareRate,
                  invitesSent: headline.invitesSent,
                  invitesPerUser: headline.invitesPerUser,
                  linkClicks: headline.linkClicks,
                  clickRate: headline.clickRate,
                  activations: headline.activations,
                  activationRate: headline.activationRate,
                }
              : null,
            wom: {
              organicSignups: wom.organic,
              seedSignups: wom.seed,
              uplift: wom.uplift,
              kWomBaseline: wom.kWom,
              measurableDays: wom.measurableDays,
              calibration,
            },
            hdyhau,
            series: bucketDays(days, granularity).map(({ bucket, days: list }) => {
              const signups = list.reduce((a, d) => a + d.signups, 0);
              const organic = list.reduce((a, d) => a + d.organicSignups, 0);
              const referral = list.reduce((a, d) => a + d.referralSignups, 0);
              const seed = list.reduce((a, d) => a + d.seedSignups, 0);
              const bucketWom = periodWom(list);
              return {
                bucket,
                signups,
                organicSignups: organic,
                referralSignups: referral,
                seedSignups: seed,
                baselineOrganic: list.at(-1)?.baselineOrganic ?? null,
                organicUplift: bucketWom.uplift,
                kWom: bucketWom.kWom,
              };
            }),
          };
        },
        { req, res },
      );

      res.json(data);
    } catch (err) {
      console.error("[admin] virality summary failed:", err);
      res.status(500).json({ error: "Failed to compute virality summary" });
    }
  },
);

/** Конец UTC-дня — верхняя граница включающего запроса по времени. */
function endOfDay(day: Date): Date {
  return new Date(day.getTime() + DAY_MS - 1);
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/virality/cohorts
// ---------------------------------------------------------------------------

/**
 * Когортная матрица созревания: строка на когорту, колонка на день зрелости.
 *
 * Незрелые ячейки возвращаются с `mature: false`, а не пропускаются: дыра в
 * матрице читается как «данных нет», хотя правильное чтение — «окно ещё не
 * закрылось», и это разные вещи для того, кто решает, ждать или чинить.
 */
viralityRouter.get(
  "/admin/analytics/virality/cohorts",
  async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ("error" in range) return badRequest(res, range.error);
    const scope = parseScopeParam(req);

    try {
      const key = `virality_cohorts:v1:${toDayKey(range.from)}:${toDayKey(range.to)}:${scope}`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          const [rows, fresh] = await Promise.all([
            readViralityCohorts(range.from, range.to, { scope }),
            freshness(),
          ]);

          const byCohort = new Map<string, StoredCohortRow[]>();
          for (const row of rows) {
            const list = byCohort.get(row.cohortDate);
            if (list) list.push(row);
            else byCohort.set(row.cohortDate, [row]);
          }

          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            ...fresh,
            range: { from: toDayKey(range.from), to: toDayKey(range.to) },
            scope,
            maturityDays: MATURITY_DAYS,
            cohorts: [...byCohort.entries()]
              .sort((a, b) => a[0].localeCompare(b[0]))
              .map(([cohortDate, list]) => {
                const sorted = [...list].sort((a, b) => a.maturityDay - b.maturityDay);
                return {
                  cohortDate,
                  // Размер когорты не зависит от дня зрелости — выносится из
                  // ячеек наверх, чтобы читатель не сверял пять одинаковых
                  // чисел и не гадал, почему одно из них другое.
                  cohortSize: sorted[0]?.cohortSize ?? 0,
                  byMaturity: Object.fromEntries(
                    sorted.map((r) => [
                      String(r.maturityDay),
                      {
                        sharers: r.sharers,
                        invitesSent: r.invitesSent,
                        invitesPerUser: r.invitesPerUser,
                        linkClicks: r.linkClicks,
                        clickRate: r.clickRate,
                        activations: r.activations,
                        activationRate: r.activationRate,
                        kDirect: r.kDirect,
                        kWom: r.kWom,
                        kTotal: r.kTotal,
                        cycleTimeMedianHours: r.cycleTimeMedianHours,
                        mature: r.mature,
                      },
                    ]),
                  ),
                };
              }),
          };
        },
        { req, res },
      );

      res.json(data);
    } catch (err) {
      console.error("[admin] virality cohorts failed:", err);
      res.status(500).json({ error: "Failed to load virality cohorts" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/virality/clusters
// ---------------------------------------------------------------------------

/**
 * Виральный мультипликатор по кластерам (город / вуз).
 *
 * Смысл среза: сарафанное радио географично. Всплеск органики в кампусе, где на
 * прошлой неделе высадилась платная когорта, — это её сарафан, а тот же
 * всплеск в городе, где мы ничего не делали, — что-то другое, и лечится он
 * иначе. Глобальное среднее по определению не может показать ни того, ни
 * другого: два кластера с противоположной динамикой в нём взаимно уничтожаются.
 *
 * `?dimension=city|university` — какой класс кластеров вернуть;
 * `?maturityDay=` — на каком дне зрелости сравнивать (по умолчанию 7).
 */
viralityRouter.get(
  "/admin/analytics/virality/clusters",
  async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ("error" in range) return badRequest(res, range.error);

    const rawDimension = String(req.query["dimension"] ?? "city");
    if (rawDimension !== "city" && rawDimension !== "university") {
      return badRequest(res, "dimension must be city or university");
    }

    const rawMaturity = req.query["maturityDay"];
    const maturityDay = rawMaturity === undefined ? 7 : Number(rawMaturity);
    if (!MATURITY_DAYS.includes(maturityDay)) {
      return badRequest(res, `maturityDay must be one of ${MATURITY_DAYS.join(", ")}`);
    }

    try {
      const key =
        `virality_clusters:v1:${toDayKey(range.from)}:${toDayKey(range.to)}` +
        `:${rawDimension}:${maturityDay}`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          const [scopes, fresh] = await Promise.all([
            listViralityScopes(range.from, range.to),
            freshness(),
          ]);
          const wanted = scopes.filter(
            (s) => parseScope(s).dimension === rawDimension && s !== GLOBAL_SCOPE,
          );

          const [dayRows, cohortRows] = await Promise.all([
            readViralityDays(range.from, range.to),
            readViralityCohorts(range.from, range.to, { maturityDay }),
          ]);

          const daysByScope = new Map<string, DayMetrics[]>();
          for (const row of dayRows) {
            const list = daysByScope.get(row.scope);
            if (list) list.push(toDayMetrics(row));
            else daysByScope.set(row.scope, [toDayMetrics(row)]);
          }
          const cohortsByScope = new Map<string, CohortMetrics[]>();
          for (const row of cohortRows) {
            const list = cohortsByScope.get(row.scope);
            if (list) list.push(toCohortMetrics(row));
            else cohortsByScope.set(row.scope, [toCohortMetrics(row)]);
          }

          const clusters = wanted.map((scope) => {
            const wom = periodWom(daysByScope.get(scope) ?? []);
            const agg = aggregateCohorts(cohortsByScope.get(scope) ?? []);
            return {
              scope,
              key: parseScope(scope).key,
              signups: (daysByScope.get(scope) ?? []).reduce((a, d) => a + d.signups, 0),
              organicSignups: wom.organic,
              seedSignups: wom.seed,
              organicUplift: wom.uplift,
              kWom: wom.kWom,
              kDirect: agg?.kDirect ?? null,
              kTotal:
                agg?.kDirect === undefined || agg?.kDirect === null
                  ? null
                  : round(agg.kDirect + (wom.kWom ?? 0)),
              cohortSize: agg?.cohortSize ?? 0,
              matureCohorts: agg?.matureCohorts ?? 0,
              activations: agg?.activations ?? 0,
              cycleTimeMedianHours: agg?.cycleTimeMedianHours ?? null,
            };
          });

          // Сортировка по объёму, а не по K: кластер из пяти человек с
          // K = 0.4 наверху списка — это приглашение принять шум за победу.
          clusters.sort((a, b) => b.signups - a.signups || a.scope.localeCompare(b.scope));

          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            ...fresh,
            range: { from: toDayKey(range.from), to: toDayKey(range.to) },
            dimension: rawDimension,
            maturityDay,
            clusters,
          };
        },
        { req, res },
      );

      res.json(data);
    } catch (err) {
      console.error("[admin] virality clusters failed:", err);
      res.status(500).json({ error: "Failed to load virality clusters" });
    }
  },
);

// ---------------------------------------------------------------------------
// GET /admin/analytics/virality/anomalies
// ---------------------------------------------------------------------------

/**
 * Статистические аномалии: всплески и провалы неразмеченной органики сверх
 * `?sigma=` (по умолчанию 2σ) и сдвиги времени вирального цикла.
 *
 * Считается по ВСЕМ срезам, а не только по глобальному: аномалия одного города
 * тонет в общем ряду ровно тогда, когда она интереснее всего.
 */
viralityRouter.get(
  "/admin/analytics/virality/anomalies",
  async (req: Request, res: Response) => {
    const range = parseRange(req);
    if ("error" in range) return badRequest(res, range.error);

    const rawSigma = req.query["sigma"];
    const sigma = rawSigma === undefined ? ANOMALY_SIGMA : Number(rawSigma);
    if (!Number.isFinite(sigma) || sigma <= 0 || sigma > 10) {
      return badRequest(res, "sigma must be a number in (0, 10]");
    }

    const scopeFilter = req.query["scope"] === undefined ? null : parseScopeParam(req);

    try {
      const key =
        `virality_anomalies:v1:${toDayKey(range.from)}:${toDayKey(range.to)}` +
        `:${sigma}:${scopeFilter ?? "all"}`;
      const data = await getOrCompute(
        key,
        CACHE_TTL_SECONDS,
        async () => {
          const [dayRows, cohortRows, fresh] = await Promise.all([
            readViralityDays(range.from, range.to, scopeFilter ?? undefined),
            readViralityCohorts(range.from, range.to, {
              ...(scopeFilter ? { scope: scopeFilter } : {}),
              maturityDay: 7,
            }),
            freshness(),
          ]);

          const daysByScope = new Map<string, DayMetrics[]>();
          for (const row of dayRows) {
            const list = daysByScope.get(row.scope);
            if (list) list.push(toDayMetrics(row));
            else daysByScope.set(row.scope, [toDayMetrics(row)]);
          }
          const cohortsByScope = new Map<string, CohortMetrics[]>();
          for (const row of cohortRows) {
            const list = cohortsByScope.get(row.scope);
            if (list) list.push(toCohortMetrics(row));
            else cohortsByScope.set(row.scope, [toCohortMetrics(row)]);
          }

          const anomalies: Anomaly[] = [];
          for (const [scope, series] of daysByScope) {
            anomalies.push(...detectOrganicAnomalies(series, scope, sigma));
          }
          for (const [scope, cohorts] of cohortsByScope) {
            anomalies.push(...detectCycleTimeAnomalies(cohorts, scope, sigma));
          }

          // Сильнейшее — первым: агент читает список сверху и обязан увидеть
          // самое крупное отклонение, а не самое свежее.
          anomalies.sort((a, b) => Math.abs(b.zScore) - Math.abs(a.zScore));

          return {
            generatedAt: new Date().toISOString(),
            timezone: "UTC",
            ...fresh,
            range: { from: toDayKey(range.from), to: toDayKey(range.to) },
            sigma,
            scope: scopeFilter,
            // Порог 2σ по определению срабатывает примерно на 5% точек ровного
            // ряда. Число проверенных точек возвращается, чтобы читатель мог
            // сам увидеть, отличается ли улов от случайного.
            pointsChecked: dayRows.length,
            count: anomalies.length,
            anomalies,
          };
        },
        { req, res },
      );

      res.json(data);
    } catch (err) {
      console.error("[admin] virality anomalies failed:", err);
      res.status(500).json({ error: "Failed to load virality anomalies" });
    }
  },
);
