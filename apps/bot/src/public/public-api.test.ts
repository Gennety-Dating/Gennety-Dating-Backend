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
    SUPABASE_PHOTO_BUCKET: "profile-photos",
    SUPABASE_CHAT_BUCKET: "chat-attachments",
    // Face-match gate (Step 4) — `disabled` skips the Rekognition call.
    // Tests that need to exercise mismatch behavior override this.
    FACE_MATCH_PROVIDER: "disabled",
    FACE_MATCH_THRESHOLD_VERIFY: 0.85,
    FACE_MATCH_THRESHOLD_REVIEW: 0.75,
    AWS_REGION: "eu-central-1",
    AWS_ACCESS_KEY_ID: "",
    AWS_SECRET_ACCESS_KEY: "",
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
  standbyCount?: number;
  lastMissedAt?: Date | null;
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
  wingmanHintA: string | null;
  wingmanHintB: string | null;
  wingmanSentAt: Date | null;
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

type MatchEventRow = {
  id: string;
  matchId: string;
  actorId: string;
  targetId: string;
  actionType: string;
  metadata: Record<string, unknown> | null;
  createdAt: Date;
};

type MessageRow = {
  id: string;
  userId: string;
  role: string;
  content: string;
  imageUrl: string | null;
  createdAt: Date;
};

const db = {
  users: new Map<string, UserRow>(),
  otps: [] as OtpRow[],
  sessions: new Map<string, SessionRow>(),
  matches: new Map<string, MatchRow>(),
  reports: [] as ReportRow[],
  matchEvents: [] as MatchEventRow[],
  messages: [] as MessageRow[],
};

function resetDb(): void {
  db.users.clear();
  db.otps.length = 0;
  db.sessions.clear();
  db.matches.clear();
  db.reports.length = 0;
  db.matchEvents.length = 0;
  db.messages.length = 0;
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
  meta: { target?: string[] } | undefined;
  constructor(message: string, code: string, meta?: { target?: string[] }) {
    super(message);
    this.code = code;
    this.meta = meta;
  }
}

vi.mock("@gennety/db", async () => {
  const prismaMock: any = {
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
        delete: vi.fn(async ({ where }: any) => {
          const u = findUser(where);
          if (!u) {
            throw new PrismaClientKnownRequestError(
              "Record to delete does not exist.",
              "P2025",
            );
          }
          db.users.delete(u.id);
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
        // C-5: revokeAllSessions uses updateMany to nuke a user's session set
        // when token-replay is detected.
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const s of db.sessions.values()) {
            const matchesUserId = where.userId === undefined || s.userId === where.userId;
            const matchesId = where.id === undefined || s.id === where.id;
            const matchesRevokedAt =
              where.revokedAt === undefined || s.revokedAt === where.revokedAt;
            if (!matchesUserId || !matchesId || !matchesRevokedAt) continue;
            if (data.revokedAt !== undefined) s.revokedAt = data.revokedAt;
            count++;
          }
          return { count };
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
          const list = [...db.matches.values()].filter((m) => {
            const idMatches = where.id === undefined || m.id === where.id;
            const statusMatches =
              where.status === undefined ||
              (typeof where.status === "string" && m.status === where.status) ||
              (where.status?.in && where.status.in.includes(m.status));
            const userMatches =
              !where.OR ||
              where.OR.some((clause: any) => clause.userAId === m.userAId || clause.userBId === m.userBId);
            return idMatches && statusMatches && userMatches;
          });
          for (const m of list) Object.assign(m, applyData(data));
          return { count: list.length };
        }),
      },

      // ----- matchEvent -----
      matchEvent: {
        create: vi.fn(async ({ data }: any) => {
          const row: MatchEventRow = {
            id: crypto.randomUUID(),
            matchId: data.matchId,
            actorId: data.actorId,
            targetId: data.targetId,
            actionType: data.actionType,
            metadata: data.metadata ?? null,
            createdAt: new Date(),
          };
          db.matchEvents.push(row);
          return row;
        }),
        updateMany: vi.fn(async ({ where, data }: any) => {
          let count = 0;
          for (const row of db.matchEvents) {
            if (
              row.matchId === where.matchId &&
              row.actorId === where.actorId &&
              row.targetId === where.targetId &&
              row.actionType === where.actionType
            ) {
              row.metadata = data.metadata;
              count += 1;
            }
          }
          return { count };
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

      // ----- message -----
      message: {
        findMany: vi.fn(async ({ where, select }: any) => {
          const rows = db.messages.filter((row) => {
            if (where.userId !== undefined && row.userId !== where.userId) return false;
            if (where.imageUrl?.not === null && row.imageUrl === null) return false;
            return true;
          });
          if (!select) return rows;
          return rows.map((row) => pickSelect(row, select));
        }),
      },

      // ----- profile -----
      profile: {
        findUnique: vi.fn(async ({ where, select }: any) => {
          const u = userById(where.userId);
          if (!u?.profile) return null;
          if (select) {
            const out: any = {};
            for (const k of Object.keys(select)) {
              if (select[k] === true) out[k] = (u.profile as any)[k];
            }
            return out;
          }
          return u.profile;
        }),
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
            psychologicalSummary: create.psychologicalSummary ?? null,
            ageRangeMin: create.ageRangeMin ?? null,
            ageRangeMax: create.ageRangeMax ?? null,
            photos: create.photos ?? [],
            matchRadius: create.matchRadius ?? "campus_only",
            standbyCount: create.standbyCount ?? 0,
            lastMissedAt: create.lastMissedAt ?? null,
          };
          u.profile = row;
          return row;
        }),
        update: vi.fn(async ({ where, data }: any) => {
          const u = userById(where.userId);
          if (!u?.profile) {
            throw new PrismaClientKnownRequestError(
              "Profile to update does not exist.",
              "P2025",
            );
          }
          Object.assign(u.profile, data);
          return u.profile;
        }),
      },
  };

  function snapshotDb() {
    return {
      users: new Map(
        [...db.users.entries()].map(([key, value]) => [key, structuredClone(value)]),
      ),
      otps: structuredClone(db.otps),
      sessions: new Map(
        [...db.sessions.entries()].map(([key, value]) => [key, structuredClone(value)]),
      ),
      matches: new Map(
        [...db.matches.entries()].map(([key, value]) => [key, structuredClone(value)]),
      ),
      reports: structuredClone(db.reports),
      matchEvents: structuredClone(db.matchEvents),
      messages: structuredClone(db.messages),
    };
  }

  function restoreDb(snapshot: ReturnType<typeof snapshotDb>): void {
    db.users = snapshot.users;
    db.otps = snapshot.otps;
    db.sessions = snapshot.sessions;
    db.matches = snapshot.matches;
    db.reports = snapshot.reports;
    db.matchEvents = snapshot.matchEvents;
    db.messages = snapshot.messages;
  }

  prismaMock.$transaction = vi.fn(async (ops: unknown) => {
    if (Array.isArray(ops)) return Promise.all(ops);
    if (typeof ops !== "function") {
      throw new Error("Unsupported $transaction shape");
    }
    const snapshot = snapshotDb();
    try {
      return await ops(prismaMock);
    } catch (err) {
      restoreDb(snapshot);
      throw err;
    }
  });

  return {
    Prisma: { PrismaClientKnownRequestError },
    prisma: prismaMock,
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
  uploadProfilePhoto: vi.fn(async (userId: string) => ({
    path: `${userId}/photo-${Date.now()}.jpg`,
  })),
  createSelfieSignedUrl: vi.fn(async (path: string) => `https://signed.test/${path}`),
  createProfilePhotoSignedUrl: vi.fn(
    async (path: string) => `https://signed.test/photo/${path}`,
  ),
  deleteStorageObject: vi.fn(async () => true),
  // Step 4 face-match gate fetches the verified selfie before comparing.
  // Tests that don't seed `verifiedSelfiePath` short-circuit the gate
  // before this is called; we still need it to exist on the mock so the
  // import resolves.
  downloadSelfie: vi.fn(async () => null),
  downloadProfilePhoto: vi.fn(async () => Buffer.from("photo-bytes")),
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
    wingmanHintA: null,
    wingmanHintB: null,
    wingmanSentAt: null,
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

  it("rejects an already-revoked refresh token AND nukes sibling sessions (C-5 reuse defense)", async () => {
    const user = await seedUser();
    // Set up: user has 1 already-revoked session (the leaked token) + 2
    // active sessions on other devices.
    const stolenRaw = crypto.randomBytes(48).toString("base64url");
    const stolenHash = crypto.createHash("sha256").update(stolenRaw).digest("hex");
    db.sessions.set(stolenHash, {
      id: crypto.randomUUID(),
      userId: user.id,
      refreshTokenHash: stolenHash,
      userAgent: null,
      expiresAt: new Date(Date.now() + 86_400_000),
      revokedAt: new Date(), // already revoked — looks like reuse
      createdAt: new Date(),
    });
    const liveHashes: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = crypto.randomBytes(48).toString("base64url");
      const h = crypto.createHash("sha256").update(r).digest("hex");
      liveHashes.push(h);
      db.sessions.set(h, {
        id: crypto.randomUUID(),
        userId: user.id,
        refreshTokenHash: h,
        userAgent: null,
        expiresAt: new Date(Date.now() + 86_400_000),
        revokedAt: null,
        createdAt: new Date(),
      });
    }

    const res = await request(app)
      .post("/v1/auth/refresh")
      .send({ refreshToken: stolenRaw });
    expect(res.status).toBe(401);

    // Reuse-detection: every active session for the user is now revoked.
    for (const h of liveHashes) {
      expect(db.sessions.get(h)?.revokedAt).toBeInstanceOf(Date);
    }
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

describe("PATCH /v1/me", () => {
  beforeEach(resetDb);

  function seedProfile(userId: string, overrides: Partial<ProfileRow> = {}): ProfileRow {
    const row: ProfileRow = {
      id: crypto.randomUUID(),
      userId,
      hobbies: [],
      partnerPreferences: null,
      psychologicalSummary: null,
      ageRangeMin: null,
      ageRangeMax: null,
      photos: [],
      matchRadius: "campus_only",
      ...overrides,
    };
    const u = db.users.get(userId)!;
    u.profile = row;
    return row;
  }

  it("401 without auth", async () => {
    const res = await request(app).patch("/v1/me").send({});
    expect(res.status).toBe(401);
  });

  it("updates major + profile fields in a single transaction", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({
        major: "Computer Science",
        profile: {
          hobbies: ["reading", "hiking"],
          partnerPreferences: "kind + curious",
          psychologicalSummary: "INTP-ish",
          ageRangeMin: 20,
          ageRangeMax: 28,
        },
      });
    expect(res.status).toBe(200);
    expect(res.body.user.major).toBe("Computer Science");
    expect(res.body.profile.hobbies).toEqual(["reading", "hiking"]);
    expect(res.body.profile.partnerPreferences).toBe("kind + curious");
    expect(res.body.profile.psychologicalSummary).toBe("INTP-ish");
    expect(res.body.profile.ageRangeMin).toBe(20);
    expect(res.body.profile.ageRangeMax).toBe(28);
    // DB persisted
    const stored = userById(user.id)!;
    expect(stored.major).toBe("Computer Science");
    expect(stored.profile?.hobbies).toEqual(["reading", "hiking"]);
  });

  it("silently ignores fixed identity fields (firstName, age, status, email, photos)", async () => {
    const user = await seedUser({ firstName: "Alice", age: 22, status: "active" });
    seedProfile(user.id, { photos: ["keep-me.jpg"] });
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({
        firstName: "Eve",
        surname: "Hacker",
        age: 99,
        status: "banned",
        email: "evil@stanford.edu",
        universityDomain: "evil.edu",
        gender: "male",
        preference: "both",
        matchRadius: "citywide",
        profile: { photos: ["replace-me.jpg"] },
        major: "Math",
      });
    expect(res.status).toBe(200);
    const stored = userById(user.id)!;
    expect(stored.firstName).toBe("Alice");
    expect(stored.surname).toBeNull();
    expect(stored.age).toBe(22);
    expect(stored.status).toBe("active");
    expect(stored.email).toBe(user.email);
    expect(stored.universityDomain).toBe("stanford.edu");
    expect(stored.gender).toBe("female");
    expect(stored.preference).toBe("men");
    expect(stored.profile?.photos).toEqual(["keep-me.jpg"]);
    expect(stored.profile?.matchRadius).toBe("campus_only");
    // The allowed field still applies:
    expect(stored.major).toBe("Math");
  });

  it("400 when major exceeds 100 chars", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ major: "x".repeat(101) });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Field too long: major");
  });

  it("400 when a single hobby exceeds 50 chars", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ profile: { hobbies: ["x".repeat(51)] } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Field too long: hobbies");
  });

  it("400 when hobbies array exceeds 10 entries", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ profile: { hobbies: new Array(11).fill("a") } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Field too long: hobbies");
  });

  it("400 when ageRangeMin > ageRangeMax", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ profile: { ageRangeMin: 30, ageRangeMax: 25 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid age range");
  });

  it("400 when ageRangeMin < MIN_AGE (18)", async () => {
    const user = await seedUser();
    seedProfile(user.id);
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ profile: { ageRangeMin: 17 } });
    expect(res.status).toBe(400);
  });

  it("accepts null for nullable fields (clears them)", async () => {
    const user = await seedUser();
    seedProfile(user.id, {
      ageRangeMin: 20,
      ageRangeMax: 30,
      partnerPreferences: "old",
    });
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({
        major: null,
        profile: {
          partnerPreferences: null,
          psychologicalSummary: null,
          ageRangeMin: null,
          ageRangeMax: null,
        },
      });
    expect(res.status).toBe(200);
    const stored = userById(user.id)!;
    expect(stored.major).toBeNull();
    expect(stored.profile?.partnerPreferences).toBeNull();
    expect(stored.profile?.ageRangeMin).toBeNull();
    expect(stored.profile?.ageRangeMax).toBeNull();
  });

  it("creates a profile row when the user has none yet (upsert path)", async () => {
    const user = await seedUser({ profile: null });
    expect(userById(user.id)?.profile).toBeNull();
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({ profile: { hobbies: ["new"] } });
    expect(res.status).toBe(200);
    expect(res.body.profile.hobbies).toEqual(["new"]);
    expect(userById(user.id)?.profile?.hobbies).toEqual(["new"]);
  });

  it("empty body is a no-op that returns current state", async () => {
    const user = await seedUser();
    seedProfile(user.id, { hobbies: ["yoga"] });
    const res = await request(app)
      .patch("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .send({});
    expect(res.status).toBe(200);
    expect(res.body.profile.hobbies).toEqual(["yoga"]);
  });
});

describe("DELETE /v1/me", () => {
  beforeEach(resetDb);

  it("401 without auth", async () => {
    const res = await request(app).delete("/v1/me");
    expect(res.status).toBe(401);
  });

  it("removes the user row and returns 204", async () => {
    const user = await seedUser();
    const res = await request(app)
      .delete("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(204);
    expect(db.users.get(user.id)).toBeUndefined();
  });

  it("best-effort cleans up selfie + photo storage paths", async () => {
    const { deleteStorageObject } = await import("../services/storage.js");
    const user = await seedUser({ selfiePath: "u/selfie.jpg" });
    const u = db.users.get(user.id)!;
    u.profile = {
      id: crypto.randomUUID(),
      userId: user.id,
      hobbies: [],
      partnerPreferences: null,
      psychologicalSummary: null,
      ageRangeMin: null,
      ageRangeMax: null,
      photos: ["u/p1.jpg", "u/p2.jpg"],
      matchRadius: "campus_only",
    };
    const res = await request(app)
      .delete("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(204);
    expect(deleteStorageObject).toHaveBeenCalledWith("selfies", "u/selfie.jpg");
    expect(deleteStorageObject).toHaveBeenCalledWith(
      "profile-photos",
      "u/p1.jpg",
    );
    expect(deleteStorageObject).toHaveBeenCalledWith(
      "profile-photos",
      "u/p2.jpg",
    );
  });

  it("also cleans up chat attachment storage paths", async () => {
    const { deleteStorageObject } = await import("../services/storage.js");
    const user = await seedUser();
    db.messages.push({
      id: crypto.randomUUID(),
      userId: user.id,
      role: "user",
      content: "photo",
      imageUrl: "u/chat-1.jpg",
      createdAt: new Date(),
    });
    db.messages.push({
      id: crypto.randomUUID(),
      userId: user.id,
      role: "assistant",
      content: "no image",
      imageUrl: null,
      createdAt: new Date(),
    });

    const res = await request(app)
      .delete("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);

    expect(res.status).toBe(204);
    expect(deleteStorageObject).toHaveBeenCalledWith(
      "chat-attachments",
      "u/chat-1.jpg",
    );
  });

  it("returns 404 if called a second time (user already gone)", async () => {
    const user = await seedUser();
    const first = await request(app)
      .delete("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(first.status).toBe(204);
    const second = await request(app)
      .delete("/v1/me")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(second.status).toBe(404);
  });
});

describe("GET /v1/me/photos", () => {
  beforeEach(resetDb);

  it("401 without auth", async () => {
    const res = await request(app).get("/v1/me/photos");
    expect(res.status).toBe(401);
  });

  it("returns photos + signedUrls with matching lengths", async () => {
    const user = await seedUser();
    const u = db.users.get(user.id)!;
    u.profile = {
      id: crypto.randomUUID(),
      userId: user.id,
      hobbies: [],
      partnerPreferences: null,
      psychologicalSummary: null,
      ageRangeMin: null,
      ageRangeMax: null,
      photos: ["p/a.jpg", "p/b.jpg"],
      matchRadius: "campus_only",
    };
    const res = await request(app)
      .get("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual(["p/a.jpg", "p/b.jpg"]);
    expect(res.body.signedUrls).toHaveLength(2);
    expect(res.body.signedUrls[0]).toContain("p/a.jpg");
  });

  it("returns empty arrays when profile has no photos", async () => {
    const user = await seedUser({ profile: null });
    const res = await request(app)
      .get("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual([]);
    expect(res.body.signedUrls).toEqual([]);
  });
});

describe("POST /v1/me/photos", () => {
  beforeEach(resetDb);

  const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]); // any bytes will do

  it("401 without auth", async () => {
    const res = await request(app)
      .post("/v1/me/photos")
      .attach("photo", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(401);
  });

  it("201 on happy path + appends to profile.photos", async () => {
    const user = await seedUser();
    const u = db.users.get(user.id)!;
    u.profile = {
      id: crypto.randomUUID(),
      userId: user.id,
      hobbies: [],
      partnerPreferences: null,
      psychologicalSummary: null,
      ageRangeMin: null,
      ageRangeMax: null,
      photos: ["p/a.jpg"],
      matchRadius: "campus_only",
    };
    const res = await request(app)
      .post("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .attach("photo", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(res.body.photos).toHaveLength(2);
    expect(res.body.signedUrls).toHaveLength(2);
    expect(userById(user.id)?.profile?.photos).toHaveLength(2);
  });

  it("400 on non-image mime", async () => {
    const user = await seedUser();
    const res = await request(app)
      .post("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .attach("photo", Buffer.from("hi"), {
        filename: "p.txt",
        contentType: "text/plain",
      });
    expect(res.status).toBe(400);
  });

  it("409 when profile already has MAX_PHOTOS photos", async () => {
    const user = await seedUser();
    const u = db.users.get(user.id)!;
    u.profile = {
      id: crypto.randomUUID(),
      userId: user.id,
      hobbies: [],
      partnerPreferences: null,
      psychologicalSummary: null,
      ageRangeMin: null,
      ageRangeMax: null,
      photos: ["a.jpg", "b.jpg", "c.jpg", "d.jpg"],
      matchRadius: "campus_only",
    };
    const res = await request(app)
      .post("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .attach("photo", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/limit/i);
    expect(res.body.max).toBe(4);
  });

  it("400 when vision says not a valid face", async () => {
    const { validateSingleFaceFromBuffer } = await import(
      "../services/vision/validate-face.js"
    );
    vi.mocked(validateSingleFaceFromBuffer).mockResolvedValueOnce({
      ok: true,
      valid: false,
    });
    const user = await seedUser();
    const res = await request(app)
      .post("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .attach("photo", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
  });

  it("502 when vision service is down", async () => {
    const { validateSingleFaceFromBuffer } = await import(
      "../services/vision/validate-face.js"
    );
    vi.mocked(validateSingleFaceFromBuffer).mockResolvedValueOnce({
      ok: false,
      error: "api",
    });
    const user = await seedUser();
    const res = await request(app)
      .post("/v1/me/photos")
      .set("Authorization", `Bearer ${signAccess(user.id)}`)
      .attach("photo", JPEG, { filename: "p.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(502);
  });
});

describe("DELETE /v1/me/photos/:index", () => {
  beforeEach(resetDb);

  function seedWithPhotos(photos: string[], status: UserRow["status"] = "active") {
    return (async () => {
      const user = await seedUser({ status });
      const u = db.users.get(user.id)!;
      u.profile = {
        id: crypto.randomUUID(),
        userId: user.id,
        hobbies: [],
        partnerPreferences: null,
        psychologicalSummary: null,
        ageRangeMin: null,
        ageRangeMax: null,
        photos,
        matchRadius: "campus_only",
      };
      return user;
    })();
  }

  it("401 without auth", async () => {
    const res = await request(app).delete("/v1/me/photos/0");
    expect(res.status).toBe(401);
  });

  it("removes the photo at the given index", async () => {
    const user = await seedWithPhotos(["a.jpg", "b.jpg", "c.jpg"]);
    const res = await request(app)
      .delete("/v1/me/photos/1")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual(["a.jpg", "c.jpg"]);
    expect(userById(user.id)?.profile?.photos).toEqual(["a.jpg", "c.jpg"]);
  });

  it("404 on out-of-range index", async () => {
    const user = await seedWithPhotos(["a.jpg", "b.jpg"]);
    const res = await request(app)
      .delete("/v1/me/photos/9")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(404);
  });

  it("409 when active user would drop below MIN_PHOTOS", async () => {
    const user = await seedWithPhotos(["a.jpg", "b.jpg"], "active");
    const res = await request(app)
      .delete("/v1/me/photos/0")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(409);
    expect(res.body.min).toBe(2);
    // Profile untouched
    expect(userById(user.id)?.profile?.photos).toEqual(["a.jpg", "b.jpg"]);
  });

  it("allows paused users to drop below MIN_PHOTOS", async () => {
    const user = await seedWithPhotos(["a.jpg", "b.jpg"], "paused");
    const res = await request(app)
      .delete("/v1/me/photos/0")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(res.body.photos).toEqual(["b.jpg"]);
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
    expect(db.matchEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matchId: match.id,
          actorId: alice.id,
          targetId: bob.id,
          actionType: "DECLINED",
          metadata: null,
        }),
      ]),
    );
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
    expect(db.matchEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          matchId: match.id,
          actorId: alice.id,
          targetId: bob.id,
          actionType: "ACCEPTED",
          metadata: null,
        }),
      ]),
    );
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
    const match = await seedMatch(alice.id, bob.id, {
      status: "negotiating",
      agreedTime: new Date("2026-05-01T19:00:00.000Z"),
    });

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

  it("POST /:id/decision refuses declines after a match leaves proposed", async () => {
    const alice = await seedUser({ firstName: "Alice" });
    const bob = await seedUser({ firstName: "Bob" });
    const match = await seedMatch(alice.id, bob.id, { status: "negotiating" });
    const res = await request(app)
      .post(`/v1/matches/${match.id}/decision`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ decision: "decline" });

    expect(res.status).toBe(404);
    expect(db.matches.get(match.id)?.status).toBe("negotiating");
  });

  it("POST /:id/vibe-location refuses to enter venue negotiation before agreedTime is set", async () => {
    const alice = await seedUser();
    const bob = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "negotiating", agreedTime: null });

    const res = await request(app)
      .post(`/v1/matches/${match.id}/vibe-location`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ vibe: "coffee", lat: 37.4, lng: -122.1 });

    expect(res.status).toBe(409);
    expect(db.matches.get(match.id)?.status).toBe("negotiating");
    expect(db.matches.get(match.id)?.vibeTextA).toBeNull();
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

  it("POST /:id/report rolls back the report row when Tier 2 moderation fails", async () => {
    const { applyReportAction } = await import("../services/moderation.js");
    (applyReportAction as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("db fail"));

    const alice = await seedUser();
    const bob = await seedUser();
    const match = await seedMatch(alice.id, bob.id, { status: "proposed" });

    const res = await request(app)
      .post(`/v1/matches/${match.id}/report`)
      .set("Authorization", `Bearer ${signAccess(alice.id)}`)
      .send({ category: "tier2_ghosting", message: "ghosted" });

    expect(res.status).toBe(500);
    expect(db.reports).toHaveLength(0);
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

  it("returns ISO timestamps plus weekly standby metadata", async () => {
    const user = await seedUser();
    const res = await request(app)
      .get("/v1/countdown")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);
    expect(res.status).toBe(200);
    expect(() => new Date(res.body.nextDropAt)).not.toThrow();
    expect(() => new Date(res.body.serverNow)).not.toThrow();
    expect(res.body.weeklyStatus).toBe("pending");
    expect(res.body.standbyCount).toBe(0);
    expect(res.body.priorityBoosted).toBe(false);
    expect(res.body.resolvedAt).toBeNull();
    expect(new Date(res.body.nextDropAt).getTime()).toBeGreaterThan(
      Date.now() - 1000,
    );
  });

  it("returns standby when the user missed the current weekly batch", async () => {
    const user = await seedUser({
      profile: {
        id: crypto.randomUUID(),
        userId: "temp",
        hobbies: [],
        partnerPreferences: null,
        psychologicalSummary: null,
        ageRangeMin: null,
        ageRangeMax: null,
        photos: [],
        matchRadius: "campus_only",
        standbyCount: 2,
        lastMissedAt: new Date(),
      },
    });
    if (user.profile) user.profile.userId = user.id;

    const res = await request(app)
      .get("/v1/countdown")
      .set("Authorization", `Bearer ${signAccess(user.id)}`);

    expect(res.status).toBe(200);
    expect(res.body.weeklyStatus).toBe("standby");
    expect(res.body.standbyCount).toBe(2);
    expect(res.body.priorityBoosted).toBe(true);
    expect(() => new Date(res.body.resolvedAt)).not.toThrow();
  });
});

afterEach(() => {
  vi.clearAllMocks();
});
