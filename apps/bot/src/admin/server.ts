import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { prisma } from "@gennety/db";
import { env } from "../config.js";

// ---------------------------------------------------------------------------
// Auth middleware — requires Bearer token matching ADMIN_API_KEY
// ---------------------------------------------------------------------------
function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!env.ADMIN_API_KEY) {
    res.status(503).json({ error: "Admin API is not configured" });
    return;
  }

  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = header.slice(7);
  if (token !== env.ADMIN_API_KEY) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Express app (exported for testing without .listen())
// ---------------------------------------------------------------------------
export const app: ReturnType<typeof express> = express();

app.use(
  cors({
    origin: env.ADMIN_DASHBOARD_ORIGIN === "*" ? "*" : env.ADMIN_DASHBOARD_ORIGIN.split(","),
    methods: ["GET", "PATCH", "OPTIONS"],
  }),
);

app.use(express.json());

app.use(requireApiKey);

// ---------------------------------------------------------------------------
// GET /admin/analytics/demographics
// ---------------------------------------------------------------------------
app.get("/admin/analytics/demographics", async (_req: Request, res: Response) => {
  try {
    const [totalUsers, genderGroups, universityGroups] = await Promise.all([
      prisma.user.count(),
      prisma.user.groupBy({ by: ["gender"], _count: { _all: true } }),
      prisma.user.groupBy({
        by: ["universityDomain"],
        _count: { _all: true },
        orderBy: { _count: { universityDomain: "desc" } },
      }),
    ]);

    const genderSplit: Record<string, number> = { male: 0, female: 0, unknown: 0 };
    for (const g of genderGroups) {
      const key = g.gender ?? "unknown";
      genderSplit[key] = g._count._all;
    }

    const byUniversity = universityGroups
      .filter((u) => u.universityDomain !== null)
      .map((u) => ({ domain: u.universityDomain!, count: u._count._all }));

    res.json({ totalUsers, genderSplit, byUniversity });
  } catch (err) {
    console.error("[admin] demographics error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/analytics/funnel
// ---------------------------------------------------------------------------
app.get("/admin/analytics/funnel", async (_req: Request, res: Response) => {
  try {
    const [statusGroups, stepGroups] = await Promise.all([
      prisma.user.groupBy({ by: ["status"], _count: { _all: true } }),
      prisma.user.groupBy({ by: ["onboardingStep"], _count: { _all: true } }),
    ]);

    const byStatus: Record<string, number> = { onboarding: 0, active: 0, paused: 0 };
    for (const s of statusGroups) {
      byStatus[s.status] = s._count._all;
    }

    const byOnboardingStep: Record<string, number> = { language: 0, conversational: 0, completed: 0 };
    for (const s of stepGroups) {
      byOnboardingStep[s.onboardingStep] = s._count._all;
    }

    res.json({ byStatus, byOnboardingStep });
  } catch (err) {
    console.error("[admin] funnel error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/analytics/matches
// ---------------------------------------------------------------------------
app.get("/admin/analytics/matches", async (_req: Request, res: Response) => {
  try {
    const statusGroups = await prisma.match.groupBy({
      by: ["status"],
      _count: { _all: true },
    });

    const counts: Record<string, number> = {
      proposed: 0,
      negotiating: 0,
      scheduled: 0,
      cancelled: 0,
      completed: 0,
      expired: 0,
    };
    for (const g of statusGroups) {
      counts[g.status] = g._count._all;
    }

    const totalProposed =
      counts.proposed + counts.negotiating + counts.scheduled + counts.cancelled + counts.completed + (counts.expired ?? 0);

    // Acceptance = matches that progressed past "proposed" (negotiating+scheduled+completed)
    const accepted = counts.negotiating + counts.scheduled + counts.completed;
    const acceptanceRate = totalProposed > 0 ? +(accepted / totalProposed).toFixed(4) : 0;

    // Count dispatched-but-pending matches (pitch sent, waiting for user response).
    const dispatched = await prisma.match.count({
      where: {
        status: "proposed",
        dispatchedAt: { not: null },
      },
    });

    res.json({
      totalProposed,
      accepted,
      acceptanceRate,
      scheduled: counts.scheduled,
      cancelled: counts.cancelled,
      completed: counts.completed,
      expired: counts.expired ?? 0,
      dispatched,
    });
  } catch (err) {
    console.error("[admin] matches error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/users  — paginated list (no embedding, no visualVector)
// ---------------------------------------------------------------------------
const USER_SELECT = {
  id: true,
  telegramId: true,
  firstName: true,
  surname: true,
  age: true,
  gender: true,
  preference: true,
  major: true,
  language: true,
  status: true,
  onboardingStep: true,
  universityDomain: true,
  email: true,
  createdAt: true,
  profile: {
    select: {
      height: true,
      hobbies: true,
      partnerPreferences: true,
      visualPreferences: true,
      psychologicalSummary: true,
      negativeConstraints: true,
      ageRangeMin: true,
      ageRangeMax: true,
      photos: true,
      // embedding (vector(1536)) intentionally excluded — saves bandwidth
      // visualVector (Float[]) intentionally excluded — not human-readable
    },
  },
} as const;

app.get("/admin/users", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
      res.status(400).json({ error: "limit and offset must be integers" });
      return;
    }

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        select: USER_SELECT,
      }),
      prisma.user.count(),
    ]);

    // Serialize BigInt telegramId to string for JSON safety
    const serialized = data.map((u) => ({ ...u, telegramId: u.telegramId.toString() }));

    res.json({ data: serialized, total, limit, offset });
  } catch (err) {
    console.error("[admin] users list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/users/:id  — single user detail (includes messageHistory)
// ---------------------------------------------------------------------------
app.get("/admin/users/:id", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...USER_SELECT,
        messageHistory: true,
      },
    });

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    res.json({ ...user, telegramId: user.telegramId.toString() });
  } catch (err) {
    console.error("[admin] user detail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/reports/stats  — aggregate report counts by tier
// ---------------------------------------------------------------------------
app.get("/admin/reports/stats", async (_req: Request, res: Response) => {
  try {
    const [tierGroups, unreviewedTier3] = await Promise.all([
      prisma.report.groupBy({
        by: ["tier"],
        _count: { _all: true },
      }),
      prisma.report.count({
        where: { tier: 3, adminReviewed: false },
      }),
    ]);

    const byTier: Record<number, number> = { 1: 0, 2: 0, 3: 0 };
    for (const g of tierGroups) {
      byTier[g.tier] = g._count._all;
    }
    const total = byTier[1] + byTier[2] + byTier[3];

    res.json({ total, byTier, unreviewedTier3 });
  } catch (err) {
    console.error("[admin] reports stats error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/reports  — paginated list with reporter/reported info
// ---------------------------------------------------------------------------
app.get("/admin/reports", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
      res.status(400).json({ error: "limit and offset must be integers" });
      return;
    }

    // Optional filters
    const tierFilter = req.query.tier ? Number(req.query.tier) : undefined;
    const reviewedFilter =
      req.query.reviewed === "true"
        ? true
        : req.query.reviewed === "false"
          ? false
          : undefined;

    const where: Record<string, unknown> = {};
    if (tierFilter !== undefined && [1, 2, 3].includes(tierFilter)) {
      where.tier = tierFilter;
    }
    if (reviewedFilter !== undefined) {
      where.adminReviewed = reviewedFilter;
    }

    const [data, total] = await Promise.all([
      prisma.report.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          tier: true,
          rawText: true,
          reasonSummary: true,
          adminReviewed: true,
          createdAt: true,
          reporter: {
            select: { id: true, firstName: true, surname: true, telegramId: true },
          },
          reported: {
            select: { id: true, firstName: true, surname: true, telegramId: true, status: true, strikes: true },
          },
          match: {
            select: { id: true, status: true },
          },
        },
      }),
      prisma.report.count({ where }),
    ]);

    const serialized = data.map((r) => ({
      ...r,
      reporter: { ...r.reporter, telegramId: r.reporter.telegramId.toString() },
      reported: { ...r.reported, telegramId: r.reported.telegramId.toString() },
    }));

    res.json({ data: serialized, total, limit, offset });
  } catch (err) {
    console.error("[admin] reports list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// PATCH /admin/reports/:id/review  — mark a report as admin-reviewed
// ---------------------------------------------------------------------------
app.patch("/admin/reports/:id/review", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;

    const report = await prisma.report.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }

    await prisma.report.update({
      where: { id },
      data: { adminReviewed: true },
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("[admin] report review error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// Start listener (called from index.ts)
// ---------------------------------------------------------------------------
export function startAdminServer(): void {
  app.listen(env.ADMIN_PORT, () => {
    console.log(`[admin] Analytics API listening on :${env.ADMIN_PORT}`);
  });
}
