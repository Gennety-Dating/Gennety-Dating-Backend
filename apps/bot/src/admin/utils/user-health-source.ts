/**
 * Загрузка данных для классификатора здоровья базы (`user-health.ts`).
 *
 * Всё только на чтение. Модуль отделён от правил намеренно: правила должны
 * проверяться юнит-тестами без базы, а здесь живёт всё, что знает про Prisma.
 */
import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import {
  HEALTH_CONFIG,
  classifyUser,
  computeRegistrationBursts,
  median,
  type ClassifiedUser,
  type HealthConfig,
  type HealthUserInput,
} from "./user-health.js";

/**
 * Конфиг с подмешанным списком тестовых аккаунтов из окружения.
 *
 * Список живёт в env, а не в коде: он у каждого свой (аккаунт фаундера, QA,
 * демо), и добавление нового тестового аккаунта не должно быть деплоем.
 * Считается один раз при загрузке модуля — env за время процесса не меняется.
 */
const TEST_IDS = (env.ADMIN_TEST_TELEGRAM_IDS ?? "").split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export function effectiveHealthConfig(base: HealthConfig = HEALTH_CONFIG): HealthConfig {
  return TEST_IDS.length > 0 ? { ...base, test_telegram_ids: TEST_IDS } : base;
}

/** Поля, которых хватает на все правила. Эмбеддинг и переписку не трогаем. */
const HEALTH_USER_SELECT = {
  id: true,
  telegramId: true,
  firstName: true,
  email: true,
  status: true,
  onboardingStep: true,
  verificationStatus: true,
  faceMatchScore: true,
  faceMatchedAt: true,
  createdAt: true,
  lastMessageAt: true,
  syntheticAt: true,
  profile: { select: { photos: true } },
} as const;

type HealthUserRow = {
  id: string;
  telegramId: bigint;
  firstName: string | null;
  email: string | null;
  status: string;
  onboardingStep: string;
  verificationStatus: string;
  faceMatchScore: number | null;
  faceMatchedAt: Date | null;
  createdAt: Date;
  syntheticAt: Date | null;
  lastMessageAt: Date | null;
  profile: { photos: string[] } | null;
};

/**
 * Входящие сообщения по пользователям.
 *
 * `chat_events` — сравнительно новая таблица, поэтому чтение защищено ровно
 * как в `dialogs.ts`: база без неё деградирует к нулям, а не роняет весь
 * админский эндпоинт.
 */
async function countInboundByUser(): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const groups = await prisma.chatEvent.groupBy({
      by: ["userId"],
      where: { direction: "in" },
      _count: { _all: true },
    });
    for (const g of groups) out.set(g.userId, g._count._all);
  } catch (err) {
    console.warn(
      "[admin] user-health: chat_events unavailable, inbound counts read as 0:",
      err instanceof Error ? err.message.split("\n")[0] : err,
    );
  }
  return out;
}

/**
 * Медиана «бот написал → юзер ответил» в секундах.
 *
 * Каждое входящее событие сопоставляется с ближайшим предыдущим исходящим;
 * подряд идущие сообщения юзера дают один замер, а не N.
 */
async function medianResponseSeconds(
  userIds: readonly string[],
): Promise<Map<string, { medianSec: number | null; samples: number }>> {
  const out = new Map<string, { medianSec: number | null; samples: number }>();
  if (userIds.length === 0) return out;

  let rows: Array<{ userId: string; direction: string; createdAt: Date }> = [];
  try {
    rows = await prisma.chatEvent.findMany({
      where: { userId: { in: [...userIds] } },
      select: { userId: true, direction: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
  } catch (err) {
    console.warn(
      "[admin] user-health: chat_events unavailable, reply timing skipped:",
      err instanceof Error ? err.message.split("\n")[0] : err,
    );
    return out;
  }

  const byUser = new Map<string, Array<{ direction: string; createdAt: Date }>>();
  for (const r of rows) {
    let list = byUser.get(r.userId);
    if (!list) {
      list = [];
      byUser.set(r.userId, list);
    }
    list.push({ direction: r.direction, createdAt: r.createdAt });
  }

  for (const [userId, events] of byUser) {
    const gaps: number[] = [];
    let lastOutAt: Date | null = null;
    for (const e of events) {
      if (e.direction === "out") {
        lastOutAt = e.createdAt;
        continue;
      }
      if (lastOutAt) {
        gaps.push((e.createdAt.getTime() - lastOutAt.getTime()) / 1000);
        // Съедаем исходящее: следующая реплика юзера подряд — не «ответ».
        lastOutAt = null;
      }
    }
    out.set(userId, { medianSec: median(gaps), samples: gaps.length });
  }

  return out;
}

function toInput(
  row: HealthUserRow,
  inbound: number,
  timing: { medianSec: number | null; samples: number } | undefined,
  burstSize: number,
): HealthUserInput {
  return {
    id: row.id,
    telegramId: row.telegramId.toString(),
    firstName: row.firstName,
    email: row.email,
    status: row.status,
    onboardingStep: row.onboardingStep,
    verificationStatus: row.verificationStatus,
    faceMatchScore: row.faceMatchScore,
    faceMatchedAt: row.faceMatchedAt,
    createdAt: row.createdAt,
    lastMessageAt: row.lastMessageAt,
    photoCount: row.profile?.photos.length ?? 0,
    messageCountIn: inbound,
    medianResponseSec: timing?.medianSec ?? null,
    responseSamples: timing?.samples ?? 0,
    registrationBurstSize: burstSize,
    syntheticAt: row.syntheticAt,
  };
}

/**
 * Классификация всей базы (с потолком `max_scan_users`).
 *
 * Сначала считаем входящие по всем, тайминг ответов — только для тех, у кого
 * сообщений достаточно, чтобы правило вообще могло сработать: тянуть события
 * по всей базе ради медианы не нужно.
 */
export async function classifyAllUsers(
  now: Date = new Date(),
  cfg: HealthConfig = effectiveHealthConfig(),
): Promise<{ users: ClassifiedUser[]; scanned: number; truncated: boolean }> {
  const [rows, total, inbound] = await Promise.all([
    prisma.user.findMany({
      take: cfg.max_scan_users,
      orderBy: { createdAt: "desc" },
      select: HEALTH_USER_SELECT,
    }) as unknown as Promise<HealthUserRow[]>,
    prisma.user.count(),
    countInboundByUser(),
  ]);

  const candidates = rows
    .filter((r) => (inbound.get(r.id) ?? 0) >= cfg.suspicious_min_messages)
    .map((r) => r.id);
  const timing = await medianResponseSeconds(candidates);
  const bursts = computeRegistrationBursts(rows, cfg);

  const users = rows.map((row) => {
    const input = toInput(
      row,
      inbound.get(row.id) ?? 0,
      timing.get(row.id),
      bursts.get(row.id) ?? 1,
    );
    return { ...input, verdict: classifyUser(input, now, cfg) };
  });

  return { users, scanned: rows.length, truncated: total > rows.length };
}

/**
 * Классификация одного аккаунта — для `GET /admin/users/:id/health`.
 *
 * Всплеск регистраций считается запросом по окну вокруг его `createdAt`, а не
 * сканом всей базы: правило смотрит только на соседей по времени.
 */
export async function classifyOneUser(
  userId: string,
  now: Date = new Date(),
  cfg: HealthConfig = effectiveHealthConfig(),
): Promise<{ input: HealthUserInput; verdict: ClassifiedUser["verdict"] } | null> {
  const row = (await prisma.user.findUnique({
    where: { id: userId },
    select: HEALTH_USER_SELECT,
  })) as HealthUserRow | null;
  if (!row) return null;

  const windowMs = cfg.bot_batch_window_min * 60 * 1000;
  const [inboundCount, timing, burstSize] = await Promise.all([
    countInboundForUser(userId),
    medianResponseSeconds([userId]),
    prisma.user.count({
      where: {
        createdAt: {
          gte: new Date(row.createdAt.getTime() - windowMs),
          lte: new Date(row.createdAt.getTime() + windowMs),
        },
      },
    }),
  ]);

  const input = toInput(row, inboundCount, timing.get(userId), burstSize);
  return { input, verdict: classifyUser(input, now, cfg) };
}

async function countInboundForUser(userId: string): Promise<number> {
  try {
    return await prisma.chatEvent.count({ where: { userId, direction: "in" } });
  } catch {
    return 0;
  }
}
