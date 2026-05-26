import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { runFaceMatchVerificationDefault } from "../services/verification-pipeline.js";
import { audienceRouter } from "./routes/audience.js";
import { algorithmRouter } from "./routes/algorithm.js";
import { genderRouter } from "./routes/gender.js";
import { retentionRouter } from "./routes/retention.js";
import { datesRouter } from "./routes/dates.js";
import { verificationRouter } from "./routes/verification.js";

// ---------------------------------------------------------------------------
// Auth middleware — Bearer token matching ADMIN_API_KEY (timing-safe)
// ---------------------------------------------------------------------------
/**
 * M-7 patches:
 *   1. `timingSafeEqual` instead of `!==` so the token can't be brute-forced
 *      via response-time comparison.
 *   2. `helmet()` on the admin app (not just the public one).
 *   3. Body-size limit on JSON parser — default Express limit is generous.
 *   4. Per-IP rate limit on the entire admin surface — even with a Bearer
 *      gate, the unauthenticated path can be hammered for guesses.
 */
function constantTimeEqual(a: string, b: string): boolean {
  // Always pad to the longer length so comparison time is constant — but
  // length difference is itself a signal we mustn't reveal early. Returning
  // false on mismatched lengths after the comparison still leaks 1 bit
  // (length), which is acceptable for an opaque random token.
  const aBuf = Buffer.from(a);
  const bBuf = Buffer.from(b);
  if (aBuf.length !== bBuf.length) {
    // Run a dummy compare against same-length zeros to keep the cost stable.
    timingSafeEqual(aBuf, Buffer.alloc(aBuf.length));
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

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
  if (!constantTimeEqual(token, env.ADMIN_API_KEY)) {
    res.status(401).json({ error: "Invalid API key" });
    return;
  }

  next();
}

// ---------------------------------------------------------------------------
// Bot Api registry (set by startAdminServer)
// ---------------------------------------------------------------------------
/**
 * The "rerun verification" endpoint kicks the same pipeline that the
 * Persona webhook uses, which DMs the user with the outcome. We hold a
 * lazy reference to the bot Api so the admin module doesn't have to
 * become a dependency-injection factory just for this one route — tests
 * import `app` directly and skip the registration.
 */
let botApi: Api<RawApi> | null = null;
export function setAdminBotApi(api: Api<RawApi>): void {
  botApi = api;
}

// ---------------------------------------------------------------------------
// Express app (exported for testing without .listen())
// ---------------------------------------------------------------------------
export const app: ReturnType<typeof express> = express();

app.set("trust proxy", 1);

app.use(helmet());
app.use(
  cors({
    origin: env.ADMIN_DASHBOARD_ORIGIN === "*" ? "*" : env.ADMIN_DASHBOARD_ORIGIN.split(","),
    methods: ["GET", "PATCH", "OPTIONS"],
  }),
);

// Cap body size — admin endpoints are read-mostly + a single PATCH /review
// flag, so 32kb is plenty.
app.use(express.json({ limit: "32kb" }));

// M-7: per-IP rate limit. Even with a Bearer gate, an attacker without the
// key can otherwise guess at any pace until they trip a network alarm.
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});
app.use(adminLimiter);

app.use(requireApiKey);

// Extended analytics endpoints — split into routers per dashboard tab so the
// section-by-section UI loads independent data without one fat handler.
app.use(audienceRouter);
app.use(algorithmRouter);
app.use(genderRouter);
app.use(retentionRouter);
app.use(datesRouter);
app.use(verificationRouter);

type AdminProfileSnapshot = {
  height: number | null;
  hobbies: string[];
  partnerPreferences: string | null;
  psychologicalSummary: string | null;
  negativeConstraints: string | null;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  photos: string[];
};

function parseProfileList(value: string | null | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\r?\n|[;,]/)
    .map((item) => item.trim().replace(/^[-*•]\s*/, ""))
    .filter(Boolean);
}

function serializeAdminProfile(profile: AdminProfileSnapshot | null) {
  if (!profile) return null;
  return {
    height: profile.height,
    hobbies: profile.hobbies,
    partnerPreferences: parseProfileList(profile.partnerPreferences),
    psychologicalSummary: profile.psychologicalSummary,
    negativeConstraints: parseProfileList(profile.negativeConstraints),
    ageRangeMin: profile.ageRangeMin,
    ageRangeMax: profile.ageRangeMax,
    photos: profile.photos,
  };
}

const REPORT_USER_SELECT = {
  id: true,
  firstName: true,
  surname: true,
  telegramId: true,
  email: true,
  status: true,
  verificationStatus: true,
  isEmailVerified: true,
  strikes: true,
  profile: {
    select: {
      height: true,
      hobbies: true,
      partnerPreferences: true,
      psychologicalSummary: true,
      negativeConstraints: true,
      ageRangeMin: true,
      ageRangeMax: true,
      photos: true,
    },
  },
} as const;

function serializeReportUser<
  T extends {
    telegramId: bigint;
    profile: AdminProfileSnapshot | null;
  },
>(user: T) {
  return {
    ...user,
    telegramId: user.telegramId.toString(),
    profile: serializeAdminProfile(user.profile),
  };
}

// ---------------------------------------------------------------------------
// GET /admin/analytics/demographics
// ---------------------------------------------------------------------------
app.get("/admin/analytics/demographics", async (_req: Request, res: Response) => {
  try {
    const [totalUsers, genderGroups, universityRows] = await Promise.all([
      prisma.user.count(),
      prisma.user.groupBy({ by: ["gender"], _count: { _all: true } }),
      // Pull (domain, status) so we can compute per-university active %
      // in one pass rather than N additional COUNTs.
      prisma.user.groupBy({
        by: ["universityDomain", "status"],
        _count: { _all: true },
      }),
    ]);

    const genderSplit: Record<string, number> = { male: 0, female: 0, unknown: 0 };
    for (const g of genderGroups) {
      const key = g.gender ?? "unknown";
      genderSplit[key] = g._count._all;
    }

    const uniMap = new Map<string, { total: number; active: number }>();
    for (const row of universityRows) {
      if (!row.universityDomain) continue;
      let bucket = uniMap.get(row.universityDomain);
      if (!bucket) {
        bucket = { total: 0, active: 0 };
        uniMap.set(row.universityDomain, bucket);
      }
      bucket.total += row._count._all;
      if (row.status === "active") bucket.active += row._count._all;
    }
    const byUniversity = Array.from(uniMap.entries())
      .map(([domain, c]) => ({
        domain,
        count: c.total,
        activeCount: c.active,
        activeRate: c.total > 0 ? +(c.active / c.total).toFixed(4) : 0,
      }))
      .sort((a, b) => b.count - a.count);

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
// GET /admin/analytics/no-match-notices
// ---------------------------------------------------------------------------
/**
 * Per-drop breakdown of "no match this week" DMs sent over the last N weeks.
 * A rising count week-over-week is the canary that the matchmaker / user
 * base needs attention before users churn.
 *
 * Query params:
 *   - `weeks` (default 8, max 26): how far back to look.
 */
app.get("/admin/analytics/no-match-notices", async (req: Request, res: Response) => {
  try {
    const requested = Number(req.query.weeks ?? 8);
    if (!Number.isFinite(requested) || requested <= 0) {
      res.status(400).json({ error: "weeks must be a positive integer" });
      return;
    }
    const weeks = Math.min(Math.max(Math.floor(requested), 1), 26);

    const since = new Date(Date.now() - weeks * 7 * 24 * 60 * 60 * 1000);

    const rows = await prisma.noMatchNotice.findMany({
      where: { dropDate: { gte: since } },
      select: { dropDate: true, tier: true },
    });

    const byDrop = new Map<string, { total: number; tier1: number; tier2: number; tier3plus: number }>();
    for (const r of rows) {
      const key = r.dropDate.toISOString().slice(0, 10);
      let bucket = byDrop.get(key);
      if (!bucket) {
        bucket = { total: 0, tier1: 0, tier2: 0, tier3plus: 0 };
        byDrop.set(key, bucket);
      }
      bucket.total++;
      if (r.tier === 1) bucket.tier1++;
      else if (r.tier === 2) bucket.tier2++;
      else bucket.tier3plus++;
    }

    const drops = Array.from(byDrop.entries())
      .map(([dropDate, counts]) => ({ dropDate, ...counts }))
      .sort((a, b) => a.dropDate.localeCompare(b.dropDate));

    const total = rows.length;
    res.json({ weeks, total, drops });
  } catch (err) {
    console.error("[admin] no-match-notices error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/users  — paginated list (no embedding)
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
  // Face-match verification surface — admin needs to spot pending_review
  // rows and dig into per-photo scores before approving / rejecting.
  verificationStatus: true,
  verifiedAt: true,
  verifiedSelfiePath: true,
  personaInquiryId: true,
  faceMatchScore: true,
  faceMatchedAt: true,
  profile: {
    select: {
      height: true,
      hobbies: true,
      partnerPreferences: true,
      psychologicalSummary: true,
      negativeConstraints: true,
      ageRangeMin: true,
      ageRangeMax: true,
      photos: true,
      photoFaceScores: true,
      eloScore: true,
      eloMatchesPlayed: true,
      // embedding (vector(1536)) intentionally excluded — saves bandwidth
    },
  },
} as const;

/**
 * `?verificationStatus=` filter values accepted by the users list. Mirrors
 * the Prisma enum so the admin can drill into `pending_review` rows
 * directly without scrolling. Unknown values are ignored (no filter).
 */
const VERIFICATION_STATUS_FILTER = new Set([
  "unverified",
  "pending",
  "pending_review",
  "verified",
  "rejected",
] as const);

app.get("/admin/users", async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.query.limit ?? 20), 100);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);

    if (!Number.isFinite(limit) || !Number.isFinite(offset)) {
      res.status(400).json({ error: "limit and offset must be integers" });
      return;
    }

    const verificationStatus = String(req.query.verificationStatus ?? "");
    const where =
      verificationStatus &&
      VERIFICATION_STATUS_FILTER.has(verificationStatus as never)
        ? { verificationStatus: verificationStatus as never }
        : {};

    const [data, total] = await Promise.all([
      prisma.user.findMany({
        where,
        take: limit,
        skip: offset,
        orderBy: { createdAt: "desc" },
        select: USER_SELECT,
      }),
      prisma.user.count({ where }),
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
// POST /admin/users/:id/rerun-verification — manually re-run the face-match
// pipeline against the user's existing Persona inquiry. Used when:
//   • A row sits in pending_review and the admin wants a second pass
//     (e.g. after the user re-uploaded better photos).
//   • A previous run failed mid-pipeline (Rekognition outage).
//   • Suspicious activity flagged by support — they manually rerun to
//     re-verify the photo set against the original selfie.
// ---------------------------------------------------------------------------
app.post(
  "/admin/users/:id/rerun-verification",
  async (req: Request, res: Response) => {
    try {
      if (!botApi) {
        // Tests that import `app` directly skip `setAdminBotApi`. The
        // pipeline can't DM the user without an Api, so we 503 instead
        // of running headless and writing a half-result to DB.
        res.status(503).json({ error: "Bot api not registered" });
        return;
      }

      const id = req.params["id"] as string;
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, personaInquiryId: true },
      });
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      if (!user.personaInquiryId) {
        res.status(400).json({ error: "User has no Persona inquiry to rerun" });
        return;
      }

      // Reset `faceMatchedAt` so the pipeline's idempotency check doesn't
      // skip — we explicitly want to re-process this inquiry.
      await prisma.user.update({
        where: { id: user.id },
        data: { faceMatchedAt: null },
      });

      const outcome = await runFaceMatchVerificationDefault(
        user.id,
        user.personaInquiryId,
        botApi,
      );
      res.json({ outcome });
    } catch (err) {
      console.error("[admin] rerun verification error:", err);
      res.status(500).json({ error: "Internal server error" });
    }
  },
);

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
            select: REPORT_USER_SELECT,
          },
          reported: {
            select: REPORT_USER_SELECT,
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
      reporter: serializeReportUser(r.reporter),
      reported: serializeReportUser(r.reported),
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
export function startAdminServer(api: Api<RawApi>): void {
  setAdminBotApi(api);
  app.listen(env.ADMIN_PORT, () => {
    console.log(`[admin] Analytics API listening on :${env.ADMIN_PORT}`);
  });
}
