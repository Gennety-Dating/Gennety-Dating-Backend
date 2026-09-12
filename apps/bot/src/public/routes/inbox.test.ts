import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import jwt from "jsonwebtoken";

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const ITEM = "22222222-2222-4222-8222-222222222222";

vi.mock("../../config.js", () => ({ env: { JWT_SECRET } }));

const svc = {
  listInbox: vi.fn(),
  markInboxRead: vi.fn(),
  getInboxItemDetail: vi.fn(),
  buildPulse: vi.fn(),
};
vi.mock("../../services/inbox.js", () => ({
  listInbox: (...a: unknown[]) => svc.listInbox(...a),
  markInboxRead: (...a: unknown[]) => svc.markInboxRead(...a),
  getInboxItemDetail: (...a: unknown[]) => svc.getInboxItemDetail(...a),
}));
vi.mock("../../services/pulse.js", () => ({ buildPulse: (...a: unknown[]) => svc.buildPulse(...a) }));

const { createInboxRouter, createPulseRouter } = await import("./inbox.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/v1/inbox", createInboxRouter());
  a.use("/v1/pulse", createPulseRouter());
  return a;
}

const auth = () => ({
  Authorization: `Bearer ${jwt.sign({ sub: USER_ID, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  })}`,
});

beforeEach(() => {
  for (const fn of Object.values(svc)) fn.mockReset();
});

describe("/v1/inbox", () => {
  it("needs a JWT", async () => {
    expect((await request(app()).get("/v1/inbox")).status).toBe(401);
    expect((await request(app()).get("/v1/pulse")).status).toBe(401);
  });

  it("lists with the caller's id and the paging query", async () => {
    svc.listInbox.mockResolvedValue({ ok: true, items: [], unreadCount: 3, hasMore: false });
    const res = await request(app()).get(`/v1/inbox?limit=10&before=${ITEM}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ items: [], unreadCount: 3, hasMore: false });
    expect(svc.listInbox).toHaveBeenCalledWith(USER_ID, { limit: 10, before: ITEM });
  });

  it("answers an unknown cursor with 404", async () => {
    svc.listInbox.mockResolvedValue({ ok: false, error: "unknown_cursor" });
    expect((await request(app()).get(`/v1/inbox?before=${ITEM}`).set(auth())).status).toBe(404);
  });

  // `/read` must never be swallowed by `/:id` — registered first on purpose.
  it("routes POST /read to the read marker, not to a lookup", async () => {
    svc.markInboxRead.mockResolvedValue({ ok: true, unreadCount: 0 });
    const res = await request(app()).post("/v1/inbox/read").set(auth()).send({ ids: [ITEM] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ unreadCount: 0 });
    expect(svc.markInboxRead).toHaveBeenCalledWith(USER_ID, [ITEM]);
    expect(svc.getInboxItemDetail).not.toHaveBeenCalled();
  });

  it("returns 400 for a bad id list", async () => {
    svc.markInboxRead.mockResolvedValue({ ok: false, error: "invalid_ids" });
    const res = await request(app()).post("/v1/inbox/read").set(auth()).send({ ids: "all" });
    expect(res.status).toBe(400);
  });

  it("returns 404 for a row that is not the caller's", async () => {
    svc.getInboxItemDetail.mockResolvedValue(null);
    expect((await request(app()).get(`/v1/inbox/${ITEM}`).set(auth())).status).toBe(404);
    expect(svc.getInboxItemDetail).toHaveBeenCalledWith(USER_ID, ITEM);
  });
});

describe("/v1/pulse", () => {
  it("returns the rows with the server clock", async () => {
    svc.buildPulse.mockResolvedValue([{ id: "announcement:x", kind: "announcement" }]);
    const res = await request(app()).get("/v1/pulse").set(auth());
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([{ id: "announcement:x", kind: "announcement" }]);
    expect(typeof res.body.serverNow).toBe("string");
  });
});
