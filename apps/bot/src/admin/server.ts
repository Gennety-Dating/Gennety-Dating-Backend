import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { timingSafeEqual } from "node:crypto";
import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { runFaceMatchVerificationDefault } from "../services/verification-pipeline.js";
import { buildWeeklyMatchesReport } from "../services/weekly-matches-report.js";
import {
  downloadProfileImage,
  downloadChatImage,
  downloadTelegramFile,
} from "../services/storage.js";
import { audienceRouter } from "./routes/audience.js";
import { algorithmRouter } from "./routes/algorithm.js";
import { genderRouter } from "./routes/gender.js";
import { retentionRouter } from "./routes/retention.js";
import { datesRouter } from "./routes/dates.js";
import { verificationRouter } from "./routes/verification.js";
import { citiesRouter } from "./routes/cities.js";
import { onboardingFunnelRouter } from "./routes/onboarding-funnel.js";

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
// M3: never echo a wildcard ACAO from an authenticated admin surface. An
// unset (or explicit "*") origin denies cross-origin requests (`origin:
// false` → no ACAO header) instead of opening the dashboard API to every
// site. Production sets `ADMIN_DASHBOARD_ORIGIN` to the concrete dashboard
// origin, so this only bites a misconfigured deploy.
const adminCorsOrigin =
  env.ADMIN_DASHBOARD_ORIGIN && env.ADMIN_DASHBOARD_ORIGIN !== "*"
    ? env.ADMIN_DASHBOARD_ORIGIN.split(",")
    : false;
if (adminCorsOrigin === false) {
  console.warn(
    "[admin] ADMIN_DASHBOARD_ORIGIN is unset or '*' — cross-origin requests are denied. " +
      "Set it to the dashboard origin to enable browser access.",
  );
}
app.use(
  cors({
    origin: adminCorsOrigin,
    methods: ["GET", "POST", "PATCH", "OPTIONS"],
  }),
);

// Cap body size — admin endpoints are read-mostly + a single PATCH /review
// flag, so 32kb is plenty.
app.use(express.json({ limit: "32kb" }));

// M-7: per-IP rate limit. Even with a Bearer gate, an attacker without the
// key can otherwise guess at any pace until they trip a network alarm.
//
// The image proxy (`GET /admin/media`) is exempted here and gets its own
// higher-ceiling limiter below: a single conversation view can fan out to a
// gallery of many images, which would otherwise instantly exhaust the 60/min
// budget for the whole admin surface.
const adminLimiter = rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  skip: (req) => req.path === "/admin/media",
});
app.use(adminLimiter);

// Dedicated, higher-ceiling limiter for the image proxy so a conversation
// view's image gallery doesn't trip the global 60/min budget. Still per-IP,
// still behind the Bearer gate (the route is registered after requireApiKey).
const mediaLimiter = rateLimit({
  windowMs: 60_000,
  limit: 300,
  standardHeaders: "draft-7",
  legacyHeaders: false,
});

app.use(requireApiKey);

// Extended analytics endpoints — split into routers per dashboard tab so the
// section-by-section UI loads independent data without one fat handler.
app.use(audienceRouter);
app.use(algorithmRouter);
app.use(genderRouter);
app.use(retentionRouter);
app.use(datesRouter);
app.use(verificationRouter);
app.use(citiesRouter);
app.use(onboardingFunnelRouter);

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
// GET /admin/analytics/weekly-matches?weekOf=YYYY-MM-DD
// Full per-pair report for the dashboard's "Weekly Matches" view: both users
// (name/age/gender/city/verification/attractiveness) + photo refs (streamed via
// /admin/media) + synergy. Shares the assembler with the founder report page.
// `weekOf` selects that day's 7-day window; omitted → the last 7 days.
// ---------------------------------------------------------------------------
app.get("/admin/analytics/weekly-matches", async (req: Request, res: Response) => {
  try {
    const weekOfRaw = typeof req.query.weekOf === "string" ? req.query.weekOf : "";
    let since: Date;
    let until: Date;
    if (weekOfRaw && !Number.isNaN(Date.parse(weekOfRaw))) {
      since = new Date(weekOfRaw);
      since.setUTCHours(0, 0, 0, 0);
      until = new Date(since.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else {
      until = new Date();
      since = new Date(until.getTime() - 7 * 24 * 60 * 60 * 1000);
    }
    const report = await buildWeeklyMatchesReport({ since, until });
    res.json({ weekOf: since.toISOString(), ...report });
  } catch (err) {
    console.error("[admin] weekly-matches error:", err);
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
// GET /admin/users/:id/conversation — normalized, chronological transcript
// merging BOTH conversation stores plus a profile-photo gallery.
//   • User.messageHistory (Telegram onboarding/menu agents) — array order,
//     no timestamps, no inline images.
//   • Message rows (Aether mobile concierge) — real createdAt + imageUrl.
// Images are returned as refs streamed through GET /admin/media; this endpoint
// never downloads bytes itself.
// ---------------------------------------------------------------------------
type RawHistoryEntry = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
};

type NormalizedMessage = {
  id: string;
  source: "telegram" | "aether";
  role: string;
  text: string | null;
  createdAt: string | null;
  technical: boolean;
  toolCalls?: Array<{ name: string; arguments: string }>;
  image?: { type: "chat"; ref: string };
};

app.get("/admin/users/:id/conversation", async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;

    const [user, aetherRows] = await Promise.all([
      prisma.user.findUnique({
        where: { id },
        select: {
          firstName: true,
          surname: true,
          telegramId: true,
          messageHistory: true,
          profile: { select: { photos: true } },
        },
      }),
      prisma.message.findMany({
        where: { userId: id },
        orderBy: { createdAt: "asc" },
        select: { id: true, role: true, content: true, imageUrl: true, createdAt: true },
      }),
    ]);

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const messages: NormalizedMessage[] = [];

    // Store 1 — Telegram. Order is array order; mark system/tool/null-content
    // turns as technical and surface tool-call names/arguments.
    const history = Array.isArray(user.messageHistory)
      ? (user.messageHistory as RawHistoryEntry[])
      : [];
    history.forEach((entry, idx) => {
      const role = typeof entry?.role === "string" ? entry.role : "unknown";
      const text = typeof entry?.content === "string" ? entry.content : null;
      const toolCalls = Array.isArray(entry?.tool_calls)
        ? entry.tool_calls
            .map((tc) => ({
              name: tc?.function?.name ?? "",
              arguments: tc?.function?.arguments ?? "",
            }))
            .filter((tc) => tc.name || tc.arguments)
        : undefined;
      messages.push({
        id: `mh-${idx}`,
        source: "telegram",
        role,
        text,
        createdAt: null,
        technical: role === "system" || role === "tool" || text === null,
        ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
      });
    });

    // Store 2 — Aether. We deliberately do NOT interleave with Store 1 by
    // fabricating timestamps: a user is realistically one-or-the-other
    // (mobile-only users carry a negative telegramId and no meaningful
    // messageHistory). Emit the Telegram block (above) then the Aether block
    // in createdAt order.
    for (const row of aetherRows) {
      messages.push({
        id: row.id,
        source: "aether",
        role: row.role,
        text: row.content,
        createdAt: row.createdAt.toISOString(),
        technical: row.role === "system",
        ...(row.imageUrl ? { image: { type: "chat" as const, ref: row.imageUrl } } : {}),
      });
    }

    const photos = (user.profile?.photos ?? []).map((ref) => ({
      type: "photo" as const,
      ref,
    }));

    const nameParts = [user.firstName, user.surname].filter(Boolean);
    res.json({
      userId: id,
      telegramId: user.telegramId.toString(),
      displayName: nameParts.length > 0 ? nameParts.join(" ") : null,
      messages,
      photos,
    });
  } catch (err) {
    console.error("[admin] user conversation error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/media — authenticated image proxy. Streams private/Telegram
// image bytes so the dashboard can render them (an `<img src>` can't carry the
// Bearer header, and the key must never ride the query string). Behind the
// global requireApiKey gate; uses the dedicated mediaLimiter so a conversation
// view's gallery doesn't exhaust the 60/min admin budget.
//   ?type=telegram&ref=<file_id>            → downloadTelegramFile
//   ?type=photo&ref=<Profile.photos entry>  → downloadProfileImage (id OR path)
//   ?type=chat&ref=<Message.imageUrl path>  → downloadChatImage
// ---------------------------------------------------------------------------
const MEDIA_TYPES = new Set(["telegram", "photo", "chat"]);
// Telegram file_ids are slash-free base64-ish tokens; treat as opaque.
const TELEGRAM_FILE_ID_RE = /^[A-Za-z0-9_-]+$/;
// Supabase object paths are `{userId}/{ts}.{ext}` — restrict the charset and
// reject `..` so a crafted ref can't traverse the bucket.
const SUPABASE_PATH_RE = /^[A-Za-z0-9._\-/]+$/;

function sniffImageContentType(buf: Buffer): string {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
    return "image/png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP")
    return "image/webp";
  if (buf.length >= 4 && buf.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return "image/jpeg";
}

app.get("/admin/media", mediaLimiter, async (req: Request, res: Response) => {
  try {
    const type = String(req.query.type ?? "");
    const ref = String(req.query.ref ?? "");

    if (!MEDIA_TYPES.has(type)) {
      res.status(400).json({ error: "Invalid media type" });
      return;
    }
    if (!ref) {
      res.status(400).json({ error: "Missing ref" });
      return;
    }

    const isSupabasePath = ref.includes("/");
    if (isSupabasePath) {
      if (!SUPABASE_PATH_RE.test(ref) || ref.includes("..")) {
        res.status(400).json({ error: "Invalid ref" });
        return;
      }
    } else if (!TELEGRAM_FILE_ID_RE.test(ref)) {
      res.status(400).json({ error: "Invalid ref" });
      return;
    }

    let buf: Buffer | null = null;
    if (type === "telegram") {
      if (isSupabasePath) {
        res.status(400).json({ error: "Invalid ref for telegram" });
        return;
      }
      if (!botApi) {
        res.status(503).json({ error: "Bot api not registered" });
        return;
      }
      buf = await downloadTelegramFile(botApi, ref);
    } else if (type === "photo") {
      // A slash-free ref is a Telegram file_id → needs botApi; a path is
      // Supabase → handled without it. downloadProfileImage branches on the
      // ref shape itself and ignores `api` for Supabase paths.
      if (!isSupabasePath && !botApi) {
        res.status(503).json({ error: "Bot api not registered" });
        return;
      }
      buf = await downloadProfileImage(ref, botApi as Api<RawApi>);
    } else {
      // type === "chat" — Supabase chat bucket, no botApi needed.
      buf = await downloadChatImage(ref);
    }

    if (!buf) {
      // Image expired (Telegram file_ids rotate) / missing — never 500-loop.
      res.status(404).json({ error: "Image not found" });
      return;
    }

    res.setHeader("Content-Type", sniffImageContentType(buf));
    res.setHeader("Cache-Control", "private, max-age=300");
    res.send(buf);
  } catch (err) {
    console.error("[admin] media proxy error:", err);
    res.status(404).json({ error: "Image not found" });
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
