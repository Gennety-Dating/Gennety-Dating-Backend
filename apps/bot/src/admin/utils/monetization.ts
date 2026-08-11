/**
 * «Процент платящих» — чистая агрегация, без Prisma и без часов.
 *
 * Зачем. В продукте уже есть леджер платежей (`GET /admin/purchases`) и
 * спенд на карточке юзера, но это СПИСОК ТРАНЗАКЦИЙ: он не знает знаменателя
 * и не может ответить «три платящих — это из десяти или из тысячи». Здесь
 * живёт та часть, которая знает знаменатель.
 *
 * Модуль намеренно отделён от загрузки (как `user-health.ts` от
 * `user-health-source.ts`, а `growth.ts` от своего маршрута): каждое правило
 * ниже проверяется юнит-тестом без базы, а маршрут отвечает только за то,
 * чтобы подать сюда снимок.
 *
 * ── Что здесь решено, и почему это важнее самой арифметики ────────────────
 *
 * 1. ТЕСТОВЫЕ АККАУНТЫ ВНЕ ДРОБИ ЦЕЛИКОМ — и из числителя, и из знаменателя,
 *    и из выручки. На момент написания в проде 50 аккаунтов, из них 31
 *    тестовый/синтетический: `0/50` и `0/19` — разные метрики, и первая
 *    врёт. То же правило уже действует в `computeFunnel`; вердикт берётся
 *    оттуда же (`user-health.ts`), а не выводится здесь заново.
 *
 * 2. ПЛАТЯЩИЙ — тот, у кого есть хотя бы одна покупка, которая НЕ возвращена.
 *    `refund_failed` считается: возврат был должен и не прошёл, деньги всё
 *    ещё у нас — ровно это и делает статус ops-тревогой (см.
 *    `summarizePurchases`). Тот, у кого ВСЕ покупки вернулись, не платящий,
 *    но и не ноль — он отдельным числом `refundedOnlyPayers`.
 *
 * 3. БЕСПЛАТНОЕ — НЕ ПОКУПКА. Приветственный билет, студенческий бонус,
 *    реферальные и промо-награды деньгами не являются. Ничего доопределять
 *    не нужно: отбор живёт в `services/purchases.ts` (`isPaidTicketRow` /
 *    `isPaidSubscriptionRow`), и сюда доезжают уже только платные строки.
 *
 * 4. ТРИ ЗНАМЕНАТЕЛЯ, А НЕ ОДИН (решение фаундера). Они отвечают на разные
 *    вопросы и ни один не заменяет остальные: от всех регистраций — «сколько
 *    из привлечённых заплатили»; от активированных — то же без утечки
 *    онбординга; от дошедших до платного экрана — истинная конверсия
 *    paywall'а. Головная цифра — первая.
 *
 * 5. ВЫРУЧКА ЗА ОКНО СЧИТАЕТСЯ ПО ОКНУ, А НЕ ПО ПОСЛЕДНЕЙ ОПЛАТЕ. Сумма за
 *    неделю приходит отдельным индексом, отфильтрованным по датам в SQL.
 *    Соблазнительная короткая дорога — «взять пожизненный спенд тех, кто
 *    платил на этой неделе» — сваливает весь исторический спенд повторного
 *    покупателя в ту неделю, когда он купил во второй раз.
 */

import { normalizeChannel } from "./growth.js";
import { pct } from "./user-health.js";
import { percentile } from "./buckets.js";
import { PURCHASE_KINDS } from "../../services/purchases.js";
import type { PayerIndexEntry, PurchaseKind } from "../../services/purchases.js";

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

/**
 * Через сколько дней после регистрации когорта считается «успевшей» решить,
 * платить или нет. Плоское число: реальной кривой конверсии пока нет — при
 * нуле покупок её не из чего построить, — так что это осознанная заглушка,
 * которую надо пересмотреть, когда данные появятся.
 */
export const COHORT_MATURITY_DAYS = 14;

// ---------------------------------------------------------------------------
// Вход
// ---------------------------------------------------------------------------
export interface MonetizationUserInput {
  id: string;
  /**
   * Вердикт классификатора здоровья, а не догадка по имени/статусу. Считается
   * на сервере в одном месте; своя копия правил разошлась бы.
   */
  isTest: boolean;
  gender: string | null;
  registrationTrack: string | null;
  referralSource: string | null;
  cityKey: string | null;
  createdAt: Date;
  status: string;
  verificationStatus: string;
}

/** userId → агрегат его покупок (`services/purchases.ts` → `loadPayerIndex`). */
export type PayerMap = ReadonlyMap<string, PayerIndexEntry>;

export interface MonetizationInput {
  users: readonly MonetizationUserInput[];
  /** За всё время. */
  payers: PayerMap;
  /** Только покупки за последние 7 дней — для честной недельной выручки. */
  payersThisWeek: PayerMap;
  /** Только покупки предыдущих 7 дней. */
  payersLastWeek: PayerMap;
  /**
   * Кому продукт РЕАЛЬНО показал платный экран. Сегодня это ровно один
   * случай — гейт Date Ticket (§3.5b), единственное место, где продукт
   * блокирует шаг до оплаты. Магазин, Premium, Rematch и смена места —
   * опциональные входы: «экспозицию» по ним честно измерить нечем, и
   * притворяться, что можно, хуже, чем не считать вовсе.
   */
  paywallReached: ReadonlySet<string>;
  now: Date;
  /** Индекс покупок обрезан по потолку — цифры частичные. */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// Выход
// ---------------------------------------------------------------------------
/** Одна конверсия: платящие / база. `pct` = null при нулевой базе. */
export interface ConversionSlice {
  payers: number;
  base: number;
  pct: number | null;
}

export interface MonetizationRevenue {
  allTimeUsdCents: number;
  thisWeekUsdCents: number;
  lastWeekUsdCents: number;
  /** Рост неделя-к-неделе, %. null при нулевой прошлой неделе. */
  growthPct: number | null;
  stars: number;
  /** Выручка на реального пользователя. */
  arpuUsdCents: number | null;
  /** Выручка на платящего. */
  arppuUsdCents: number | null;
  /** Средний чек. */
  avgOrderUsdCents: number | null;
  /**
   * Деньги, которые прошли по тестовым аккаунтам и в цифры выше НЕ вошли.
   * Отдаётся отдельно, потому что леджер `/admin/purchases` показывает их
   * (он леджер, он показывает всё), и без этого поля расхождение между двумя
   * экранами читалось бы как баг.
   */
  excludedTestUsdCents: number;
  /**
   * Всегда true: у Telegram Stars нет публичного курса, доллары считаются по
   * задокументированной константе `STAR_USD_CENTS`. App Store отдаёт реальную
   * цену Apple. Флаг здесь, чтобы фронт был обязан пометить это на экране.
   */
  usdIsEstimate: true;
}

export interface MonetizationKindRow {
  kind: PurchaseKind;
  /** Уникальные плательщики, а не строки. */
  payers: number;
  purchases: number;
  usdCents: number;
}

export interface MonetizationCohortRow {
  /** ISO-дата понедельника недели регистрации. */
  weekStart: string;
  size: number;
  payers: number;
  payingRatePct: number | null;
  /**
   * Когорта ещё не успела сконвертироваться (моложе `cohortMaturityDays`).
   * Её низкий процент — это не результат, а отсутствие результата; помечаем,
   * а не молчим.
   */
  censored: boolean;
}

export interface MonetizationSegmentRow {
  key: string;
  users: number;
  payers: number;
  payingRatePct: number | null;
  usdCents: number;
}

export interface MonetizationSegments {
  byChannel: MonetizationSegmentRow[];
  byGender: MonetizationSegmentRow[];
  byCity: MonetizationSegmentRow[];
  byTrack: MonetizationSegmentRow[];
}

export interface MonetizationSummary {
  headline: {
    payers: number;
    /** Знаменатель головной цифры: все реальные регистрации. */
    registeredReal: number;
    payingRatePct: number | null;
    ofRegistered: ConversionSlice;
    ofActivated: ConversionSlice;
    ofPaywallReached: ConversionSlice;
    newPayersThisWeek: number;
    newPayersLastWeek: number;
  };
  revenue: MonetizationRevenue;
  byKind: MonetizationKindRow[];
  cohorts: MonetizationCohortRow[];
  segments: MonetizationSegments;
  repeat: {
    oncePayers: number;
    repeatPayers: number;
    repeatRatePct: number | null;
    purchasesPerPayer: number | null;
  };
  timing: {
    medianDaysToFirstPayment: number | null;
    p90DaysToFirstPayment: number | null;
  };
  /** Заплатили и всё вернули: не платящие, но и не ничто. */
  refundedOnlyPayers: number;
  /** Сколько тестовых аккаунтов выброшено из всех цифр выше. */
  excludedTestUsers: number;
  /** Порог зрелости когорты, в днях — фронт читает отсюда, а не зашивает. */
  cohortMaturityDays: number;
  /** Индекс покупок был обрезан по потолку. */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Помощники
// ---------------------------------------------------------------------------
/** Понедельник недели, в UTC. Ключ когорты. */
export function weekStartOf(date: Date): string {
  const d = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  // getUTCDay(): 0 = воскресенье. Сдвигаем так, чтобы неделя начиналась с пн.
  const shift = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - shift);
  return d.toISOString().slice(0, 10);
}

/** Целое число центов — чтобы копейки не расползались после делений. */
function divCents(total: number, count: number): number | null {
  if (count <= 0) return null;
  return Math.round(total / count);
}

/** Сумма выручки по окну, только по перечисленным (реальным) пользователям. */
function revenueOver(payers: PayerMap, realIds: ReadonlySet<string>): number {
  let total = 0;
  for (const [userId, entry] of payers) {
    if (!realIds.has(userId)) continue;
    total += entry.usdCents;
  }
  return total;
}

interface Bucket {
  users: number;
  payers: number;
  usdCents: number;
}

function addToBucket(
  buckets: Map<string, Bucket>,
  key: string,
  paid: boolean,
  usdCents: number,
): void {
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { users: 0, payers: 0, usdCents: 0 };
    buckets.set(key, bucket);
  }
  bucket.users += 1;
  if (paid) {
    bucket.payers += 1;
    bucket.usdCents += usdCents;
  }
}

function bucketRows(buckets: Map<string, Bucket>): MonetizationSegmentRow[] {
  return [...buckets.entries()]
    .map(([key, b]) => ({
      key,
      users: b.users,
      payers: b.payers,
      payingRatePct: pct(b.payers, b.users),
      usdCents: b.usdCents,
    }))
    // Сначала по числу платящих, потом по размеру: разрез читают ради вопроса
    // «откуда деньги», а не «где больше народу».
    .sort((a, b) => b.payers - a.payers || b.users - a.users);
}

const round1 = (v: number | null): number | null => (v == null ? null : +v.toFixed(1));

// ---------------------------------------------------------------------------
// Агрегатор
// ---------------------------------------------------------------------------
export function computeMonetization(input: MonetizationInput): MonetizationSummary {
  const { users, payers, payersThisWeek, payersLastWeek, paywallReached, now } = input;
  const nowMs = now.getTime();
  const weekAgo = nowMs - WEEK_MS;
  const twoWeeksAgo = nowMs - 2 * WEEK_MS;

  const real = users.filter((u) => !u.isTest);
  const realIds = new Set(real.map((u) => u.id));
  const excludedTestUsers = users.length - real.length;

  // Деньги тестовых аккаунтов: не выручка, но и не невидимка.
  let excludedTestUsdCents = 0;
  for (const [userId, entry] of payers) {
    if (realIds.has(userId)) continue;
    excludedTestUsdCents += entry.usdCents;
  }

  const byChannel = new Map<string, Bucket>();
  const byGender = new Map<string, Bucket>();
  const byCity = new Map<string, Bucket>();
  const byTrack = new Map<string, Bucket>();
  const cohorts = new Map<string, { size: number; payers: number; newestMs: number }>();

  const kindPayers = new Map<PurchaseKind, number>();
  const kindPurchases = new Map<PurchaseKind, number>();
  const kindUsd = new Map<PurchaseKind, number>();
  const daysToFirst: number[] = [];

  let payerCount = 0;
  let refundedOnlyPayers = 0;
  let activatedBase = 0;
  let activatedPayers = 0;
  let paywallBase = 0;
  let paywallPayers = 0;
  let allTimeUsdCents = 0;
  let stars = 0;
  let purchases = 0;
  let oncePayers = 0;
  let repeatPayers = 0;
  let newPayersThisWeek = 0;
  let newPayersLastWeek = 0;

  for (const u of real) {
    const entry = payers.get(u.id);
    // Возврат всего купленного не делает платящим: выручки от этого человека
    // нет. Но и в «никогда не платил» его сваливать нельзя — он пробовал.
    const paid = entry != null && entry.purchases > 0;
    const usd = paid ? entry.usdCents : 0;

    if (entry?.refundedOnly) refundedOnlyPayers += 1;

    if (paid) {
      payerCount += 1;
      allTimeUsdCents += entry.usdCents;
      stars += entry.stars;
      purchases += entry.purchases;
      if (entry.purchases > 1) repeatPayers += 1;
      else oncePayers += 1;

      for (const kind of PURCHASE_KINDS) {
        const totals = entry.byKind[kind];
        if (totals.purchases === 0) continue;
        kindPayers.set(kind, (kindPayers.get(kind) ?? 0) + 1);
        kindPurchases.set(kind, (kindPurchases.get(kind) ?? 0) + totals.purchases);
        kindUsd.set(kind, (kindUsd.get(kind) ?? 0) + totals.usdCents);
      }

      if (entry.firstPaidAt) {
        const firstMs = entry.firstPaidAt.getTime();
        // «Новый платящий» — про ПЕРВУЮ оплату, поэтому берётся из
        // пожизненного индекса, а не из недельного: в недельный попадёт и
        // повторная покупка старого клиента.
        if (firstMs >= weekAgo) newPayersThisWeek += 1;
        else if (firstMs >= twoWeeksAgo) newPayersLastWeek += 1;
        daysToFirst.push((firstMs - u.createdAt.getTime()) / DAY_MS);
      }
    }

    // Знаменатель №2: дошли до рабочего состояния. Тот же тест, что в
    // `computeFunnel` — active И verified, а не одно из двух.
    if (u.status === "active" && u.verificationStatus === "verified") {
      activatedBase += 1;
      if (paid) activatedPayers += 1;
    }

    // Знаменатель №3: продукт реально попросил денег.
    if (paywallReached.has(u.id)) {
      paywallBase += 1;
      if (paid) paywallPayers += 1;
    }

    addToBucket(byChannel, normalizeChannel(u.referralSource), paid, usd);
    addToBucket(byGender, u.gender ?? "unknown", paid, usd);
    addToBucket(byCity, u.cityKey ?? "unknown", paid, usd);
    addToBucket(byTrack, u.registrationTrack ?? "legacy", paid, usd);

    const week = weekStartOf(u.createdAt);
    let cohort = cohorts.get(week);
    if (!cohort) {
      cohort = { size: 0, payers: 0, newestMs: 0 };
      cohorts.set(week, cohort);
    }
    cohort.size += 1;
    if (paid) cohort.payers += 1;
    cohort.newestMs = Math.max(cohort.newestMs, u.createdAt.getTime());
  }

  const thisWeekUsdCents = revenueOver(payersThisWeek, realIds);
  const lastWeekUsdCents = revenueOver(payersLastWeek, realIds);
  const sortedDays = [...daysToFirst].sort((a, b) => a - b);

  return {
    headline: {
      payers: payerCount,
      registeredReal: real.length,
      payingRatePct: pct(payerCount, real.length),
      ofRegistered: {
        payers: payerCount,
        base: real.length,
        pct: pct(payerCount, real.length),
      },
      ofActivated: {
        payers: activatedPayers,
        base: activatedBase,
        pct: pct(activatedPayers, activatedBase),
      },
      ofPaywallReached: {
        payers: paywallPayers,
        base: paywallBase,
        pct: pct(paywallPayers, paywallBase),
      },
      newPayersThisWeek,
      newPayersLastWeek,
    },
    revenue: {
      allTimeUsdCents,
      thisWeekUsdCents,
      lastWeekUsdCents,
      growthPct:
        lastWeekUsdCents > 0
          ? +(((thisWeekUsdCents - lastWeekUsdCents) / lastWeekUsdCents) * 100).toFixed(1)
          : null,
      stars,
      arpuUsdCents: divCents(allTimeUsdCents, real.length),
      arppuUsdCents: divCents(allTimeUsdCents, payerCount),
      avgOrderUsdCents: divCents(allTimeUsdCents, purchases),
      excludedTestUsdCents,
      usdIsEstimate: true,
    },
    byKind: PURCHASE_KINDS.map((kind) => ({
      kind,
      payers: kindPayers.get(kind) ?? 0,
      purchases: kindPurchases.get(kind) ?? 0,
      usdCents: kindUsd.get(kind) ?? 0,
    })).filter((row) => row.payers > 0),
    cohorts: [...cohorts.entries()]
      .map(([weekStart, c]) => ({
        weekStart,
        size: c.size,
        payers: c.payers,
        payingRatePct: pct(c.payers, c.size),
        censored: nowMs - c.newestMs < COHORT_MATURITY_DAYS * DAY_MS,
      }))
      .sort((a, b) => b.weekStart.localeCompare(a.weekStart)),
    segments: {
      byChannel: bucketRows(byChannel),
      byGender: bucketRows(byGender),
      byCity: bucketRows(byCity),
      byTrack: bucketRows(byTrack),
    },
    repeat: {
      oncePayers,
      repeatPayers,
      repeatRatePct: pct(repeatPayers, payerCount),
      purchasesPerPayer: payerCount > 0 ? +(purchases / payerCount).toFixed(2) : null,
    },
    timing: {
      medianDaysToFirstPayment: round1(percentile(sortedDays, 0.5)),
      p90DaysToFirstPayment: round1(percentile(sortedDays, 0.9)),
    },
    refundedOnlyPayers,
    excludedTestUsers,
    cohortMaturityDays: COHORT_MATURITY_DAYS,
    truncated: input.truncated ?? false,
  };
}
