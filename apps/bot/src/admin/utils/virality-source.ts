import { prisma } from "@gennety/db";
import { isWordOfMouthAnswer } from "@gennety/shared";
import { parseReferrer } from "../../services/referral.js";
import { realUserFilter } from "./activity-source.js";
import { normalizeChannel } from "./growth.js";
import type {
  ActivationRow,
  CohortMetrics,
  DayMetrics,
  FunnelEventRow,
  HdyhauRow,
  SignupRow,
} from "./virality.js";

/**
 * Загрузка для виральности. Всё, что знает про prisma, — здесь; определения
 * остаются чистыми в `virality.ts` (тот же раздел, что `activity.ts` /
 * `activity-source.ts`).
 *
 * Кто считается настоящим аккаунтом — берётся из `realUserFilter` соседнего
 * модуля, а не переопределяется здесь. Две трактовки «тестового аккаунта»
 * означали бы K-фактор, у которого числитель и знаменатель описывают разные
 * популяции; на маленькой базе это не погрешность, а другое число.
 */

export interface LoadOptions {
  includeTest?: boolean;
}

/**
 * Регистрации за период — вход и для дневного ряда, и для когорт.
 *
 * `profile.homeCityKey` подтягивается одним джойном: кластерный срез иначе
 * потребовал бы второго прохода по тем же строкам, а разъехавшиеся выборки
 * дают город тем, кого в глобальном ряду уже нет.
 */
export async function loadSignups(
  from: Date,
  to: Date,
  options: LoadOptions = {},
): Promise<SignupRow[]> {
  const rows = await prisma.user.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      ...realUserFilter(options.includeTest),
    },
    select: {
      id: true,
      createdAt: true,
      referralSource: true,
      referralCountedAt: true,
      universityDomain: true,
      profile: { select: { homeCityKey: true } },
    },
  });

  return rows.map((r) => ({
    userId: r.id,
    createdAt: r.createdAt,
    channel: normalizeChannel(r.referralSource),
    referrerId: parseReferrer(r.referralSource),
    activatedAt: r.referralCountedAt,
    cityKey: r.profile?.homeCityKey ?? null,
    universityDomain: r.universityDomain,
  }));
}

/**
 * Активации приглашённых за период, отнесённые к рефереру.
 *
 * Знаменателем когорты служит реферер, а не приглашённый, поэтому фильтр по
 * периоду стоит на `referralCountedAt` (момент активации), а не на дате
 * регистрации: приглашённый мог зарегистрироваться в прошлом месяце и дойти до
 * верификации сегодня, и это активация СЕГОДНЯШНЕГО окна наблюдения.
 */
export async function loadActivations(
  from: Date,
  to: Date,
  options: LoadOptions = {},
): Promise<ActivationRow[]> {
  const rows = await prisma.user.findMany({
    where: {
      referralCountedAt: { gte: from, lte: to },
      ...realUserFilter(options.includeTest),
    },
    select: { referralSource: true, referralCountedAt: true },
  });

  const out: ActivationRow[] = [];
  for (const row of rows) {
    const referrerId = parseReferrer(row.referralSource);
    if (!referrerId || !row.referralCountedAt) continue;
    out.push({ referrerId, activatedAt: row.referralCountedAt });
  }
  return out;
}

/**
 * Воронка шеринга за период.
 *
 * Тестовые аккаунты здесь НЕ фильтруются, и это не упущение: событие попадает в
 * когорту только через `referrerId`, принадлежащий её составу, а состав уже
 * отфильтрован в `loadSignups`. Повторный фильтр по связи стоил бы джойна на
 * каждой строке события ради результата, который и так не может отличаться.
 */
export async function loadFunnelEvents(from: Date, to: Date): Promise<FunnelEventRow[]> {
  const rows = await prisma.referralEvent.findMany({
    where: { occurredAt: { gte: from, lte: to } },
    select: { kind: true, referrerId: true, occurredAt: true },
  });

  return rows.map((r) => ({
    kind: r.kind as FunnelEventRow["kind"],
    referrerId: r.referrerId,
    occurredAt: r.occurredAt,
  }));
}

/** Ответы опроса за период вместе с реальным каналом пришедшего. */
export async function loadHdyhauRows(
  from: Date,
  to: Date,
  options: LoadOptions = {},
): Promise<HdyhauRow[]> {
  const rows = await prisma.hdyhauResponse.findMany({
    where: {
      answeredAt: { gte: from, lte: to },
      user: realUserFilter(options.includeTest),
    },
    select: {
      answer: true,
      answeredAt: true,
      user: { select: { referralSource: true } },
    },
  });

  return rows.map((r) => ({
    answer: r.answer,
    answeredAt: r.answeredAt,
    channel: normalizeChannel(r.user.referralSource),
    wordOfMouth: isWordOfMouthAnswer(r.answer),
  }));
}

// ---------------------------------------------------------------------------
// Запись предагрегата
// ---------------------------------------------------------------------------

/** Дата → полночь UTC, в том виде, в каком её принимает колонка `@db.Date`. */
function dayValue(dayKey: string): Date {
  return new Date(`${dayKey}T00:00:00.000Z`);
}

export interface ScopedDayMetrics extends DayMetrics {
  scope: string;
}

export interface ScopedCohortMetrics extends CohortMetrics {
  scope: string;
}

/**
 * Переписать предагрегат за пересчитанное окно.
 *
 * Удаление + вставка, а не построчный upsert, и это осознанный выбор: за один
 * прогон получается порядка тысяч строк, а `upsert` — это столько же отдельных
 * round-trip'ов. Важнее другое: удаление снимает строки срезов, которые за это
 * окно ПЕРЕСТАЛИ проходить порог кластера, — при upsert они остались бы
 * навсегда, показывая устаревшие числа рядом со свежими.
 *
 * Окно удаления обязано совпадать с окном пересчёта; вызывающий передаёт одни и
 * те же границы, и это единственное место, где их можно перепутать.
 */
export async function replaceViralityDays(
  from: Date,
  to: Date,
  rows: readonly ScopedDayMetrics[],
  computedAt: Date,
): Promise<number> {
  const data = rows.map((r) => ({
    day: dayValue(r.day),
    scope: r.scope,
    signups: r.signups,
    organicSignups: r.organicSignups,
    referralSignups: r.referralSignups,
    seedSignups: r.seedSignups,
    baselineOrganic: r.baselineOrganic,
    baselineStdDev: r.baselineStdDev,
    organicUplift: r.organicUplift,
    kWom: r.kWom,
    womStatus: r.womStatus,
    computedAt,
  }));

  await prisma.$transaction([
    prisma.viralityDay.deleteMany({ where: { day: { gte: from, lte: to } } }),
    prisma.viralityDay.createMany({ data }),
  ]);
  return data.length;
}

export async function replaceViralityCohorts(
  from: Date,
  to: Date,
  rows: readonly ScopedCohortMetrics[],
  computedAt: Date,
): Promise<number> {
  const data = rows.map((r) => ({
    cohortDate: dayValue(r.cohortDate),
    maturityDay: r.maturityDay,
    scope: r.scope,
    cohortSize: r.cohortSize,
    sharers: r.sharers,
    invitesSent: r.invitesSent,
    linkClicks: r.linkClicks,
    activations: r.activations,
    invitesPerUser: r.invitesPerUser,
    clickRate: r.clickRate,
    activationRate: r.activationRate,
    kDirect: r.kDirect,
    cycleTimeMedianHours: r.cycleTimeMedianHours,
    kWom: r.kWom,
    kTotal: r.kTotal,
    mature: r.mature,
    computedAt,
  }));

  await prisma.$transaction([
    prisma.viralityCohort.deleteMany({ where: { cohortDate: { gte: from, lte: to } } }),
    prisma.viralityCohort.createMany({ data }),
  ]);
  return data.length;
}

// ---------------------------------------------------------------------------
// Чтение предагрегата
// ---------------------------------------------------------------------------

export interface StoredDayRow extends ScopedDayMetrics {
  computedAt: Date;
}

export interface StoredCohortRow extends ScopedCohortMetrics {
  computedAt: Date;
}

/**
 * Дневной ряд из предагрегата.
 *
 * Именно ЭТО читают эндпоинты, а не продовые таблицы: смысл фоновой задачи в
 * том, чтобы запрос дашборда или агента не превращался в скан `users` за
 * четыре месяца с джойном на профили.
 */
export async function readViralityDays(
  from: Date,
  to: Date,
  scope?: string,
): Promise<StoredDayRow[]> {
  const rows = await prisma.viralityDay.findMany({
    where: { day: { gte: from, lte: to }, ...(scope ? { scope } : {}) },
    orderBy: [{ scope: "asc" }, { day: "asc" }],
  });

  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    scope: r.scope,
    signups: r.signups,
    organicSignups: r.organicSignups,
    referralSignups: r.referralSignups,
    seedSignups: r.seedSignups,
    baselineOrganic: r.baselineOrganic,
    baselineStdDev: r.baselineStdDev,
    organicUplift: r.organicUplift,
    kWom: r.kWom,
    womStatus: r.womStatus as DayMetrics["womStatus"],
    computedAt: r.computedAt,
  }));
}

export async function readViralityCohorts(
  from: Date,
  to: Date,
  options: { scope?: string; maturityDay?: number } = {},
): Promise<StoredCohortRow[]> {
  const rows = await prisma.viralityCohort.findMany({
    where: {
      cohortDate: { gte: from, lte: to },
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.maturityDay !== undefined ? { maturityDay: options.maturityDay } : {}),
    },
    orderBy: [{ scope: "asc" }, { cohortDate: "asc" }, { maturityDay: "asc" }],
  });

  return rows.map((r) => ({
    cohortDate: r.cohortDate.toISOString().slice(0, 10),
    maturityDay: r.maturityDay,
    scope: r.scope,
    cohortSize: r.cohortSize,
    sharers: r.sharers,
    invitesSent: r.invitesSent,
    linkClicks: r.linkClicks,
    activations: r.activations,
    invitesPerUser: r.invitesPerUser,
    clickRate: r.clickRate,
    activationRate: r.activationRate,
    kDirect: r.kDirect,
    cycleTimeMedianHours: r.cycleTimeMedianHours,
    kWom: r.kWom,
    kTotal: r.kTotal,
    mature: r.mature,
    computedAt: r.computedAt,
  }));
}

/**
 * Когда предагрегат считался в последний раз.
 *
 * Возвращается каждым эндпоинтом рядом с числами: у виральности нет «сейчас»,
 * есть только «на момент прогона», и читатель — особенно агент — обязан видеть
 * этот момент, иначе он объявит вчерашним падением незапустившийся крон.
 */
export async function lastViralityRollupAt(): Promise<Date | null> {
  const row = await prisma.viralityDay.findFirst({
    orderBy: { computedAt: "desc" },
    select: { computedAt: true },
  });
  return row?.computedAt ?? null;
}

/** Какие срезы вообще существуют в предагрегате за период. */
export async function listViralityScopes(from: Date, to: Date): Promise<string[]> {
  const rows = await prisma.viralityDay.findMany({
    where: { day: { gte: from, lte: to } },
    distinct: ["scope"],
    select: { scope: true },
    orderBy: { scope: "asc" },
  });
  return rows.map((r) => r.scope);
}
