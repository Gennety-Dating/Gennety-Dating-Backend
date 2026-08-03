import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { classifyAllUsers } from "../utils/user-health-source.js";
import {
  computeFunnel,
  rate,
  summarizeHealth,
  type OnboardingFunnel,
  type UserHealthSummary,
} from "../utils/user-health.js";

/**
 * Operational + top-level resource endpoints for the admin surface.
 *
 * These exist because the analytics routers are all task-shaped
 * (`/admin/analytics/<tab>`), which left three ordinary things missing:
 *
 *   • `/admin/health`    — is the process and its database actually up?
 *   • `/admin/stats`     — the headline counters, in ONE call.
 *   • `/admin/dashboard` — the composite a dashboard home screen wants,
 *                          instead of fanning out to six analytics tabs.
 *   • `/admin/matches`   — the match ROW list. `/admin/analytics/matches`
 *                          is the aggregate funnel and cannot answer
 *                          "show me the actual pairs".
 *
 * Everything here is read-only and sits behind the same Bearer gate as the
 * rest of the admin API (the router is mounted after `requireApiKey`).
 */
export const opsRouter: Router = Router();

/** Mirrors the `MatchStatus` enum; used to validate the ?status= filter. */
const MATCH_STATUSES = new Set([
  "proposed",
  "negotiating",
  "negotiating_venue",
  "scheduled",
  "cancelled",
  "completed",
  "expired",
]);

function parsePagination(
  rawLimit: unknown,
  rawOffset: unknown,
): { limit: number; offset: number } | null {
  const limitNum = Number(rawLimit ?? 20);
  const offsetNum = Number(rawOffset ?? 0);
  if (!Number.isFinite(limitNum) || !Number.isFinite(offsetNum)) return null;
  return {
    limit: Math.min(Math.max(Math.trunc(limitNum), 1), 100),
    offset: Math.max(Math.trunc(offsetNum), 0),
  };
}

/** Zero-filled counter map so a missing group reads as 0, never `undefined`. */
function tally<T extends string>(
  keys: readonly T[],
  groups: Array<{ _count: { _all: number } }>,
  keyOf: (g: never) => string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of keys) out[k] = 0;
  for (const g of groups) {
    out[keyOf(g as never)] = g._count._all;
  }
  return out;
}

export interface AdminStats {
  users: { total: number; byStatus: Record<string, number> };
  onboarding: { byStep: Record<string, number> };
  verification: { byStatus: Record<string, number> };
  matches: { total: number; byStatus: Record<string, number>; live: number };
  reports: { total: number; byTier: Record<number, number>; unreviewedTier3: number };
  /**
   * Здоровье базы: живые / застрявшие / холодные / подозрительные / тестовые
   * (`admin/utils/user-health.ts`). Существующие секции выше НЕ трогаются —
   * это дополнение, а не замена.
   */
  userHealth: UserHealthSummary & { verified_real: number; scanned: number; truncated: boolean };
  /** Воронка онбординга. Все знаменатели — без тестовых аккаунтов. */
  funnel: OnboardingFunnel;
  generatedAt: string;
}

/**
 * Shared by `/admin/stats` and `/admin/dashboard` so the two can never drift
 * apart — the composite endpoint is meant to be a superset, not a second
 * implementation of the same counters.
 */
async function collectStats(): Promise<AdminStats> {
  const [
    userTotal,
    statusGroups,
    stepGroups,
    verificationGroups,
    matchTotal,
    matchGroups,
    tierGroups,
    unreviewedTier3,
    health,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["onboardingStep"], _count: { _all: true } }),
    prisma.user.groupBy({ by: ["verificationStatus"], _count: { _all: true } }),
    prisma.match.count(),
    prisma.match.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.report.groupBy({ by: ["tier"], _count: { _all: true } }),
    prisma.report.count({ where: { tier: 3, adminReviewed: false } }),
    classifyAllUsers(),
  ]);

  const byStatus = tally(
    ["onboarding", "active", "paused", "frozen", "suspended", "pending_investigation", "banned"],
    statusGroups,
    (g: { status: string }) => g.status,
  );
  const byStep = tally(
    ["consent", "language", "conversational", "completed"],
    stepGroups,
    (g: { onboardingStep: string }) => g.onboardingStep,
  );
  const byVerification = tally(
    ["unverified", "pending", "pending_review", "verified", "rejected"],
    verificationGroups,
    (g: { verificationStatus: string }) => g.verificationStatus,
  );
  const byMatchStatus = tally(
    [...MATCH_STATUSES] as readonly string[],
    matchGroups,
    (g: { status: string }) => g.status,
  );

  const byTier: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
  for (const g of tierGroups) byTier[g.tier] = g._count._all;

  // "Live" = the single-live-match invariant's occupied states (PRODUCT_SPEC
  // §3.2 filter 8). This is the number that answers "is anything in flight".
  const live =
    (byMatchStatus.proposed ?? 0) +
    (byMatchStatus.negotiating ?? 0) +
    (byMatchStatus.negotiating_venue ?? 0) +
    (byMatchStatus.scheduled ?? 0);

  // Верифицированные СРЕДИ реальных: `verification.byStatus.verified` считает
  // и тестовые аккаунты, а любая конверсия должна делиться на реальных.
  const verifiedReal = health.users.filter(
    (u) => u.verdict.classification !== "test" && u.verificationStatus === "verified",
  ).length;

  return {
    users: { total: userTotal, byStatus },
    onboarding: { byStep },
    verification: { byStatus: byVerification },
    matches: { total: matchTotal, byStatus: byMatchStatus, live },
    reports: { total: byTier[1] + byTier[2] + byTier[3], byTier, unreviewedTier3 },
    userHealth: {
      ...summarizeHealth(health.users),
      verified_real: verifiedReal,
      scanned: health.scanned,
      // true = база больше потолка скана, цифры по классам частичные.
      truncated: health.truncated,
    },
    funnel: computeFunnel(health.users),
    generatedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// GET /admin/health
// ---------------------------------------------------------------------------
/**
 * Liveness + readiness. Deliberately answers 503 when the database is
 * unreachable: a health check that reports 200 while Postgres is down is
 * worse than no health check, because it silences the one alarm that matters.
 */
opsRouter.get("/admin/health", async (_req: Request, res: Response) => {
  let db: { ok: boolean; latencyMs: number | null; error?: string } = {
    ok: false,
    latencyMs: null,
  };

  try {
    const startedAt = Date.now();
    await prisma.$queryRaw`SELECT 1`;
    db = { ok: true, latencyMs: Date.now() - startedAt };
  } catch (err) {
    // The message is safe to surface here (admin-only, Bearer-gated) and is
    // the difference between "DB is down" and "schema drift" at a glance.
    db = {
      ok: false,
      latencyMs: null,
      error: err instanceof Error ? err.message.split("\n")[0] : "unknown error",
    };
  }

  res.status(db.ok ? 200 : 503).json({
    ok: db.ok,
    service: "gennety-admin-api",
    uptimeSeconds: Math.round(process.uptime()),
    nodeVersion: process.version,
    db,
    now: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// GET /admin/stats
// ---------------------------------------------------------------------------
/** Headline counters across users, onboarding, verification, matches, reports. */
opsRouter.get("/admin/stats", async (_req: Request, res: Response) => {
  try {
    res.json(await collectStats());
  } catch (err) {
    console.error("[admin] stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/dashboard
// ---------------------------------------------------------------------------
/**
 * One-call composite for a dashboard home screen: the same counters as
 * `/admin/stats`, plus the derived rates a reader actually looks at first and
 * a short list of the most recent matches.
 */
opsRouter.get("/admin/dashboard", async (_req: Request, res: Response) => {
  try {
    const [stats, recentMatches, recentUsers] = await Promise.all([
      collectStats(),
      prisma.match.findMany({
        take: 10,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          synergyScore: true,
          agreedTime: true,
          venueName: true,
          source: true,
          createdAt: true,
        },
      }),
      prisma.user.count({
        where: { createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
      }),
    ]);

    const { matches, userHealth, funnel } = stats;
    // Progressed past `proposed` — the same definition the analytics funnel
    // uses, kept here so the two dashboards agree.
    const accepted =
      (matches.byStatus.negotiating ?? 0) +
      (matches.byStatus.negotiating_venue ?? 0) +
      (matches.byStatus.scheduled ?? 0) +
      (matches.byStatus.completed ?? 0);

    res.json({
      ...stats,
      derived: {
        signupsLast7Days: recentUsers,
        // ИСПРАВЛЕНО: раньше делилось на users.total, т.е. вместе с тестовыми
        // аккаунтами (5/19 вместо 5/16). Знаменатель — реальные пользователи,
        // числитель — активные И верифицированные, т.е. те, кто действительно
        // дошёл до рабочего состояния.
        activeRate: rate(funnel.active_verified, funnel.registered_real),
        verifiedRate: rate(userHealth.verified_real, funnel.registered_real),
        matchAcceptanceRate: rate(accepted, matches.total),
        conversionConsentToActivePct: funnel.conversion_consent_to_active_pct,
        conversionRegisteredToActivePct: funnel.conversion_registered_to_active_pct,
        matchmakingEligibleCount: userHealth.matchmaking_eligible.count,
      },
      recentMatches: recentMatches.map((m) => ({
        ...m,
        agreedTime: m.agreedTime?.toISOString() ?? null,
        createdAt: m.createdAt.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[admin] dashboard error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/matches?limit=&offset=&status=
// ---------------------------------------------------------------------------
/**
 * The match ROW list — the pairs themselves, newest first, with both
 * participants inlined. Distinct from `/admin/analytics/matches`, which is
 * the aggregate funnel and cannot answer "which pairs exist right now".
 */
opsRouter.get("/admin/matches", async (req: Request, res: Response) => {
  try {
    const page = parsePagination(req.query.limit, req.query.offset);
    if (!page) {
      res.status(400).json({ error: "limit and offset must be integers" });
      return;
    }
    const { limit, offset } = page;

    const statusRaw = String(req.query.status ?? "");
    if (statusRaw && !MATCH_STATUSES.has(statusRaw)) {
      res.status(400).json({
        error: `status must be one of: ${[...MATCH_STATUSES].join(", ")}`,
      });
      return;
    }
    const where = statusRaw ? { status: statusRaw as never } : {};

    const participant = {
      select: {
        id: true,
        telegramId: true,
        firstName: true,
        age: true,
        gender: true,
        status: true,
        verificationStatus: true,
      },
    } as const;

    const [rows, total] = await Promise.all([
      prisma.match.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          status: true,
          source: true,
          synergyScore: true,
          acceptedByA: true,
          acceptedByB: true,
          agreedTime: true,
          venueName: true,
          venueAddress: true,
          ticketStatus: true,
          dispatchedAt: true,
          createdAt: true,
          userA: participant,
          userB: participant,
        },
      }),
      prisma.match.count({ where }),
    ]);

    // telegramId is a BigInt — JSON.stringify throws on it, so both
    // participants are serialized explicitly (same rule as /admin/users).
    const data = rows.map((m) => ({
      ...m,
      agreedTime: m.agreedTime?.toISOString() ?? null,
      dispatchedAt: m.dispatchedAt?.toISOString() ?? null,
      createdAt: m.createdAt.toISOString(),
      userA: { ...m.userA, telegramId: m.userA.telegramId.toString() },
      userB: { ...m.userB, telegramId: m.userB.telegramId.toString() },
    }));

    res.json({ data, total, limit, offset });
  } catch (err) {
    console.error("[admin] matches list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
