/**
 * End-to-end tests for the public `/v1/*` API consumed by the Expo mobile app.
 *
 * Exercises the full Express stack (helmet, cors, rate limits, JSON parsing,
 * auth middleware, routers) via supertest while mocking the DB + OpenAI /
 * Supabase / Expo-push IO edges. The goal is to prove the contract the mobile
 * client in `gennety-mobile/src/api/*.ts` relies on, not to re-test the Prisma
 * layer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Mock env BEFORE any backend module loads `config.ts`.
// ---------------------------------------------------------------------------

vi.mock("../config.js", () => ({
  env: {
    BOT_TOKEN: "test-bot-token",
    DATABASE_URL: "postgres://test",
    RESEND_API_KEY: "",
    SMTP_FROM: "noreply@test.invalid",
    OPENAI_API_KEY: "sk-test",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    MESSAGE_EFFECT_MATCH_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "admin-key",
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
    // Public API env — JWT_SECRET must be non-empty or signAccessToken throws.
    JWT_SECRET: "test-jwt-secret-not-for-production",
    JWT_ACCESS_TTL: "15m",
    JWT_REFRESH_TTL: "30d",
    PUBLIC_PORT: 3101,
    PUBLIC_CORS_ORIGIN: "*",
    EXPO_ACCESS_TOKEN: "",
    SUPABASE_URL: "",
    SUPABASE_SERVICE_ROLE_KEY: "",
    SUPABASE_SELFIE_BUCKET: "selfies",
  },
}));

// ---------------------------------------------------------------------------
// 2. In-memory Prisma mock. Uses a shared map so different tests can seed and
//    assert against the same fake DB state across routes.
// ---------------------------------------------------------------------------

type UserRow = {
  id: string;
  telegramId: bigint;
  email: string | null;
  universityDomain: string | null;
  firstName: string | null;
  surname: string | null;
  age: number | null;
  gender: "male" | "female" | null;
  preference: "men" | "women" | "both" | null;
  major: string | null;
  language: "en" | "ru" | "uk" | null;
  status: string;
  onboardingStep: string;
  platform: "telegram" | "mobile" | "both";
  pushToken: string | null;
  pushPlatform: string | null;
  verificationStatus: "unverified" | "pending" | "verified" | "rejected";
  selfiePath: string | null;
  messageHistory: unknown[];
  profile?: ProfileRow | null;
};

type ProfileRow = {
  id: string;
  userId: string;
  hobbies: string[];
  partnerPreferences: string | null;
  psychologicalSummary: string | null;
  ageRangeMin: number | null;
  ageRangeMax: number | null;
  photos: string[];
  matchRadius: "campus_only" | "citywide";
};

type OtpRow = {
  id: string;
  email: string;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  createdAt: Date;
};

type SessionRow = {
  id: string;
  userId: string;
  refreshTokenHash: string;
  userAgent: string | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
};

type MatchRow = {
  id: string;
  userAId: string;
  userBId: string;
  status:
    | "proposed"
    | "negotiating"
    | "negotiating_venue"
    | "scheduled"
    | "cancelled"
    | "completed"
    | "expired";
  pitchForA: string | null;
  pitchForB: string | null;
  iceBreakersA: string[];
  iceBreakersB: string[];
  agreedTime: Date | null;
  venueName: string | null;
  venueAddress: string | null;
  venueLat: number | null;
  venueLng: number | null;
  acceptedByA: boolean | null;
  acceptedByB: boolean | null;
  vibeTextA: string | null;
  vibeTextB: string | null;
  vibeLatA: number | null;
  vibeLngA: number | null;
  vibeLatB: number | null;
  vibeLngB: number | null;
  parsedCategoryA: string | null;
  parsedCategoryB: string | null;
  venuePromptAskedAt: Date | null;
  safetyAckA: boolean;
  safetyAckB: boolean;
  createdAt: Date;
};

type ReportRow = {
  id: string;
  reporterId: string;
  reportedId: string;
  matchId: string;
  rawText: string;
  tier: number;
  reasonSummary: string | null;
  adminReviewed: boolean;
  createdAt: Date;
};

const db = {
  users: new Map<string, UserRow>(),
  otps: [] as OtpRow[],
  sessions: new Map<string, SessionRow>(),
  matches: new Map<string, MatchRow>(),
  reports: [] as ReportRow[],
};

function resetDb(): void {
  db.users.clear();
  db.otps.length = 0;
  db.sessions.clear();
  db.matches.clear();
  db.reports.length = 0;
}

function userById(id: string): UserRow | undefined {
  return db.users.get(id);
}

function findUser(where: Record<string, unknown>): UserRow | undefined {
  if (typeof where.id === "string") return db.users.get(where.id);
  if (typeof where.email === "string") {
    return [...db.users.values()].find((u) => u.email === where.email);
  }
  if (typeof where.telegramId === "bigint") {
    return [...db.users.values()].find((u) => u.telegramId === where.telegramId);
  }
  return undefined;
}

class PrismaClientKnownRequestError extends Error {
  code: string;
  meta?: { target?: string[] };
  constructor(message: string, code: string, meta?: { target?: string[] }) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

vi.mock("@gennety/db", async () => {
  return {
    Prisma: { PrismaClientKnownRequestError },
    prisma: {
      // ----- user -----
      user: {
        findUnique: vi.fn(async ({ where, include, select }: any) => {
          const u = findUser(where);
          if (!u) return null;
          const row: any = { ...u };
          if (include?.profile) row.profile = u.profile ?? null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) {
              if (k === "profile" && select.profile) {
                out.profile = u.profile
                  ? pickSelect(u.profile, select.profile.select ?? select.profile)
                  : null;
              } else {
                out[k] = (u as any)[k];
              }
            }
            return out;
          }
          return row;
        }),
        findUniqueOrThrow: vi.fn(async (args: any) => {
          const u = findUser(args.where);
          if (!u) throw new Error("User not found");
          if (args.select) {
            return pickSelect(u, args.select);
          }
          return u;
        }),
        create: vi.fn(async ({ data }: any) => {
          // Simulate `@unique` on telegramId.
          const conflict = [...db.users.values()].find(
            (u) => u.telegramId === data.telegramId,
          );
          if (conflict) {
            throw new PrismaClientKnownRequestError(
              "Unique constraint failed",
              "P2002",
              { target: ["telegram_id"] },
            );
          }
          const id = crypto.randomUUID();
          const row: UserRow = {
            id,
            telegramId: data.telegramId,
            email: data.email ?? null,
            universityDomain: data.universityDomain ?? null,
            firstName: null,
            surname: null,
            age: null,
            gender: null,
            preference: null,
            major: null,
            language: null,
            status: data.status ?? "onboarding",
            onboardingStep: data.onboardingStep ?? "consent",
            platform: data.platform ?? "telegram",
            pushToken: null,
            pushPlatform: null,
            verificationStatus: "unverified",
            selfiePath: null,
            messageHistory: [],
            profile: null,
          };
          db.users.set(id, row);
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const u = findUser(where);
          if (!u) throw new Error("User not found");
          Object.assign(u, applyData(data));
          return u;
        }),
      },

      // ----- emailOtp -----
      emailOtp: {
        create: vi.fn(async ({ data }: any) => {
          const row: OtpRow = {
            id: crypto.randomUUID(),
            email: data.email,
            codeHash: data.codeHash,
            expiresAt: data.expiresAt,
            attempts: 0,
            consumedAt: null,
            createdAt: new Date(),
          };
          db.otps.push(row);
          return row;
        }),
        findFirst: vi.fn(async ({ where }: any) => {
          const matches = db.otps.filter(
            (o) => o.email === where.email && o.consumedAt === where.consumedAt,
          );
          matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          return matches[0] ?? null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const o = db.otps.find((r) => r.id === where.id);
          if (!o) throw new Error("Otp not found");
          if (data.attempts?.increment) o.attempts += data.attempts.increment;
          if (data.consumedAt !== undefined) o.consumedAt = data.consumedAt;
          return o;
        }),
      },

      // ----- userSession -----
      userSession: {
        create: vi.fn(async ({ data }: any) => {
          const row: SessionRow = {
            id: crypto.randomUUID(),
            userId: data.userId,
            refreshTokenHash: data.refreshTokenHash,
            userAgent: data.userAgent ?? null,
            expiresAt: data.expiresAt,
            revokedAt: null,
            createdAt: new Date(),
          };
          db.sessions.set(row.refreshTokenHash, row);
          return row;
        }),
        findUnique: vi.fn(async ({ where }: any) => {
          return db.sessions.get(where.refreshTokenHash) ?? null;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const row = [...db.sessions.values()].find((s) => s.id === where.id);
          if (!row) throw new Error("Session not found");
          if (data.revokedAt !== undefined) row.revokedAt = data.revokedAt;
          return row;
        }),
      },

      // ----- match -----
      match: {
        findUnique: vi.fn(async ({ where, select }: any) => {
          const m = db.matches.get(where.id);
          if (!m) return null;
          if (select) return matchSelect(m, select);
          return m;
        }),
        findFirst: vi.fn(async ({ where, select }: any) => {
          const list = [...db.matches.values()];
          const statusFilter = (where.status?.in as string[]) ?? null;
          const idIsUserA = (m: MatchRow, uid: string) => m.userAId === uid;
          const idIsUserB = (m: MatchRow, uid: string) => m.userBId === uid;
          const uid = where.OR?.[0]?.userAId as string | undefined;
          const hit =
            list.find(
              (m) =>
                (!statusFilter || statusFilter.includes(m.status)) &&
                (idIsUserA(m, uid ?? "") || idIsUserB(m, uid ?? "")),
            ) ?? null;
          if (!hit) return null;
          if (select) return matchSelect(hit, select);
          return hit;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const m = db.matches.get(where.id);
          if (!m) throw new Error("Match not found");
          Object.assign(m, applyData(data));
          return m;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          const list = [...db.matches.values()].filter(
            (m) => m.id === where.id && m.status === where.status,
          );
          for (const m of list) Object.assign(m, applyData(data));
          return { count: list.length };
        }),
      },

      // ----- report -----
      report: {
        create: vi.fn(async ({ data }: any) => {
          const dup = db.reports.find(
            (r) =>
              r.reporterId === data.reporterId && r.matchId === data.matchId,
          );
          if (dup) {
            throw new PrismaClientKnownRequestError(
              "Unique constraint failed",
              "P2002",
              { target: ["reporter_id", "match_id"] },
            );
          }
          const row: ReportRow = {
            id: crypto.randomUUID(),
            reporterId: data.reporterId,
            reportedId: data.reportedId,
            matchId: data.matchId,
            rawText: data.rawText,
            tier: data.tier,
            reasonSummary: data.reasonSummary ?? null,
            adminReviewed: data.adminReviewed ?? false,
            createdAt: new Date(),
          };
          db.reports.push(row);
          return row;
        }),
      },

      // ----- profile -----
      profile: {
        upsert: vi.fn(async ({ where, create, update }: any) => {
          const u = userById(where.userId);
          if (!u) throw new Error("User not found");
          if (u.profile) {
            Object.assign(u.profile, update);
            return u.profile;
          }
          const row: ProfileRow = {
            id: crypto.randomUUID(),
            userId: where.userId,
            hobbies: create.hobbies ?? [],
            partnerPreferences: create.partnerPreferences ?? null,
            psychologicalSummary: null,
            ageRangeMin: null,
            ageRangeMax: null,
            photos: [],
            matchRadius: create.matchRadius ?? "campus_only",
          };
          u.profile = row;
          return row;
        }),
      },
    },
  };

  function pickSelect(obj: any, select: any): any {
    const out: any = {};
    for (const k of Object.keys(select)) {
      if (select[k] === true) out[k] = obj[k];
      else if (typeof select[k] === "object" && select[k].select) {
        out[k] = pickSelect(obj[k] ?? {}, select[k].select);
      }
    }
    return out;
  }

  function matchSelect(m: MatchRow, select: any): any {
    const out: any = {};
    for (const k of Object.keys(select)) {
      if (k === "userA" || k === "userB") {
        const uid = k === "userA" ? m.userAId : m.userBId;
        const u = db.users.get(uid);
        out[k] = u ? pickSelect(u, select[k].select) : null;
      } else if (select[k] === true) {
        out[k] = (m as any)[k];
      }
    }
    return out;
  }

  function applyData(data: any): any {
    const out: any = {};
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === "object" && "increment" in v) {
        // defer to caller (unused in our mocks besides otp.attempts)
        continue;
      }
      out[k] = v;
    }
    return out;
  }
});

// ---------------------------------------------------------------------------
// 3. Stub heavy external services: email (Resend), push, vision, vibe parse,
//    onboarding agent, assistant agent. These all already have fallbacks for
//    missing keys; we just short-circuit to keep tests deterministic.
// ---------------------------------------------------------------------------

vi.mock("../services/email.js", () => ({
  sendOtpEmail: vi.fn(async (_to: string, _code: string) => {
    // no-op in tests
  }),
}));

vi.mock("../services/push.js", () => ({
  sendPushToUser: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../services/onboarding-agent.js", () => ({
  runAgentTurn: vi.fn(async (_tgId: bigint, text: string) => ({
    reply: `echo:${text}`,
    expectingPhoto: false,
    onboardingComplete: false,
    contextPromptRequested: false,
    contextDumpStarted: false,
  })),
}));

vi.mock("../services/menu-agent.js", () => ({
  runMenuAgentTurn: vi.fn(async (_tgId: bigint, text: string) => ({
    reply: `menu:${text}`,
  })),
}));

vi.mock("../services/whisper.js", () => ({
  WHISPER_MAX_BYTES: 25 * 1024 * 1024,
  transcribeVoice: vi.fn(async () => "transcribed"),
}));

vi.mock("../services/vision/validate-face.js", () => ({
  validateSingleFaceFromBuffer: vi.fn(async () => ({ ok: true, valid: true })),
}));

vi.mock("../services/storage.js", () => ({
  uploadSelfie: vi.fn(async (userId: string) => ({
    path: `${userId}/fake.jpg`,
  })),
}));

vi.mock("../services/vibe-parser.js", () => ({
  parseVibe: vi.fn(async () => ({
    category: "cafe",
    keywords: [],
    safe: true,
  })),
  mergeParsed: vi.fn((a: any) => ({
    category: a.category,
    keywords: a.keywords,
  })),
}));

vi.mock("../services/geo.js", () => ({
  midpoint: vi.fn((_a: any, _b: any) => ({ lat: 0.5, lng: 0.5 })),
  haversineDistanceKm: vi.fn(() => 1),
  venueSearchRadiusMeters: vi.fn(() => 1000),
}));

vi.mock("../services/venue.js", () => ({
  pickVenueAtMidpoint: vi.fn(async () => ({
    name: "Test Cafe",
    address: "123 Test St",
  })),
}));

vi.mock("../handlers/matching/negative-constraints.js", () => ({
  appendNegativeConstraint: vi.fn(async () => undefined),
}));

vi.mock("../services/moderation.js", () => ({
  applyReportAction: vi.fn(async () => ({ kind: "tier2_warning", strikes: 1 })),
}));

// next-batch is used by /v1/countdown — don't mock, it's pure.

// ---------------------------------------------------------------------------
// 4. Import the app AFTER mocks are installed.
// ---------------------------------------------------------------------------

const { app } = await import("./server.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function signAccess(userId: string): string {
  return jwt.sign(
    { sub: userId, typ: "access" },
    "test-jwt-secret-not-for-production",
    { expiresIn: "15m" },
  );
}

async function seedUser(overrides: Partial<UserRow> = {}): Promise<UserRow> {
  const id = overrides.id ?? crypto.randomUUID();
  const row: UserRow = {
    id,
    telegramId: overrides.telegramId ?? -BigInt(Math.floor(Math.random() * 1e12)),
    email: overrides.email ?? `user-${id.slice(0, 6)}@stanford.edu`,
    universityDomain: "stanford.edu",
    firstName: overrides.firstName ?? "Alice",
    surname: null,
    age: overrides.age ?? 22,
    gender: overrides.gender ?? "female",
    preference: overrides.preference ?? "men",
    major: null,
    language: "en",
    status: overrides.status ?? "active",
    onboardingStep: overrides.onboardingStep ?? "completed",
    platform: "mobile",
    pushToken: null,
    pushPlatform: null,
    verificationStatus: "unverified",
    selfiePath: null,
    messageHistory: overrides.messageHistory ?? [],
    profile: overrides.profile ?? null,
    ...overrides,
  };
  db.users.set(id, row);
  return row;
}

async function seedMatch(
  userAId: string,
  userBId: string,
  overrides: Partial<MatchRow> = {},
): Promise<MatchRow> {
  const id = overrides.id ?? crypto.randomUUID();
  const row: MatchRow = {
    id,
    userAId,
    userBId,
    status: "proposed",
    pitchForA: "Hi Alice",
    pitchForB: "Hi Bob",
    iceBreakersA: [],
    iceBreakersB: [],
    agreedTime: null,
    venueName: null,
    venueAddress: null,
    venueLat: null,
    venueLng: null,
    acceptedByA: null,
    acceptedByB: null,
    vibeTextA: null,
    vibeTextB: null,
    vibeLatA: null,
    vibeLngA: null,
    vibeLatB: null,
    vibeLngB: null,
    parsedCategoryA: null,
    parsedCategoryB: null,
    venuePromptAskedAt: null,
    safetyAckA: false,
    safetyAckB: false,
    createdAt: new Date(),
    ...overrides,
  };
  db.matches.set(id, row);
  return row;
}

// ---------------------------------------------------------------------------
// Tests — liveness + contract shape
// ---------------------------------------------------------------------------

describe("GET /v1/ping", () => {
  it("returns ok + iso timestamp without auth", async () => {
    const res = await request(app).get("/v1/ping");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(() => new Date(res.body.now)).not.toThrow();
  });
});

describe("POST /v1/auth/otp/request", () => {
  beforeEach(resetDb);

  it("rejects non-university email shape", async () => {
    const res = await request(app)
      .post("/v1/auth/otp/request")
      .send({ email: "me@gmail.com" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Invalid/i);
  });

  it("accepts .edu and persists a bcrypt-hashed OTP", async () => {
    const res = await request(app)
      .post("/v1/auth/otp/request")
      .send({ email: "fresh-request@stanford.edu" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // DB state
    expect(db.otps).toHaveLength(1);
    expect(db.otps[0].codeHash.startsWith("$2")).toBe(true); // bcrypt prefix
    // Never leaks the code to the caller
    expect(res.body).not.toHaveProperty("code");
    expect(res.body).not.toHaveProperty("otp");
  });

  it("accepts .ac.uk (backend is more permissive than the mobile regex)", async () => {
    // HYPOTHESIS: `gennety-mobile/app/(auth)/email.tsx` uses
    // `/@[^@]+\.edu$/i` which REJECTS valid .ac.uk addresses the backend
    // would otherwise accept. Verified here by poking the backend directly —
    // mobile users with UK emails are blocked client-side.
    const res = await request(app)
      .post("/v1/auth/otp/request")
      .send({ email: "student@cam.ac.uk" });
    expect(res.status).toBe(200);
    const mobileRegex = /@[^@]+\.edu$/i;
    expect(mobileRegex.test("student@cam.ac.uk")).toBe(false);
  });
});

describe("POST /v1/auth/otp/verify", () => {
  beforeEach(resetDb);

  async function seedOtp(email: string, code: string): Promise<void> {
    const codeHash = await bcrypt.hash(code, 4); // low cost for speed
    db.otps.push({
      id: crypto.randomUUID(),
      email: email.toLowerCase(),
      codeHash,
      expiresAt: new Date(Date.now() + 10 * 60_000),
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(),
    });
  }

  it("rejects wrong code with 401 and increments attempts", async () => {
    const email = "verify-wrong@stanford.edu";
    await seedOtp(email, "123456");
    const res = await request(app)
      .post("/v1/auth/otp/verify")
      .send({ email, otp: "000000" });
    expect(res.status).toBe(401);
    expect(db.otps[0].attempts).toBe(1);
  });

  it("mints access + refresh tokens on match, creates user row", async () => {
    const email = "verify-ok@mit.edu";
    await seedOtp(email, "654321");
    const res = await request(app)
      .post("/v1/auth/otp/verify")
      .send({ email, otp: "654321" });
    expect(res.status).toBe(200);
    expect(typeof res.body.accessToken).toBe("string");
    expect(typeof res.body.refreshToken).toBe("string");
    expect(res.body.expiresIn).toBeGreaterThan(0);
    // User was created with onboardingStep=consent
    const user = [...db.users.values()].find((u) => u.email === email);
    expect(user).toBeDefined();
    expect(user?.onboardingStep).toBe("consent");
    expect(user?.platform).toBe("mobile");
    expect(user?.telegramId).toBeLessThan(0n); // synthetic negative
    // Access token payload is correct
    const decoded = jwt.verify(
      res.body.accessToken,
      "test-jwt-secret-not-for-production",
    ) as { sub: string; typ: string };
    expect(decoded.typ).toBe("access");
    expect(decoded.sub).toBe(user?.id);
    // Refresh token is persisted as sha256 hash
    const hash = crypto
      .createHash("sha256")
      .update(res.body.refreshToken)
      .digest("hex");
    expect(db.sessions.has(hash)).toBe(true);
    // OTP consumed
    expect(db.otps[0].consumedAt).toBeTruthy();
  });

  it("rejects malformed OTPs with 400 (not 401)", async () => {
    const email = "verify-bad@stanford.edu";
    await seedOtp(email, "123456");
    const res = await request(app)
      .post("/v1/auth/otp/verify")
      .send({ email, otp: "not-a-number" });
    expect(res.status).toBe(400);
  });
});

describe("POST /v1/auth/refresh", () => {
  beforeEach(resetDb);

  it("rotates both tokens and revokes the old session", async () => {
    const user = await seedUser();
    const raw = crypto.randomBytes(48).toString("base64url");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    db.sessions.set(hash, {
      id: crypto.randomUUID(),
      userId: user.id,
      refreshTokenHash: hash,
      userAgent: "supertest",
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
      revokedAt: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .post("/v1/auth/refresh")
      .send({ refreshToken: raw });
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.refreshToken).toBeTruthy();
    expect(res.body.refreshToken).not.toBe(raw);
    // Old session revoked
    expect(db.sessions.get(hash)?.revokedAt).toBeInstanceOf(Date);
    // New session persisted
    const nextHash = crypto
      .createHash("sha256")
      .update(res.body.refreshToken)
      .digest("hex");
    expect(db.sessions.has(nextHash)).toBe(true);
  });

  it("rejects an already-revoked refresh token", async () => {
    const user = await seedUser();
    const raw = crypto.randomBytes(48).toString("base64url");
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    db.sessions.set(hash, {
      id: crypto.randomUUID(),
      userId: user.id,
      refreshTokenHash: hash,
      userAgent: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(), // already revoked
      createdAt: new Date(),
    });
    const res = await request(app)
      .post("/v1/auth/refresh")
      .send({ refreshToken: raw });
    expect(res.status).toBe(401);
  });

  it("rejects missing refreshToken with 400", async () => {
    const res = await request(app).post("/v1/auth/refresh").send({});
    expect(res.status).toBe(400);
  });
});

describe("GET /v1/me", () => {
  beforeEach(resetDb);

  it("401 without bearer token", async () => {
    const res = await request(app).get("/v1/me");
    expect(res.status).toBe(401);
  });

  it("401 with a random garbage bearer", async () => {
    const res = await request(app)
      .get("/v1/me")
      .set("Authorization", "Bearer not-a-jwt");
    expect(res.status).toBe(401);
  });

  it("returns serialized user + null profile for a fresh user", async () => {
    const user = await seedUser({ profile: null });
    const res = await request(app)
      .get("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.user.id).toBe(user.id);
    expect(res.body.user.email).toBe(user.email);
    // Never leaks sensitive/internal fields
    expect(res.body.user).not.toHaveProperty("telegramId");
    expect(res.body.user).not.toHaveProperty("messageHistory");
    expect(res.body.profile).toBeNull();
  });
});

describe("PATCH /v1/me/preferences", () => {
  beforeEach(resetDb);

  it("rejects invalid matchRadius", async () => {
    const user = await seedUser();
    const res = await request(app)
      .patch("/v1/me/preferences")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ matchRadius: "worldwide" });
    expect(res.status).toBe(400);
  });

  it("persists campus_only / citywide", async () => {
    const user = await seedUser();
    const res = await request(app)
      .patch("/v1/me/preferences")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ matchRadius: "citywide" });
    expect(res.status).toBe(200);
    expect(res.body.profile.matchRadius).toBe("citywide");
  });
});

describe("POST /v1/me/push-token", () => {
  beforeEach(resetDb);

  it("requires a non-empty token", async () => {
    const user = await seedUser();
    const res = await request(app)
      .post("/v1/me/push-token")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ token: "" });
    expect(res.status).toBe(400);
  });

  it("stores token + platform", async () => {
    const user = await seedUser();
    const res = await request(app)
      .post("/v1/me/push-token")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ token: "ExponentPushToken[abc]", platform: "ios" });
    expect(res.status).toBe(200);
    const stored = userById(user.id)!;
    expect(stored.pushToken).toBe("ExponentPushToken[abc]");
    expect(stored.pushPlatform).toBe("ios");
  });
});

describe("/v1/onboarding/interview", () => {
  beforeEach(resetDb);

  it("GET returns current state with stepIndex + totalSteps", async () => {
    const user = await seedUser({
      onboardingStep: "conversational",
      messageHistory: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "How old are you?" },
      ],
    });
    const res = await request(app)
      .get("/v1/onboarding/interview")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.totalSteps).toBe(4);
    expect(res.body.stepIndex).toBe(2);
    expect(res.body.question).toBe("How old are you?");
    expect(res.body.completed).toBe(false);
  });

  it("POST /answer 400s on empty text", async () => {
    const user = await seedUser({ onboardingStep: "conversational" });
    const res = await request(app)
      .post("/v1/onboarding/interview/answer")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ text: "" });
    expect(res.status).toBe(400);
  });

  it("POST /answer invokes the agent and returns reply", async () => {
    const user = await seedUser({ onboardingStep: "conversational" });
    const res = await request(app)
      .post("/v1/onboarding/interview/answer")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ text: "Alice, 22" });
    expect(res.status).toBe(200);
    expect(res.body.question).toBe("echo:Alice, 22");
  });
});

describe("/v1/assistant/ask", () => {
  beforeEach(resetDb);

  it("409s if onboarding is not completed", async () => {
    const user = await seedUser({ onboardingStep: "conversational" });
    const res = await request(app)
      .post("/v1/assistant/ask")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ text: "hi" });
    expect(res.status).toBe(409);
  });

  it("returns a reply when onboarding is completed", async () => {
    const user = await seedUser({ onboardingStep: "completed" });
    const res = await request(app)
      .post("/v1/assistant/ask")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ text: "change my radius" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("menu:change my radius");
  });
});

describe("/v1/matches/*", () => {
  beforeEach(resetDb);

  it("GET /current returns null when the user has no match", async () => {
    const user = await seedUser();
    const res = await request(app)
      .get("/v1/matches/current")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body).toBeNull();
  });

  it("POST /:id/decision declines → cancels (and surfaces 404 since getCurrentMatchForUser returns null)", async () => {
    // QUIRK: `applyMatchDecision` returns `getCurrentMatchForUser(userId)`
    // after persisting the decline. That helper filters out `cancelled`
    // matches, so it returns `null`, and the route handler maps `null` to
    // 404. The side-effect (status flip) still happens — the mobile client
    // in `gennety-mobile/src/api/matches.ts` papers over this by refetching
    // /current on any non-2xx. Worth flagging: the route can't distinguish
    // "you just declined" from "match not found."
    const alice = await seedUser({ firstName: "Alice" });
    const bob = await seedUser({ firstName: "Bob" });
    const match = await seedMatch(alice.id, bob.id, { status: "proposed" });
    const res = await request(app)
      .post(`/v1/matches/${match.id}/decision`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ decision: "decline" });
    expect(res.status).toBe(404);
    expect(db.matches.get(match.id)?.status).toBe("cancelled");
    expect(db.matches.get(match.id)?.acceptedByA).toBe(false);
  });

  it("POST /:id/decision with both accepts → negotiating + push to peer", async () => {
    const { sendPushToUser } = await import("../services/push.js");
    const alice = await seedUser({ firstName: "Alice" });
    const bob = await seedUser({ firstName: "Bob" });
    const match = await seedMatch(alice.id, bob.id, {
      status: "proposed",
      acceptedByB: true,
    });
    const res = await request(app)
      .post(`/v1/matches/${match.id}/decision`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ decision: "accept" });
    expect(res.status).toBe(200);
    expect(db.matches.get(match.id)?.status).toBe("negotiating");
    expect(sendPushToUser).toHaveBeenCalledWith(
      bob.id,
      expect.objectContaining({ data: expect.objectContaining({ matchId: match.id }) }),
    );
  });

  it("POST /:id/decision 400s on invalid decision", async () => {
    const user = await seedUser();
    const res = await request(app)
      .post(`/v1/matches/${crypto.randomUUID()}/decision`)
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ decision: "maybe" });
    expect(res.status).toBe(400);
  });

  it("POST /:id/vibe-location validates lat/lng range", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "negotiating" });

    const outOfRange = await request(app)
      .post(`/v1/matches/${match.id}/vibe-location`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ vibe: "coffee", lat: 91, lng: 0 });
    expect(outOfRange.status).toBe(400);

    const badVibe = await request(app)
      .post(`/v1/matches/${match.id}/vibe-location`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ vibe: "hotel", lat: 0, lng: 0 });
    expect(badVibe.status).toBe(400);

    const ok = await request(app)
      .post(`/v1/matches/${match.id}/vibe-location`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ vibe: "coffee", lat: 37.4, lng: -122.1 });
    expect(ok.status).toBe(200);
    const saved = db.matches.get(match.id)!;
    expect(saved.vibeTextA).toBe("cafe");
    expect(saved.vibeLatA).toBe(37.4);
    expect(saved.status).toBe("negotiating_venue");
  });

  it("POST /:id/report enforces IDOR: non-participant is 403", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const eve = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "proposed" });
    const res = await request(app)
      .post(`/v1/matches/${match.id}/report`)
      .set("Authorization", `Bearer ${signAccess(eve.id)}`)
      .send({ category: "tier1_disappointment", message: "not my vibe" });
    expect(res.status).toBe(403);
    expect(db.reports).toHaveLength(0);
  });

  it("POST /:id/report rejects duplicate report from same reporter", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "proposed" });

    const first = await request(app)
      .post(`/v1/matches/${match.id}/report`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ category: "tier2_ghosting", message: "ghosted" });
    expect(first.status).toBe(204);

    const dup = await request(app)
      .post(`/v1/matches/${match.id}/report`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ category: "tier2_ghosting", message: "ghosted" });
    expect(dup.status).toBe(409);
  });

  it("POST /:id/safety-ack flips only the caller's side", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "scheduled" });
    const res = await request(app)
      .post(`/v1/matches/${match.id}/safety-ack`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`);
    expect(res.status).toBe(200);
    const saved = db.matches.get(match.id)!;
    expect(saved.safetyAckA).toBe(true);
    expect(saved.safetyAckB).toBe(false);
  });
});

describe("GET /v1/countdown", () => {
  beforeEach(resetDb);

  it("requires auth", async () => {
    const res = await request(app).get("/v1/countdown");
    expect(res.status).toBe(401);
  });

  it("returns ISO timestamps for nextDropAt + serverNow", async () => {
    const user = await seedUser();
    const res = await request(app)
      .get("/v1/countdown")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(() => new Date(res.body.nextDropAt)).not.toThrow();
    expect(() => new Date(res.body.serverNow)).not.toThrow();
    expect(new Date(res.body.nextDropAt).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
