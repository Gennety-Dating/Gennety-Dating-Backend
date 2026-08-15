/**
 * «Match → покупка Date Ticket», нетто — чистая агрегация, без Prisma и часов.
 *
 * Ключевая гипотеза бизнеса: сколько подтверждённых матчей доходит до
 * оплаченного свидания. Модуль намеренно отделён от загрузки (как
 * `user-health.ts` от `user-health-source.ts`), чтобы каждое правило ниже
 * проверялось юнит-тестом без базы.
 *
 * ── Четыре решения, которые важнее самой арифметики ──────────────────────
 *
 * 1. СИНТЕТИЧЕСКИЕ МАТЧИ ВНЕ ЗНАМЕНАТЕЛЯ. Синтетический партнёр по построению
 *    ВСЕГДА отказывает (PRODUCT_SPEC §3.1c) — он физически не может купить
 *    билет. На момент написания 11 из 14 матчей в проде синтетические, так что
 *    без этого фильтра конверсия была бы вечным 0% не потому, что продукт не
 *    конвертит, а потому что 79% знаменателя — заглушки. Дискриминатор уже
 *    существует: `Match.source`.
 *
 * 2. ТЕСТОВЫЕ АККАУНТЫ ТОЖЕ, и вердикт берётся из `user-health.ts`, а не
 *    выводится здесь заново. **Правило «telegramId < 0» неверно** и в него
 *    легко провалиться: отрицательный id — это признак МОБИЛЬНОЙ рельсы
 *    (ARCHITECTURE → `users`), поэтому такой фильтр выкинет каждого реального
 *    iOS-пользователя в день выхода приложения.
 *
 * 3. ВЫЧЕТЫ — ОБЪЕДИНЕНИЕ, А НЕ СУММА. Буквальная формула ТЗ
 *    `куплено − (no_show + ghosting + возвраты)` двойно считает: no-show и
 *    гостинг при планировании как раз и ПОРОЖДАЮТ возврат, так что один
 *    испорченный матч вычитался бы дважды, а числитель мог бы уйти в минус.
 *    Каждый матч вычитается один раз; компоненты отдаются отдельно, потому что
 *    UI (ТЗ 1.3) показывает их рядом.
 *
 * 4. ВЫЧИТАТЬ МОЖНО ТОЛЬКО ИЗ ТОГО, ЧТО БЫЛО В ЧИСЛИТЕЛЕ. Матч без оплаченных
 *    билетов, закончившийся гостингом, — это не «минус одна продажа», это
 *    просто не продажа. Поэтому вычеты пересекаются с множеством оплаченных.
 */

import { isNoShow } from "../../services/attendance.js";

/** Что считается оплаченным свиданием — см. `isPaidDate` ниже. */
export const TICKET_STATUS_COMPLETED = "completed";
export const TICKET_STATUS_PARTIAL = "partial";

export interface ConversionMatchInput {
  id: string;
  /** `weekly` | `rematch` | `synthetic`. */
  source: string;
  /** Хотя бы один участник — тестовый или синтетический аккаунт. */
  isTestPair: boolean;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  status: string;
  ticketStatus: string;
  ticketPaidA: Date | null;
  ticketPaidB: Date | null;
  dateAttendedA: boolean | null;
  dateAttendedB: boolean | null;
  attendanceOutcomeA: string | null;
  attendanceOutcomeB: string | null;
  stallCheckInSentAtA: Date | null;
  stallCheckInSentAtB: Date | null;
  stallConfirmedAtA: Date | null;
  stallConfirmedAtB: Date | null;
  /** Сколько слотов по этому матчу вернулось (из `ticket_ledger`). */
  refundedSlots: number;
  createdAt: Date;
}

export interface MatchConversionSummary {
  /** Знаменатель: подтверждённые матчи реальных людей. */
  confirmed: number;
  /** Числитель до вычетов: оба билета оплачены. */
  ticketsPurchased: number;
  /** Один билет из двух — свиданием ещё не стало, показывается отдельно. */
  ticketsPartial: number;
  noShow: number;
  ghostDuringScheduling: number;
  refunded: number;
  /** Объединение трёх выше, пересечённое с оплаченными. Вычитается ОДИН раз. */
  deductions: number;
  /** Нетто-конверсия. `null` = нет данных, никогда не 0. */
  netPct: number | null;
  /** Без вычетов — чтобы видеть, сколько съедают срывы. */
  grossPct: number | null;
  /** Качество планирования (ТЗ 1.3): доля от ПРОДАННЫХ билетов. */
  noShowRateOfPaidPct: number | null;
  ghostRateOfPaidPct: number | null;
  excludedSynthetic: number;
  excludedTest: number;
}

function pct(num: number, den: number): number | null {
  if (den <= 0) return null;
  return +((num / den) * 100).toFixed(1);
}

/** Матч вступил в силу: оба сказали «да». Колонки необратимы. */
export function isConfirmed(m: ConversionMatchInput): boolean {
  return m.acceptedByA === true && m.acceptedByB === true;
}

/**
 * Свидание оплачено.
 *
 * Именно ОБА слота: §3.5b — жёсткий гейт, календарь не открывается, пока не
 * оплачены оба, так что один билет свиданием не становится. `partial`
 * отдаётся отдельным числом, а не приравнивается ни к 0, ни к 1.
 */
export function isPaidDate(m: ConversionMatchInput): boolean {
  return m.ticketStatus === TICKET_STATUS_COMPLETED;
}

/**
 * Гостинг при планировании.
 *
 * §3.5c: цепочка присылает «ты ещё в деле?» и через 48 ч отменяет матч.
 * Сторона, которая не подтвердила, и есть пропавшая. Отмена по другой причине
 * (экстренная, модерация, заморозка) сюда не попадает — там check-in не
 * отправлялся.
 */
export function isGhostDuringScheduling(m: ConversionMatchInput): boolean {
  if (m.status !== "cancelled") return false;
  const ghostedA = m.stallCheckInSentAtA !== null && m.stallConfirmedAtA === null;
  const ghostedB = m.stallCheckInSentAtB !== null && m.stallConfirmedAtB === null;
  return ghostedA || ghostedB;
}

/**
 * Почему вернулись деньги — выводится из терминального состояния матча.
 *
 * Причина нигде не хранится: §3.5b возвращает билет на ШЕСТИ путях (заморозка,
 * удаление, модерация, экстренная отмена, оба финала stall-цепочки), а в
 * леджере лежит только `reason: 'refund'` и синтетический ключ идемпотентности.
 * Поэтому словарь здесь описывает реальные пути, а не два значения из ТЗ.
 */
export type RefundReason =
  | "no_show"
  | "ghost_during_scheduling"
  | "cancelled_before_date"
  | "unknown";

export function refundReasonFor(m: ConversionMatchInput): RefundReason | null {
  if (m.refundedSlots <= 0) return null;
  if (isNoShow(m) === true) return "no_show";
  if (isGhostDuringScheduling(m)) return "ghost_during_scheduling";
  if (m.status === "cancelled") return "cancelled_before_date";
  return "unknown";
}

/**
 * Сводка по набору матчей.
 *
 * Вход — снимок; фильтрация по окну делается вызывающим, чтобы «за неделю» и
 * «за всё время» считались одной функцией.
 */
export function computeMatchConversion(
  matches: readonly ConversionMatchInput[],
): MatchConversionSummary {
  let excludedSynthetic = 0;
  let excludedTest = 0;
  const eligible: ConversionMatchInput[] = [];

  for (const m of matches) {
    if (m.source === "synthetic") {
      excludedSynthetic++;
      continue;
    }
    if (m.isTestPair) {
      excludedTest++;
      continue;
    }
    if (isConfirmed(m)) eligible.push(m);
  }

  const confirmed = eligible.length;
  const paid = eligible.filter(isPaidDate);
  const ticketsPurchased = paid.length;
  const ticketsPartial = eligible.filter(
    (m) => m.ticketStatus === TICKET_STATUS_PARTIAL,
  ).length;

  // Компоненты считаются по ВСЕМ подтверждённым — они интересны сами по себе,
  // даже когда билетов не было (например, пока монетизация выключена).
  const noShow = eligible.filter((m) => isNoShow(m) === true).length;
  const ghostDuringScheduling = eligible.filter(isGhostDuringScheduling).length;
  const refunded = eligible.filter((m) => m.refundedSlots > 0).length;

  // Вычет — объединение, пересечённое с оплаченными: из числителя нельзя
  // вычесть то, чего в нём не было.
  const deductions = paid.filter(
    (m) => isNoShow(m) === true || isGhostDuringScheduling(m) || m.refundedSlots > 0,
  ).length;

  return {
    confirmed,
    ticketsPurchased,
    ticketsPartial,
    noShow,
    ghostDuringScheduling,
    refunded,
    deductions,
    netPct: pct(ticketsPurchased - deductions, confirmed),
    grossPct: pct(ticketsPurchased, confirmed),
    noShowRateOfPaidPct: pct(
      paid.filter((m) => isNoShow(m) === true).length,
      ticketsPurchased,
    ),
    ghostRateOfPaidPct: pct(
      paid.filter(isGhostDuringScheduling).length,
      ticketsPurchased,
    ),
    excludedSynthetic,
    excludedTest,
  };
}

/**
 * Оплаченные свидания за окно (North Star).
 *
 * Считается по МАТЧАМ, а не по плательщикам: мужчина, оплативший за двоих, —
 * это одно свидание и один плательщик, а не два. И не по
 * `purchaseSummary.count`, который пожизненный и на вопрос «за 7 дней» ответить
 * не может в принципе. Момент оплаты — когда закрылся ВТОРОЙ слот, потому что
 * до этого свидание ещё не оплачено.
 */
export function paidDatesInWindow(
  matches: readonly ConversionMatchInput[],
  since: Date,
  until: Date,
): number {
  return matches.filter((m) => {
    if (m.source === "synthetic" || m.isTestPair) return false;
    if (!isPaidDate(m)) return false;
    if (!m.ticketPaidA || !m.ticketPaidB) return false;
    const settledAt = Math.max(m.ticketPaidA.getTime(), m.ticketPaidB.getTime());
    return settledAt >= since.getTime() && settledAt < until.getTime();
  }).length;
}
