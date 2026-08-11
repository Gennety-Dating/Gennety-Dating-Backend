/**
 * Загрузка снимка для «процента платящих» (`monetization.ts`).
 *
 * Всё только на чтение. Модуль отделён от правил ровно по той же причине, что
 * `user-health-source.ts` от `user-health.ts`: арифметика конверсии должна
 * проверяться юнит-тестами без базы, а здесь живёт всё, что знает про Prisma.
 *
 * Один вход (`loadMonetizationSummary`) намеренно обслуживает ДВЕ поверхности —
 * полную вкладку `/admin/analytics/monetization` и компактный блок в
 * `founder-digest`, который читает Hermes. Иначе две реализации одной метрики
 * рано или поздно разойдутся, и фаундер увидит на дашборде одно число, а в
 * недельном отчёте другое.
 */
import { prisma } from "@gennety/db";
import { loadPayerIndex } from "../../services/purchases.js";
import { classifyAllUsers } from "./user-health-source.js";
import {
  computeMonetization,
  type MonetizationSummary,
  type MonetizationUserInput,
} from "./monetization.js";

const WEEK_MS = 7 * 86_400_000;

/**
 * Кому продукт реально показал платный экран.
 *
 * Единственный принудительный paywall в продукте — гейт Date Ticket (§3.5b):
 * после взаимного accept пара не получает Календарь, пока оба билета не
 * оплачены. Всё остальное (магазин билетов, Premium, Rematch, смена места) —
 * опциональные входы, и «сколько человек их увидело» измерить нечем.
 *
 * Историческая метка — объединение двух условий, и оба нужны:
 *   • `ticketExpiresAt IS NOT NULL` — гейт открыт прямо сейчас;
 *   • `ticketStatus <> 'pending'`   — гейт отработал и разрешился.
 * Одного `ticketStatus` не хватает, потому что `pending` — это ДЕФОЛТ на
 * каждой строке таблицы, включая матчи, созданные до появления фичи; ровно
 * это уже объяснено в `public/ticket-gate-state.ts`. А одного
 * `ticketExpiresAt` не хватает, потому что и завершение, и истечение его
 * обнуляют.
 */
async function loadPaywallReached(): Promise<Set<string>> {
  const rows = await prisma.match.findMany({
    where: {
      OR: [{ ticketExpiresAt: { not: null } }, { NOT: { ticketStatus: "pending" } }],
    },
    select: { userAId: true, userBId: true },
  });
  const out = new Set<string>();
  for (const row of rows) {
    out.add(row.userAId);
    out.add(row.userBId);
  }
  return out;
}

export async function loadMonetizationSummary(
  now: Date = new Date(),
): Promise<MonetizationSummary> {
  const weekAgo = new Date(now.getTime() - WEEK_MS);
  const twoWeeksAgo = new Date(now.getTime() - 2 * WEEK_MS);

  const [health, rows, allTime, thisWeek, lastWeek, paywallReached] = await Promise.all([
    // Берётся ТОЛЬКО ради вердикта «тестовый аккаунт». Классификация живёт на
    // сервере в одном месте (`user-health.ts`); вывести «тестовость» здесь
    // заново из статуса/имени — гарантированный расход с воронкой.
    classifyAllUsers(now),
    // Второй скан `users` за запрос: у `classifyAllUsers` фиксированная форма
    // выхода, в ней нет ни канала, ни города, ни трека. Осознанный размен —
    // эндпоинт кэшируется на 15 минут, а альтернатива это копия правил.
    prisma.user.findMany({
      select: {
        id: true,
        gender: true,
        registrationTrack: true,
        referralSource: true,
        createdAt: true,
        status: true,
        verificationStatus: true,
        profile: { select: { homeCityKey: true } },
      },
    }),
    loadPayerIndex(),
    loadPayerIndex({ since: weekAgo }),
    loadPayerIndex({ since: twoWeeksAgo, until: weekAgo }),
    loadPaywallReached(),
  ]);

  const testIds = new Set(
    health.users.filter((u) => u.verdict.classification === "test").map((u) => u.id),
  );

  const users: MonetizationUserInput[] = rows.map((row) => ({
    id: row.id,
    isTest: testIds.has(row.id),
    gender: row.gender,
    registrationTrack: row.registrationTrack,
    referralSource: row.referralSource,
    cityKey: row.profile?.homeCityKey ?? null,
    createdAt: row.createdAt,
    status: row.status,
    verificationStatus: row.verificationStatus,
  }));

  return computeMonetization({
    users,
    payers: allTime.byUser,
    payersThisWeek: thisWeek.byUser,
    payersLastWeek: lastWeek.byUser,
    paywallReached,
    now,
    truncated: allTime.truncated,
  });
}

/**
 * Компактный срез для `founder-digest` — то, что Hermes читает каждую неделю
 * без второго запроса. Собирается из той же сводки, что и полная вкладка,
 * поэтому две поверхности не могут разойтись.
 */
export function digestMonetization(summary: MonetizationSummary): {
  payers: number;
  registeredReal: number;
  payingRatePct: number | null;
  payingRateOfActivatedPct: number | null;
  payingRateOfPaywallReachedPct: number | null;
  newPayersThisWeek: number;
  newPayersLastWeek: number;
  revenueUsdCentsAllTime: number;
  revenueUsdCentsThisWeek: number;
  revenueUsdCentsLastWeek: number;
  revenueGrowthPct: number | null;
  arpuUsdCents: number | null;
  arppuUsdCents: number | null;
  usdIsEstimate: true;
} {
  return {
    payers: summary.headline.payers,
    registeredReal: summary.headline.registeredReal,
    payingRatePct: summary.headline.payingRatePct,
    payingRateOfActivatedPct: summary.headline.ofActivated.pct,
    payingRateOfPaywallReachedPct: summary.headline.ofPaywallReached.pct,
    newPayersThisWeek: summary.headline.newPayersThisWeek,
    newPayersLastWeek: summary.headline.newPayersLastWeek,
    revenueUsdCentsAllTime: summary.revenue.allTimeUsdCents,
    revenueUsdCentsThisWeek: summary.revenue.thisWeekUsdCents,
    revenueUsdCentsLastWeek: summary.revenue.lastWeekUsdCents,
    revenueGrowthPct: summary.revenue.growthPct,
    arpuUsdCents: summary.revenue.arpuUsdCents,
    arppuUsdCents: summary.revenue.arppuUsdCents,
    usdIsEstimate: true,
  };
}
