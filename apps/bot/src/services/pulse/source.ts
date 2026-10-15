import { Prisma, prisma } from "@gennety/db";
import { PULSE_ANALYTICS } from "@gennety/shared";
import { realUserFilter } from "../../admin/utils/activity-source.js";
import type { InsightDraft, StuckPerson } from "./detectors.js";
import type {
  ActivityDayRow,
  FunnelMatchRow,
  MetricRow,
  OptInUserRow,
  PulseEventRow,
  SignupRow,
  StepEventRow,
} from "./rollup-math.js";
import type { PulseMetricName } from "./metrics-catalog.js";

/**
 * Everything Pulse reads from or writes to Postgres. The definitions live in
 * `rollup-math.ts` / `detectors.ts` and never touch Prisma; this module never
 * decides what a number means.
 *
 * Who counts: the SAME population every other analytics surface uses —
 * `realUserFilter` (no synthetic accounts, no `ADMIN_TEST_TELEGRAM_IDS`).
 * Client events with no user id (taken before login) are kept, EXCEPT those of
 * an install that ever logged into an excluded account: an install is one
 * phone, and the founder's own pre-login taps are as much a test account as
 * the taps after it.
 *
 * Consent needs no filter here: a user without `analytics_opt_in` never has a
 * `client_events` row written at all (spec §2.4), and withdrawing deletes them.
 */

const DAY_MS = 86_400_000;

/** Ids of synthetic and test accounts — the complement of `realUserFilter`. */
export async function loadExcludedUserIds(): Promise<Set<string>> {
  const real = realUserFilter();
  const or: Prisma.UserWhereInput[] = [{ syntheticAt: { not: null } }];
  if (real.telegramId) or.push({ telegramId: { in: real.telegramId.notIn } });
  const rows = await prisma.user.findMany({ where: { OR: or }, select: { id: true } });
  return new Set(rows.map((r) => r.id));
}

interface RawEventRow {
  id: string;
  userId: string | null;
  installId: string;
  type: string;
  props: unknown;
  occurredAt: Date;
  platform: string;
  screen: string | null;
  appVersion: string | null;
  synthetic: boolean;
}

/**
 * Drop events of excluded users, and of every install that ever carried one.
 * Exported for the journey and screen reads, which apply the same rule.
 */
export function filterExcluded<T extends { userId: string | null; installId: string }>(
  rows: readonly (T & { synthetic?: boolean })[],
  excluded: ReadonlySet<string>,
): T[] {
  const badInstalls = new Set<string>();
  for (const r of rows) {
    if (r.synthetic || (r.userId && excluded.has(r.userId))) badInstalls.add(r.installId);
  }
  return rows.filter((r) => !badInstalls.has(r.installId));
}

function asProps(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Client events with `occurred_at` in `[from, to)`. Raw SQL so the users join
 * that marks synthetic accounts rides along in one round trip; bounded by the
 * window and by `rollupMaxEvents` (a runaway client must not take the rollup
 * down — the cap is logged as `truncated`).
 */
export async function loadClientEvents(
  from: Date,
  to: Date,
  excluded: ReadonlySet<string>,
  where: { screen?: string; types?: readonly string[]; limit?: number } = {},
): Promise<{ rows: PulseEventRow[]; truncated: boolean }> {
  const limit = where.limit ?? PULSE_ANALYTICS.rollupMaxEvents;
  const screenSql = where.screen ? Prisma.sql`AND ce.screen = ${where.screen}` : Prisma.empty;
  const typeSql =
    where.types && where.types.length > 0
      ? Prisma.sql`AND ce.type = ANY(${[...where.types]}::text[])`
      : Prisma.empty;
  const raw = await prisma.$queryRaw<RawEventRow[]>`
    SELECT ce.id::text            AS "id",
           ce.user_id::text       AS "userId",
           ce.install_id          AS "installId",
           ce.type                AS "type",
           ce.props               AS "props",
           ce.occurred_at         AS "occurredAt",
           ce.platform            AS "platform",
           ce.screen              AS "screen",
           ce.app_version         AS "appVersion",
           (u.synthetic_at IS NOT NULL) AS "synthetic"
      FROM client_events ce
      LEFT JOIN users u ON u.id = ce.user_id
     WHERE ce.occurred_at >= ${from}
       AND ce.occurred_at <  ${to}
       ${screenSql}
       ${typeSql}
     ORDER BY ce.occurred_at ASC
     LIMIT ${limit + 1}
  `;
  const truncated = raw.length > limit;
  const kept = filterExcluded(truncated ? raw.slice(0, limit) : raw, excluded);
  return {
    rows: kept.map((r) => ({
      id: r.id,
      userId: r.userId,
      installId: r.installId,
      type: r.type,
      props: asProps(r.props),
      occurredAt: r.occurredAt,
      platform: r.platform,
      screen: r.screen,
      appVersion: r.appVersion,
    })),
    truncated,
  };
}

export async function loadStepEvents(from: Date, to: Date): Promise<StepEventRow[]> {
  return prisma.onboardingStepEvent.findMany({
    where: { createdAt: { gte: from, lt: to }, user: realUserFilter() },
    select: { userId: true, step: true, kind: true, platform: true, createdAt: true },
  });
}

export async function loadActivityDays(from: Date, to: Date): Promise<ActivityDayRow[]> {
  const rows = await prisma.userActivityDay.findMany({
    where: { activityDate: { gte: from, lt: to }, user: realUserFilter() },
    select: { activityDate: true, userId: true, platform: true },
  });
  return rows.map((r) => ({
    day: r.activityDate.toISOString().slice(0, 10),
    userId: r.userId,
    platform: r.platform,
  }));
}

export async function loadSignups(from: Date, to: Date): Promise<SignupRow[]> {
  const rows = await prisma.user.findMany({
    where: { createdAt: { gte: from, lt: to }, ...realUserFilter() },
    select: { id: true, createdAt: true, platform: true },
  });
  return rows.map((r) => ({ userId: r.id, createdAt: r.createdAt, platform: r.platform }));
}

const FUNNEL_EVENT_TYPES = ["PROPOSAL_SHOWN", "ACCEPTED", "DATE_COMPLETED"] as const;

/** Pairs created in `[from, to)` where both sides are real accounts. */
export async function loadFunnelMatches(from: Date, to: Date): Promise<FunnelMatchRow[]> {
  const rows = await prisma.match.findMany({
    where: { createdAt: { gte: from, lt: to }, userA: realUserFilter(), userB: realUserFilter() },
    select: {
      id: true,
      createdAt: true,
      status: true,
      dispatchedAt: true,
      acceptedByA: true,
      acceptedByB: true,
      ticketStatus: true,
      agreedTime: true,
      venueName: true,
      feedbackByA: true,
      feedbackByB: true,
      events: {
        where: { actionType: { in: [...FUNNEL_EVENT_TYPES] } },
        select: { actionType: true },
      },
    },
  });
  return rows.map(({ events, ...m }) => ({ ...m, eventTypes: events.map((e) => e.actionType) }));
}

/**
 * Every real account's consent state — three columns, the whole `users` table.
 * The one load not bounded by the window, deliberately: the share's
 * denominator is everyone who existed at the end of each day, which a window
 * on `created_at` would cut. At tens of thousands of rows this is still one
 * cheap index-less scan a night.
 */
export async function loadOptInUsers(): Promise<OptInUserRow[]> {
  return prisma.user.findMany({
    where: realUserFilter(),
    select: { createdAt: true, analyticsOptIn: true, analyticsOptInAt: true },
  });
}

/**
 * Rewrite `[from, to]` (UTC days) of `metric_days` in one transaction — delete
 * then insert, not per-row upsert, so a screen that stopped being shown stops
 * being served yesterday's numbers (same reasoning as `replaceViralityDays`).
 */
export async function replaceMetricDays(
  from: string,
  to: string,
  rows: readonly MetricRow[],
  computedAt: Date,
): Promise<number> {
  const data = rows.map((r) => ({
    day: new Date(`${r.day}T00:00:00.000Z`),
    metric: r.metric,
    dim: r.dim,
    value: r.value,
    n: r.n,
    computedAt,
  }));
  await prisma.$transaction([
    prisma.metricDay.deleteMany({
      where: {
        day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
      },
    }),
    prisma.metricDay.createMany({ data }),
  ]);
  return data.length;
}

/**
 * Upsert drafts by `key`; every OPEN insight the run did not reproduce gets
 * `resolvedAt` (spec §5.6). A resolved finding that recurs is reopened on the
 * same row — `firstSeenAt` survives, so "this has been coming back since
 * September" stays visible.
 */
export async function writeInsights(
  drafts: readonly InsightDraft[],
  now: Date,
): Promise<{ upserted: number; resolved: number }> {
  const keys = drafts.map((d) => d.key);
  const ops = drafts.map((d) => {
    const fields = {
      kind: d.kind,
      severity: d.severity,
      scope: d.scope,
      title: d.title,
      value: d.value,
      baseline: d.baseline,
      n: d.n,
      smallSample: d.smallSample,
      evidence: d.evidence as Prisma.InputJsonValue,
      codeHint: d.codeHint,
      lastSeenAt: now,
      resolvedAt: null,
    };
    return prisma.insight.upsert({
      where: { key: d.key },
      create: { key: d.key, ...fields, firstSeenAt: now },
      update: fields,
    });
  });
  const resolve = prisma.insight.updateMany({
    where: { resolvedAt: null, ...(keys.length > 0 ? { key: { notIn: keys } } : {}) },
    data: { resolvedAt: now },
  });
  const results = await prisma.$transaction([...ops, resolve]);
  const resolved = (results[results.length - 1] as Prisma.BatchPayload).count;
  return { upserted: drafts.length, resolved };
}

export async function readMetricDays(
  from: string,
  to: string,
  metrics?: readonly PulseMetricName[],
): Promise<MetricRow[]> {
  const rows = await prisma.metricDay.findMany({
    where: {
      day: { gte: new Date(`${from}T00:00:00.000Z`), lte: new Date(`${to}T00:00:00.000Z`) },
      ...(metrics ? { metric: { in: [...metrics] } } : {}),
    },
    select: { day: true, metric: true, dim: true, value: true, n: true },
  });
  return rows.map((r) => ({
    day: r.day.toISOString().slice(0, 10),
    metric: r.metric as PulseMetricName,
    dim: r.dim,
    value: r.value,
    n: r.n,
  }));
}

export async function lastRollupAt(): Promise<Date | null> {
  const row = await prisma.metricDay.findFirst({
    orderBy: { computedAt: "desc" },
    select: { computedAt: true },
  });
  return row?.computedAt ?? null;
}

export async function lastClientEventAt(): Promise<Date | null> {
  const row = await prisma.clientEvent.findFirst({
    orderBy: { receivedAt: "desc" },
    select: { receivedAt: true },
  });
  return row?.receivedAt ?? null;
}

/** Live consent share of real accounts (the freshness block, not the series). */
export async function optInShareNow(): Promise<{ share: number | null; n: number }> {
  const real = realUserFilter();
  const [total, opted] = await Promise.all([
    prisma.user.count({ where: real }),
    prisma.user.count({ where: { ...real, analyticsOptIn: true } }),
  ]);
  return { share: total > 0 ? +(opted / total).toFixed(4) : null, n: total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Stuck people
// ─────────────────────────────────────────────────────────────────────────────

interface LastScreenRow {
  userId: string;
  at: Date;
  screen: string | null;
}

async function lastClientEventByUser(userIds: readonly string[]): Promise<Map<string, LastScreenRow>> {
  if (userIds.length === 0) return new Map();
  const rows = await prisma.$queryRaw<LastScreenRow[]>`
    SELECT DISTINCT ON (user_id)
           user_id::text AS "userId",
           occurred_at   AS "at",
           screen        AS "screen"
      FROM client_events
     WHERE user_id = ANY(${[...userIds]}::uuid[])
     ORDER BY user_id, occurred_at DESC
  `;
  return new Map(rows.map((r) => [r.userId, r]));
}

/**
 * People with no movement for `stuckAfterMs` (spec §5.4), in two phases:
 *   - onboarding — an unfinished account created inside the rollup window
 *     (older abandoned sign-ups are churn, not a live stuck point);
 *   - date — a side of a live pair (`proposed` / `negotiating` /
 *     `negotiating_venue`) created inside the window.
 * Movement = the latest of: account/pair creation, the pair's `updatedAt`,
 * the person's last client event, their last onboarding step event. Where they
 * stopped = the screen of their last client event if any, else the server
 * state (`step:<onboarding step>` / `match:<status>`).
 */
export async function loadStuckPeople(now: Date): Promise<StuckPerson[]> {
  const windowStart = new Date(now.getTime() - PULSE_ANALYTICS.rollupWindowDays * DAY_MS);
  const cutoff = now.getTime() - PULSE_ANALYTICS.stuckAfterMs;

  const [onboarding, pairs] = await Promise.all([
    prisma.user.findMany({
      where: { ...realUserFilter(), onboardingStep: { not: "completed" }, createdAt: { gte: windowStart } },
      select: { id: true, createdAt: true, onboardingStep: true },
    }),
    prisma.match.findMany({
      where: {
        status: { in: ["proposed", "negotiating", "negotiating_venue"] },
        createdAt: { gte: windowStart },
        userA: realUserFilter(),
        userB: realUserFilter(),
      },
      select: { userAId: true, userBId: true, status: true, updatedAt: true },
    }),
  ]);

  const ids = new Set<string>(onboarding.map((u) => u.id));
  for (const p of pairs) {
    ids.add(p.userAId);
    ids.add(p.userBId);
  }
  const [lastClient, lastSteps] = await Promise.all([
    lastClientEventByUser([...ids]),
    onboarding.length === 0
      ? Promise.resolve([] as Array<{ userId: string; step: string; createdAt: Date }>)
      : prisma.onboardingStepEvent.findMany({
          where: { userId: { in: onboarding.map((u) => u.id) } },
          orderBy: { createdAt: "desc" },
          distinct: ["userId"],
          select: { userId: true, step: true, createdAt: true },
        }),
  ]);
  const lastStep = new Map(lastSteps.map((s) => [s.userId, s]));

  const out: StuckPerson[] = [];
  for (const u of onboarding) {
    const c = lastClient.get(u.id);
    const s = lastStep.get(u.id);
    const last = Math.max(u.createdAt.getTime(), c?.at.getTime() ?? 0, s?.createdAt.getTime() ?? 0);
    if (last > cutoff) continue;
    out.push({
      userId: u.id,
      phase: "onboarding",
      where: c?.screen ?? `step:${s?.step ?? u.onboardingStep}`,
      lastMovementAt: new Date(last),
    });
  }
  const seen = new Set(out.map((p) => p.userId));
  for (const p of pairs) {
    for (const userId of [p.userAId, p.userBId]) {
      if (seen.has(userId)) continue;
      const c = lastClient.get(userId);
      const last = Math.max(p.updatedAt.getTime(), c?.at.getTime() ?? 0);
      if (last > cutoff) continue;
      seen.add(userId);
      out.push({
        userId,
        phase: "date",
        where: c?.screen ?? `match:${p.status}`,
        lastMovementAt: new Date(last),
      });
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Journeys (admin reads)
// ─────────────────────────────────────────────────────────────────────────────

export interface JourneyUserRow {
  id: string;
  createdAt: Date;
  verifiedAt: Date | null;
  platform: string;
}

export interface JourneyBundle {
  users: JourneyUserRow[];
  /** Per user: their client events plus the pre-login events of their installs. */
  events: Map<string, PulseEventRow[]>;
  steps: Map<string, Array<{ step: string; kind: string; createdAt: Date }>>;
  matchEvents: Map<string, Array<{ actionType: string; createdAt: Date }>>;
}

/**
 * Everything the journeys of `userIds` need, in four queries regardless of
 * how many people are asked for. Excluded (synthetic / test) users come back
 * absent, so a journey of a test account reads as "not found".
 *
 * Pre-login events are attributed through the install: an event with no user
 * id belongs to the person whose id that install later carried. If two
 * accounts ever shared a phone, its anonymous events go to the first one.
 */
export async function loadJourneyBundle(userIds: readonly string[], from: Date): Promise<JourneyBundle> {
  const empty: JourneyBundle = { users: [], events: new Map(), steps: new Map(), matchEvents: new Map() };
  if (userIds.length === 0) return empty;
  const ids = [...userIds];

  const users = await prisma.user.findMany({
    where: { id: { in: ids }, ...realUserFilter() },
    select: { id: true, createdAt: true, verifiedAt: true, platform: true },
  });
  if (users.length === 0) return empty;
  const realIds = users.map((u) => u.id);

  const [rawEvents, steps, matchEvents] = await Promise.all([
    prisma.$queryRaw<Array<Omit<RawEventRow, "synthetic">>>`
      SELECT ce.id::text       AS "id",
             ce.user_id::text  AS "userId",
             ce.install_id     AS "installId",
             ce.type           AS "type",
             ce.props          AS "props",
             ce.occurred_at    AS "occurredAt",
             ce.platform       AS "platform",
             ce.screen         AS "screen",
             ce.app_version    AS "appVersion"
        FROM client_events ce
       WHERE ce.occurred_at >= ${from}
         AND (
               ce.user_id = ANY(${realIds}::uuid[])
            OR (ce.user_id IS NULL AND ce.install_id IN (
                  SELECT DISTINCT install_id FROM client_events
                   WHERE user_id = ANY(${realIds}::uuid[])
               ))
         )
       ORDER BY ce.occurred_at ASC
       LIMIT ${PULSE_ANALYTICS.rollupMaxEvents}
    `,
    prisma.onboardingStepEvent.findMany({
      where: { userId: { in: realIds }, createdAt: { gte: from } },
      select: { userId: true, step: true, kind: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.matchEvent.findMany({
      where: { actorId: { in: realIds }, createdAt: { gte: from } },
      select: { actorId: true, actionType: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const installOwner = new Map<string, string>();
  for (const e of rawEvents) {
    if (e.userId && !installOwner.has(e.installId)) installOwner.set(e.installId, e.userId);
  }
  const events = new Map<string, PulseEventRow[]>();
  for (const e of rawEvents) {
    const owner = e.userId ?? installOwner.get(e.installId);
    if (!owner) continue;
    const list = events.get(owner) ?? [];
    list.push({
      id: e.id,
      userId: e.userId,
      installId: e.installId,
      type: e.type,
      props: asProps(e.props),
      occurredAt: e.occurredAt,
      platform: e.platform,
      screen: e.screen,
      appVersion: e.appVersion,
    });
    events.set(owner, list);
  }
  const stepMap = new Map<string, Array<{ step: string; kind: string; createdAt: Date }>>();
  for (const s of steps) {
    const list = stepMap.get(s.userId) ?? [];
    list.push({ step: s.step, kind: s.kind, createdAt: s.createdAt });
    stepMap.set(s.userId, list);
  }
  const matchMap = new Map<string, Array<{ actionType: string; createdAt: Date }>>();
  for (const m of matchEvents) {
    const list = matchMap.get(m.actorId) ?? [];
    list.push({ actionType: m.actionType, createdAt: m.createdAt });
    matchMap.set(m.actorId, list);
  }
  return { users, events, steps: stepMap, matchEvents: matchMap };
}

/** Real users with the most recent client activity since `from`, newest first. */
export async function recentlyActiveUserIds(
  from: Date,
  limit: number,
  excluded: ReadonlySet<string>,
): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ userId: string }>>`
    SELECT user_id::text AS "userId"
      FROM client_events
     WHERE user_id IS NOT NULL AND occurred_at >= ${from}
     GROUP BY user_id
     ORDER BY MAX(occurred_at) DESC
     LIMIT ${limit + excluded.size}
  `;
  return rows
    .map((r) => r.userId)
    .filter((id) => !excluded.has(id))
    .slice(0, limit);
}
