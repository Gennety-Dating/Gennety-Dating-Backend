import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const USER_ID = "11111111-1111-1111-1111-111111111111";
const OTHER_ID = "22222222-2222-2222-2222-222222222222";

const findMany = vi.fn();
const findUnique = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    ticketLedger: {
      findMany: (...a: unknown[]) => findMany(...a),
      findUnique: (...a: unknown[]) => findUnique(...a),
    },
    user: { findUnique: vi.fn() },
  },
}));

const envMock = { TICKET_FEATURE_ENABLED: true };
vi.mock("../../config.js", () => ({ env: envMock }));

vi.mock("../auth-middleware.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.userId = USER_ID;
    next();
  },
}));

const { ticketsHistoryRouter } = await import("./tickets-history.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/v1/me/tickets/history", ticketsHistoryRouter);
  return app;
}

function row(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    delta: 1,
    reason: "welcome_gift",
    bundleSize: null,
    createdAt: new Date("2026-09-01T10:00:00.000Z"),
    ...over,
  };
}

beforeEach(() => {
  envMock.TICKET_FEATURE_ENABLED = true;
  findMany.mockReset();
  findUnique.mockReset();
});

describe("GET /v1/me/tickets/history", () => {
  it("serialises movements newest first and reports no more pages", async () => {
    findMany.mockResolvedValue([
      row("r1", { delta: 3, reason: "store_purchase", bundleSize: 3 }),
      row("r2", { delta: -1, reason: "spend_match" }),
    ]);

    const res = await request(buildApp()).get("/v1/me/tickets/history");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      entries: [
        {
          id: "r1",
          delta: 3,
          reason: "store_purchase",
          bundleSize: 3,
          createdAt: "2026-09-01T10:00:00.000Z",
        },
        { id: "r2", delta: -1, reason: "spend_match", createdAt: "2026-09-01T10:00:00.000Z" },
      ],
      hasMore: false,
    });
    // `id` breaks `createdAt` ties — a gate settling both slots writes two
    // rows in one transaction, and a timestamp-only order could split them.
    expect(findMany.mock.calls[0]![0]).toMatchObject({
      where: { userId: USER_ID },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  });

  it("asks for one row more than the limit and reports hasMore without leaking it", async () => {
    findMany.mockResolvedValue([row("r1"), row("r2"), row("r3")]);

    const res = await request(buildApp()).get("/v1/me/tickets/history?limit=2");

    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 3 });
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.hasMore).toBe(true);
  });

  it("pages from a cursor the caller owns", async () => {
    findUnique.mockResolvedValue({ userId: USER_ID });
    findMany.mockResolvedValue([row("r9")]);

    const res = await request(buildApp()).get("/v1/me/tickets/history?before=r1");

    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0]![0]).toMatchObject({ cursor: { id: "r1" }, skip: 1 });
  });

  it("404s on another wallet's cursor without touching the ledger", async () => {
    findUnique.mockResolvedValue({ userId: OTHER_ID });

    const res = await request(buildApp()).get("/v1/me/tickets/history?before=someone-elses");

    expect(res.status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("404s on an unknown cursor with the same answer as a foreign one", async () => {
    findUnique.mockResolvedValue(null);

    const res = await request(buildApp()).get("/v1/me/tickets/history?before=nope");

    expect(res.status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("falls back to the default limit on junk instead of erroring", async () => {
    findMany.mockResolvedValue([]);

    await request(buildApp()).get("/v1/me/tickets/history?limit=9999");
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 31 });

    findMany.mockClear();
    await request(buildApp()).get("/v1/me/tickets/history?limit=abc");
    expect(findMany.mock.calls[0]![0]).toMatchObject({ take: 31 });
  });

  it("404s while the ticket feature is off", async () => {
    envMock.TICKET_FEATURE_ENABLED = false;

    const res = await request(buildApp()).get("/v1/me/tickets/history");

    expect(res.status).toBe(404);
    expect(findMany).not.toHaveBeenCalled();
  });
});
