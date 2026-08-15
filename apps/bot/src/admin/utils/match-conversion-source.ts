/**
 * Загрузка снимка для `match-conversion.ts`.
 *
 * Тот же раскол, что у `user-health.ts` / `user-health-source.ts`: правила —
 * там, Prisma — здесь. Ни одно решение о том, что считать конверсией, в этом
 * файле не принимается.
 *
 * Ничего не денормализуется и не пишется: все шесть событий из ТЗ 1.1
 * выводятся из колонок, которые продукт уже заполняет
 * (решение фаундера — DECISIONS.md 2026-08-15). Практическое следствие, ради
 * которого это и выбрано: метрика работает на ВСЕЙ истории матчей сразу, а не
 * начинается с нуля в день деплоя.
 */

import { prisma } from "@gennety/db";
import type { ClassifiedUser } from "./user-health.js";
import type { ConversionMatchInput } from "./match-conversion.js";

/**
 * Причины леджера, означающие «деньги вернулись по этому матчу».
 *
 * `refund` — возврат билета в кошелёк при смерти живого матча (§3.5b), ключ
 * идемпотентности `refund:match:<id>:<user>:<slot>`. `gate_refunded` — реверс
 * на рельсе гейта. `gate_refund_pending` НЕ считается: там возврат ещё не
 * прошёл, деньги всё ещё у нас — то же правило, по которому `refund_failed`
 * остаётся выручкой в `summarizePurchases`.
 */
const REFUND_REASONS = ["refund", "gate_refunded"] as const;

const MATCH_SELECT = {
  id: true,
  source: true,
  status: true,
  userAId: true,
  userBId: true,
  acceptedByA: true,
  acceptedByB: true,
  ticketStatus: true,
  ticketPaidA: true,
  ticketPaidB: true,
  dateAttendedA: true,
  dateAttendedB: true,
  attendanceOutcomeA: true,
  attendanceOutcomeB: true,
  stallCheckInSentAtA: true,
  stallCheckInSentAtB: true,
  stallConfirmedAtA: true,
  stallConfirmedAtB: true,
  createdAt: true,
} as const;

/** Сколько слотов вернулось по каждому матчу. */
async function loadRefundedSlots(): Promise<Map<string, number>> {
  const rows = await prisma.ticketLedger.groupBy({
    by: ["matchId"],
    where: { matchId: { not: null }, reason: { in: [...REFUND_REASONS] } },
    _count: { _all: true },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    if (r.matchId) out.set(r.matchId, r._count._all);
  }
  return out;
}

/**
 * Снимок матчей для метрики.
 *
 * `classified` приходит от вызывающего, а не загружается здесь: маршруты уже
 * держат результат `classifyAllUsers()` для воронки, и второй скан таблицы
 * пользователей ради того же вердикта был бы чистой платой за дубль.
 */
export async function loadConversionMatches(
  classified: readonly ClassifiedUser[],
): Promise<ConversionMatchInput[]> {
  const testIds = new Set(
    classified.filter((u) => u.verdict.classification === "test").map((u) => u.id),
  );

  const [matches, refunds] = await Promise.all([
    prisma.match.findMany({ select: MATCH_SELECT, orderBy: { createdAt: "desc" } }),
    loadRefundedSlots(),
  ]);

  return matches.map((m) => ({
    id: m.id,
    source: m.source,
    // Пара тестовая, если тестовый ХОТЯ БЫ один участник: конверсия — свойство
    // пары, и матч с одной заглушкой не является наблюдением о реальных людях.
    isTestPair: testIds.has(m.userAId) || testIds.has(m.userBId),
    acceptedByA: m.acceptedByA,
    acceptedByB: m.acceptedByB,
    status: m.status,
    ticketStatus: m.ticketStatus,
    ticketPaidA: m.ticketPaidA,
    ticketPaidB: m.ticketPaidB,
    dateAttendedA: m.dateAttendedA,
    dateAttendedB: m.dateAttendedB,
    attendanceOutcomeA: m.attendanceOutcomeA,
    attendanceOutcomeB: m.attendanceOutcomeB,
    stallCheckInSentAtA: m.stallCheckInSentAtA,
    stallCheckInSentAtB: m.stallCheckInSentAtB,
    stallConfirmedAtA: m.stallConfirmedAtA,
    stallConfirmedAtB: m.stallConfirmedAtB,
    refundedSlots: refunds.get(m.id) ?? 0,
    createdAt: m.createdAt,
  }));
}
