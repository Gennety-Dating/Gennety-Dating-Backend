import express from "express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BUMP_CEREMONY_LEAD_MS, BUMP_CEREMONY_REPLAY_MS } from "@gennety/shared";

/**
 * `POST /v1/dates/:matchId/bump` end to end through the real route, the real
 * `recordBump` / `recordHold` / `verifyBump` and the real long-poll — against
 * an in-memory `DateBumpSession` row that behaves like the table (upsert, and
 * a compare-and-set that only one caller can win), so two concurrent holds go
 * through exactly the code production runs.
 */

interface Row {
  matchId: string;
  userAShakeAt: Date | null;
  userBShakeAt: Date | null;
  isVerified: boolean;
  verifiedAt: Date | null;
  icebreakerDeck: unknown;
}

let row: Row | null = null;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

function pick(r: Row, select?: Record<string, boolean>): Record<string, unknown> {
  if (!select) return { ...r };
  return Object.fromEntries(
    Object.keys(select).map((k) => [k, (r as unknown as Record<string, unknown>)[k]]),
  );
}

const MATCH_ID = "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
const VENUE = { lat: 50.4501, lng: 30.5234 };
const NEARBY = { lat: 50.45046, lng: 30.5234 };

const bumpSession = {
  findUnique: vi.fn(async ({ select }: { select?: Record<string, boolean> }) => {
    await tick();
    return row ? pick(row, select) : null;
  }),
  upsert: vi.fn(
    async ({
      create,
      update,
      select,
    }: {
      create: Partial<Row> & { matchId: string };
      update: Partial<Row>;
      select?: Record<string, boolean>;
    }) => {
      await tick();
      if (!row) {
        row = {
          userAShakeAt: null,
          userBShakeAt: null,
          isVerified: false,
          verifiedAt: null,
          icebreakerDeck: null,
          ...create,
        };
      } else {
        Object.assign(row, update);
      }
      return pick(row, select);
    },
  ),
  updateMany: vi.fn(
    async ({ where, data }: { where: { isVerified: boolean }; data: Partial<Row> }) => {
      await tick();
      if (!row || row.isVerified !== where.isVerified) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  ),
  update: vi.fn(async ({ data }: { data: Partial<Row> }) => {
    if (row) Object.assign(row, data);
    return row;
  }),
};

const tx = {
  dateBumpSession: bumpSession,
  match: { update: vi.fn(async () => ({})) },
  profile: { updateMany: vi.fn(async () => ({ count: 2 })) },
};

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(async () => ({
        id: MATCH_ID,
        status: "scheduled",
        userAId: "a",
        userBId: "b",
        // "Now" is inside the window: it opens at T-15m and closes at T+2h.
        agreedTime: new Date(Date.now() - 60_000),
        venueLat: VENUE.lat,
        venueLng: VENUE.lng,
        venueMidpointLat: 50.44,
        venuePlaceId: "place-1",
      })),
      update: tx.match.update,
    },
    dateBumpSession: bumpSession,
    profile: tx.profile,
    $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)),
  },
}));

vi.mock("./canvas-auth.js", () => ({
  requireCanvasAuth: (
    req: { userId?: string; header: (name: string) => string | undefined },
    _res: unknown,
    next: () => void,
  ) => {
    req.userId = req.header("x-test-user") ?? "a";
    next();
  },
}));
vi.mock("./rate-limit.js", () => ({
  canvasLimiter: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../services/ticket-wallet.js", () => ({
  grantTickets: vi.fn(async () => 1),
  isUniqueViolation: () => false,
}));
vi.mock("../services/scratch-map.js", () => ({ recordVerifiedVisit: vi.fn(async () => undefined) }));
vi.mock("../services/openai.js", () => ({ callOpenAIText: vi.fn(async () => "") }));
vi.mock("../services/main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("../services/push.js", () => ({ sendPushToUser: vi.fn(async () => true) }));

const DECK = { topicsForA: ["a1", "a2"], topicsForB: ["b1", "b2"] };
const generateDeck = vi.fn<(matchId: string) => Promise<typeof DECK | null>>();
const announce = vi.fn<(matchId: string) => Promise<void>>();
vi.mock("../services/date-bump.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/date-bump.js")>()),
  generateAndStoreBumpDeck: generateDeck,
  announceBumpVerified: announce,
}));

const { createDateBumpRouter } = await import("./routes/date-bump.js");
const { waitingHoldCount } = await import("../services/bump-ceremony.js");

function buildApp(options: { holdWaitMs?: number; holdPollMs?: number } = {}) {
  const app = express();
  app.use(express.json());
  // A poll far slower than the tests: anything that wakes a waiting hold in
  // time here was the in-process event, not the poll.
  app.use("/v1/dates", createDateBumpRouter({ holdPollMs: 60_000, holdWaitMs: 2_000, ...options }));
  return app;
}

function post(app: express.Express, user: string, body: Record<string, unknown>) {
  return request(app)
    .post(`/v1/dates/${MATCH_ID}/bump`)
    .set("x-test-user", user)
    .send({ ...NEARBY, ...body });
}

async function until(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

beforeEach(() => {
  row = null;
  vi.clearAllMocks();
  generateDeck.mockReset().mockResolvedValue(DECK);
  announce.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  // Every test must leave no hold waiting behind it.
  await until(() => waitingHoldCount(MATCH_ID) === 0);
});

describe("POST /v1/dates/:matchId/bump — hold", () => {
  it("gives two concurrent holds one start and the roles A (waited) and B (completed)", async () => {
    const app = buildApp();
    const first = post(app, "a", { hold: true }).then((r) => r);
    await until(() => waitingHoldCount(MATCH_ID) === 1);
    const second = await post(app, "b", { hold: true });
    const waited = await first;

    expect(second.status).toBe(200);
    expect(waited.status).toBe(200);
    expect(second.body).toMatchObject({ ok: true, verified: true, deck: null });
    expect(waited.body).toMatchObject({ ok: true, verified: true, deck: null });
    expect(second.body.ceremony.role).toBe("B");
    expect(waited.body.ceremony.role).toBe("A");
    expect(waited.body.ceremony.startAt).toBe(second.body.ceremony.startAt);
    expect(Date.parse(second.body.ceremony.startAt)).toBe(
      row!.verifiedAt!.getTime() + BUMP_CEREMONY_LEAD_MS,
    );
    expect(second.body.ceremony.serverNow).toEqual(expect.any(String));
  });

  // The poll in `buildApp` is a minute; the whole exchange finishing in well
  // under that proves the wake-up came from the verification itself.
  it("wakes the waiting hold from the verification event, not the poll", async () => {
    const app = buildApp({ holdWaitMs: 5_000 });
    const started = Date.now();
    const first = post(app, "a", { hold: true }).then((r) => r);
    await until(() => waitingHoldCount(MATCH_ID) === 1);
    const readsBefore = bumpSession.findUnique.mock.calls.length;
    await post(app, "b", { hold: true });
    const waited = await first;

    expect(waited.body.verified).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
    // One read to learn it was verified, no polling in between.
    expect(bumpSession.findUnique.mock.calls.length - readsBefore).toBeLessThanOrEqual(2);
  });

  it("answers not verified when the partner never comes", async () => {
    const app = buildApp({ holdWaitMs: 150 });
    const res = await post(app, "a", { hold: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, verified: false, deck: null });
  });

  it("uses the server's clock and ignores the device's `at`", async () => {
    const app = buildApp({ holdWaitMs: 50 });
    const before = Date.now();
    await post(app, "a", { hold: true, at: "2026-01-01T00:00:00.000Z" });

    expect(row!.userAShakeAt!.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("responds without waiting for the deck, and announces only after it", async () => {
    let releaseDeck!: (deck: typeof DECK) => void;
    generateDeck.mockImplementation(
      () => new Promise((resolve) => (releaseDeck = resolve)),
    );
    const app = buildApp();
    const first = post(app, "a", { hold: true }).then((r) => r);
    await until(() => waitingHoldCount(MATCH_ID) === 1);
    const second = await post(app, "b", { hold: true });
    await first;

    // The deck is still being generated, and the response is already here.
    expect(second.body).toMatchObject({ verified: true, deck: null });
    await until(() => generateDeck.mock.calls.length === 1);
    expect(announce).not.toHaveBeenCalled();

    releaseDeck(DECK);
    await until(() => announce.mock.calls.length === 1);
    expect(generateDeck).toHaveBeenCalledWith(MATCH_ID);
    expect(announce).toHaveBeenCalledWith(MATCH_ID);
  });

  it("hands the ceremony to a retried hold shortly after verification", async () => {
    const verifiedAt = new Date(Date.now() - 1_000);
    row = {
      matchId: MATCH_ID,
      userAShakeAt: new Date(verifiedAt.getTime() - 2_000),
      userBShakeAt: verifiedAt,
      isVerified: true,
      verifiedAt,
      icebreakerDeck: null,
    };
    const app = buildApp();

    const waiter = await post(app, "a", { hold: true });
    const completer = await post(app, "b", { hold: true });

    expect(waiter.body.ceremony).toMatchObject({
      role: "A",
      startAt: new Date(verifiedAt.getTime() + BUMP_CEREMONY_LEAD_MS).toISOString(),
    });
    // A hold never writes to a verified pair, so the role survives the retry.
    expect(completer.body.ceremony.role).toBe("B");
    expect(row.userBShakeAt).toBe(verifiedAt);
    expect(generateDeck).not.toHaveBeenCalled();
  });

  it("never replays the ceremony once it is over", async () => {
    const verifiedAt = new Date(
      Date.now() - BUMP_CEREMONY_LEAD_MS - BUMP_CEREMONY_REPLAY_MS - 1,
    );
    row = {
      matchId: MATCH_ID,
      userAShakeAt: verifiedAt,
      userBShakeAt: verifiedAt,
      isVerified: true,
      verifiedAt,
      icebreakerDeck: DECK,
    };
    const res = await post(buildApp(), "a", { hold: true });

    expect(res.body).toEqual({ ok: true, verified: true, deck: null });
  });

  it("gives the holder A when an old shake completes the pair", async () => {
    const app = buildApp();
    const holder = post(app, "a", { hold: true }).then((r) => r);
    await until(() => waitingHoldCount(MATCH_ID) === 1);
    const deviceClock = new Date(Date.now() + 1_500).toISOString();
    const shaker = await post(app, "b", { at: deviceClock });
    const held = await holder;

    expect(shaker.body).toEqual({ ok: true, verified: true, deck: DECK });
    expect(held.body.ceremony.role).toBe("A");
    expect(row!.verifiedAt!.toISOString()).toBe(deviceClock);
  });

  it("stops waiting when the client disconnects", async () => {
    const app = buildApp({ holdWaitMs: 5_000 });
    const aborted = post(app, "a", { hold: true })
      .timeout({ response: 100 })
      .then(
        () => "answered",
        (err: { timeout?: number }) => (err.timeout ? "aborted" : "failed"),
      );

    await until(() => waitingHoldCount(MATCH_ID) === 1);
    expect(await aborted).toBe("aborted");
    // Long before the 5 s wait would have ended.
    await until(() => waitingHoldCount(MATCH_ID) === 0, 500);
  });

  it("refuses a hold with the shake's refusals", async () => {
    const res = await post(buildApp(), "stranger", { hold: true });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: "not-participant" });
  });
});

describe("POST /v1/dates/:matchId/bump — the old shake is unchanged", () => {
  it("answers a lone shake at once, unverified", async () => {
    const res = await post(buildApp(), "a", {});
    expect(res.body).toEqual({ ok: true, verified: false, deck: null });
    expect(waitingHoldCount(MATCH_ID)).toBe(0);
  });

  it("awaits the deck and the announcement before answering the verifying shake", async () => {
    const app = buildApp();
    await post(app, "a", {});
    const res = await post(app, "b", {});

    expect(res.body).toEqual({ ok: true, verified: true, deck: DECK });
    expect(res.body).not.toHaveProperty("ceremony");
    expect(generateDeck).toHaveBeenCalledTimes(1);
    expect(announce).toHaveBeenCalledTimes(1);
  });

  it("treats anything but a literal true as a shake", async () => {
    const res = await post(buildApp(), "a", { hold: "true" });
    expect(res.body).toEqual({ ok: true, verified: false, deck: null });
  });
});
