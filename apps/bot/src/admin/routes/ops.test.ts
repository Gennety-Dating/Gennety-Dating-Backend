import { describe, it, expect, vi } from "vitest";
import request from "supertest";

vi.mock("../../config.js", () => ({
  env: {
    BOT_TOKEN: "test",
    DATABASE_URL: "test",
    OPENAI_API_KEY: "",
    CUSTOM_EMOJI_LIKE_ID: "",
    CUSTOM_EMOJI_DISLIKE_ID: "",
    CUSTOM_EMOJI_MENU_ID: "",
    CUSTOM_EMOJI_ACCEPT_ID: "",
    CUSTOM_EMOJI_DECLINE_ID: "",
    MESSAGE_EFFECT_MATCH_ID: "",
    WEBAPP_URL: "https://test.invalid/calendar",
    ADMIN_API_KEY: "test-secret-key",
    ADMIN_PORT: 3100,
    ADMIN_DASHBOARD_ORIGIN: "*",
  },
}));

const { MOCK_MATCH } = vi.hoisted(() => ({
  MOCK_MATCH: {
    id: "00000000-0000-0000-0000-0000000000aa",
    status: "scheduled",
    source: "weekly",
    synergyScore: 88,
    acceptedByA: true,
    acceptedByB: true,
    agreedTime: new Date("2026-08-01T16:00:00Z"),
    venueName: "Aroma Kava",
    venueAddress: "Khreshchatyk 14",
    ticketStatus: "completed",
    dispatchedAt: new Date("2026-07-30T15:00:00Z"),
    createdAt: new Date("2026-07-30T15:00:00Z"),
    userA: {
      id: "00000000-0000-0000-0000-000000000001",
      telegramId: BigInt("123456789"),
      firstName: "Alice",
      age: 21,
      gender: "female",
      status: "active",
      verificationStatus: "verified",
    },
    userB: {
      id: "00000000-0000-0000-0000-000000000002",
      // Negative id = a mobile-only user (ARCHITECTURE: synthetic negative
      // telegramId). Included so BigInt serialization is covered for both.
      telegramId: BigInt("-987654321"),
      firstName: "Bob",
      age: 23,
      gender: "male",
      status: "active",
      verificationStatus: "verified",
    },
  },
}));

// Set per-test; read by the where-aware `match.count` mock below.
let strandedProposedCount = 0;

// Set per-test; read by the select-aware `user.findMany` / `adSpend.findMany`
// mocks below and by the `loadPayerIndex` mock further down.
interface RawAcquisitionUserRow {
  id: string;
  referralSource: string | null;
  createdAt: Date;
  status: string;
  verificationStatus: string;
}
interface RawAdSpendRow {
  channel: string;
  category: string;
  periodStart: Date;
  periodEnd: Date;
  amountUsdCents: number;
}
let acquisitionUserRows: RawAcquisitionUserRow[] = [];
let adSpendRows: RawAdSpendRow[] = [];
let payerIndexOverride: Map<string, { firstPaidAt: Date | null; usdCents: number }> | null = null;

vi.mock("@gennety/db", () => ({
  prisma: {
    $queryRaw: vi.fn().mockResolvedValue([{ "?column?": 1 }]),
    user: {
      count: vi.fn().mockResolvedValue(9),
      groupBy: vi.fn().mockResolvedValue([]),
      // Select-aware for the same reason `match.findMany` below is:
      // `/admin/dashboard` scans `users` TWICE — once inside `classifyAllUsers`
      // (health select) and once for the acquisition-cost `referralSource`
      // scan — and a flat mock cannot tell the two apart. Per-test overrides
      // (`mockImplementationOnce`) still layer on top of this default.
      findMany: vi.fn().mockImplementation((args?: { select?: { referralSource?: unknown } }) =>
        Promise.resolve(args?.select?.referralSource ? acquisitionUserRows : []),
      ),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
    adSpend: { findMany: vi.fn().mockImplementation(() => Promise.resolve(adSpendRows)) },
    // Возвраты по матчам — вход нетто-конверсии (`match-conversion.ts`).
    ticketLedger: { groupBy: vi.fn().mockResolvedValue([]) },
    match: {
      groupBy: vi.fn().mockResolvedValue([{ status: "scheduled", _count: { _all: 1 } }]),
      // Where-aware, for the same reason `findMany` below is: `/admin/stats`
      // makes TWO match counts — the total, and the stranded-proposal probe
      // (`dispatchedAt: null`). A mock answering both with the same number
      // cannot tell either of them apart.
      count: vi.fn().mockImplementation((args?: { where?: { dispatchedAt?: null } }) =>
        Promise.resolve(args?.where && "dispatchedAt" in args.where ? strandedProposedCount : 1),
      ),
      // Select-aware, because real Prisma is: `/admin/dashboard` does NOT
      // select the user relations, so a mock that returns them regardless
      // would hand the handler BigInts it never asked for and fake a 500.
      findMany: vi.fn().mockImplementation((args?: { select?: { userA?: unknown } }) => {
        if (args?.select?.userA) return Promise.resolve([MOCK_MATCH]);
        const { userA: _a, userB: _b, ...rest } = MOCK_MATCH;
        return Promise.resolve([rest]);
      }),
    },
    message: { findMany: vi.fn().mockResolvedValue([]) },
    noMatchNotice: { findMany: vi.fn().mockResolvedValue([]) },
    report: {
      groupBy: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      update: vi.fn().mockResolvedValue({}),
    },
  },
}));

vi.mock("../../services/verification-pipeline.js", () => ({
  runFaceMatchVerificationDefault: vi.fn(),
}));

vi.mock("../../services/storage.js", () => ({
  downloadProfileImage: vi.fn(),
  downloadChatImage: vi.fn(),
  downloadTelegramFile: vi.fn(),
}));

vi.mock("../../services/purchases.js", () => ({
  loadPayerIndex: vi.fn().mockImplementation(() =>
    Promise.resolve({ byUser: payerIndexOverride ?? new Map(), truncated: false }),
  ),
}));

import { prisma } from "@gennety/db";
import { app } from "../server.js";

const KEY = "test-secret-key";
const get = (url: string) => request(app).get(url).set("Authorization", `Bearer ${KEY}`);

const NEW_ENDPOINTS = [
  "/admin/health",
  "/admin/stats",
  "/admin/dashboard",
  "/admin/matches",
];

describe("ops endpoints — auth", () => {
  it.each(NEW_ENDPOINTS)("rejects an unauthenticated request — %s", async (url) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(401);
  });
});

describe("GET /admin/health", () => {
  it("reports ok when the database answers", async () => {
    const res = await get("/admin/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.db.ok).toBe(true);
    expect(typeof res.body.uptimeSeconds).toBe("number");
  });

  it("answers 503 — not 200 — when the database is unreachable", async () => {
    vi.mocked(prisma.$queryRaw).mockRejectedValueOnce(new Error("connection refused"));
    const res = await get("/admin/health");
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.db.error).toContain("connection refused");
  });
});

describe("GET /admin/stats", () => {
  it("zero-fills every bucket so a missing group reads as 0", async () => {
    const res = await get("/admin/stats");
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBe(9);
    // No user groupBy rows were mocked → every status must still be present.
    expect(res.body.users.byStatus.active).toBe(0);
    expect(res.body.users.byStatus.banned).toBe(0);
    expect(res.body.verification.byStatus.verified).toBe(0);
    expect(res.body.reports.byTier["1"]).toBe(0);
  });

  it("counts the live-match states behind the single-live-match invariant", async () => {
    const res = await get("/admin/stats");
    expect(res.body.matches.byStatus.scheduled).toBe(1);
    expect(res.body.matches.live).toBe(1);
  });

  it("surfaces stranded proposals — rows no sweep can see", async () => {
    // A `proposed` row with no `dispatchedAt` is invisible to the expiry sweep,
    // the countdown worker and both nudge cadences at once, while still holding
    // BOTH participants out of every drop (§3.3). `disposeUndeliveredMatch` makes
    // new ones impossible; this counter is how a regression — or a row left over
    // from before that shipped — becomes visible without running a script.
    strandedProposedCount = 2;
    try {
      const res = await get("/admin/stats");
      expect(res.body.matches.strandedProposed).toBe(2);
      // Not folded into `live`: that number answers "is anything in flight",
      // and these rows are precisely the ones that are not.
      expect(res.body.matches.live).toBe(1);
    } finally {
      strandedProposedCount = 0;
    }
  });

  it("reports zero stranded proposals on a healthy database", async () => {
    const res = await get("/admin/stats");
    expect(res.body.matches.strandedProposed).toBe(0);
  });
});

describe("GET /admin/dashboard", () => {
  it("returns the stats superset plus derived rates", async () => {
    const res = await get("/admin/dashboard");
    expect(res.status).toBe(200);
    expect(res.body.users.total).toBe(9);
    expect(res.body.derived).toBeDefined();
    expect(typeof res.body.derived.signupsLast7Days).toBe("number");
    expect(res.body.recentMatches).toHaveLength(1);
    // Dates must be ISO strings, never Date objects leaking through JSON.
    expect(typeof res.body.recentMatches[0].createdAt).toBe("string");
  });

  describe("acquisition cost (AD_SPEND_TRACKING_DESIGN.md)", () => {
    it("is null, not 0 or Infinity, with no spend recorded", async () => {
      const res = await get("/admin/dashboard");
      expect(res.body.derived.cacPerPayingUsdCents).toBeNull();
      expect(res.body.derived.cacPerActiveUsdCents).toBeNull();
      expect(res.body.derived.ltvCac).toBeNull();
      expect(res.body.derived.roas).toBeNull();
      expect(res.body.derived.totalMarketingSpendUsdCents).toBe(0);
      expect(res.body.derived.adSpendByChannel).toEqual([]);
    });

    it("computes real CAC/LTV:CAC/ROAS once spend, a signup, and a payer all line up", async () => {
      // Anchored to the real clock (the route reads `new Date()`, not an
      // injected one) but well inside `performance_ads`'s 3-day window either
      // way — only the attribution range matters here, never `matured`.
      const day = 86_400_000;
      const periodStart = new Date(Date.now() - 20 * day);
      const periodEnd = new Date(Date.now() - 14 * day);
      adSpendRows = [
        {
          channel: "tg:insta_promo",
          category: "performance_ads",
          periodStart,
          periodEnd,
          amountUsdCents: 5_000,
        },
      ];
      acquisitionUserRows = [
        {
          id: "u1",
          referralSource: "tg:insta_promo",
          createdAt: new Date(Date.now() - 18 * day),
          status: "active",
          verificationStatus: "verified",
        },
      ];
      payerIndexOverride = new Map([
        ["u1", { firstPaidAt: new Date(Date.now() - 13 * day), usdCents: 700 }],
      ]);
      try {
        const res = await get("/admin/dashboard");
        expect(res.body.derived.totalMarketingSpendUsdCents).toBe(5_000);
        expect(res.body.derived.cacPerPayingUsdCents).toBe(5_000);
        expect(res.body.derived.cacPerActiveUsdCents).toBe(5_000);
        expect(res.body.derived.ltvCac).toBeCloseTo(0.14, 2);
        expect(res.body.derived.roas).toBeCloseTo(0.14, 2);
        expect(res.body.derived.adSpendByChannel).toHaveLength(1);
        expect(res.body.derived.adSpendByChannel[0].channel).toBe("tg:insta_promo");
      } finally {
        adSpendRows = [];
        acquisitionUserRows = [];
        payerIndexOverride = null;
      }
    });
  });
});

describe("GET /admin/matches", () => {
  it("lists match rows with both participants", async () => {
    const res = await get("/admin/matches");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.data[0].venueName).toBe("Aroma Kava");
    expect(res.body.data[0].userA.firstName).toBe("Alice");
  });

  it("serializes BigInt telegramId as a string on both sides", async () => {
    const res = await get("/admin/matches");
    // JSON.stringify throws on BigInt — a regression here is a 500, so assert
    // the exact string form rather than merely that the request succeeded.
    expect(res.body.data[0].userA.telegramId).toBe("123456789");
    expect(res.body.data[0].userB.telegramId).toBe("-987654321");
  });

  it("rejects an unknown status filter instead of silently ignoring it", async () => {
    const res = await get("/admin/matches?status=bogus");
    expect(res.status).toBe(400);
  });

  it("clamps limit rather than passing it through raw", async () => {
    await get("/admin/matches?limit=9999&offset=-5");
    const call = vi.mocked(prisma.match.findMany).mock.calls.at(-1)?.[0];
    expect(call?.take).toBe(100);
    expect(call?.skip).toBe(0);
  });
});

describe("malformed :id is a 400, not a 500", () => {
  // Prisma throws P2023 on a non-UUID `@db.Uuid` lookup, which the routes used
  // to report as "Internal server error" — observed live in the production
  // error log for /admin/users/:id.
  it.each([
    "/admin/users/about",
    "/admin/users/about/conversation",
    "/admin/dialogs/about",
    "/admin/conversations/about",
  ])("rejects %s with 400", async (url) => {
    const res = await get(url);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/UUID/i);
  });

  it("never reaches Prisma with a malformed id", async () => {
    vi.mocked(prisma.user.findUnique).mockClear();
    await get("/admin/users/not-a-uuid");
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

describe("path aliases resolve to the same handler", () => {
  // Express 5 swapped in path-to-regexp v8; array paths still work, but a
  // regression would silently 404 the alias, which is the exact bug these
  // endpoints exist to fix.
  it("serves /admin/conversations as an alias of /admin/dialogs", async () => {
    const res = await get("/admin/conversations");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("data");
  });

  it("serves /admin/analytics/founder-weekly as an alias of weekly-matches", async () => {
    const res = await get("/admin/analytics/founder-weekly");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("weekOf");
  });
});
