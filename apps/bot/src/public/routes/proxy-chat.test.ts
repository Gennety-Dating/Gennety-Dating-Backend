import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import http from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import jwt from "jsonwebtoken";

/**
 * `GET /v1/matches/{id}/chat?after=` (the long-poll) and
 * `POST /v1/matches/{id}/chat/presence` — DECISIONS 2026-09-30.
 *
 * The service rules (window, refusals, ticks) are covered in
 * `services/proxy-chat.test.ts`, presence expiry in `proxy-presence.test.ts`.
 * Here is what only a real HTTP exchange shows: that a held read is woken by
 * the partner's line and answers with it, that a client hanging up mid-hold
 * leaves the chat at once instead of when its grace runs out, and that the
 * presence endpoint answers with the PARTNER, never with the caller.
 */

const JWT_SECRET = "test-jwt-secret-value-long-enough";
const MATCH = "22222222-2222-4222-8222-222222222222";
const A = "11111111-1111-4111-8111-111111111111";
const B = "33333333-3333-4333-8333-333333333333";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { JWT_SECRET: "test-jwt-secret-value-long-enough", COORDINATION_FEATURE_ENABLED: true },
}));
vi.mock("../../config.js", () => ({ env: mockEnv }));

type Row = {
  id: string;
  senderId: string;
  body: string;
  createdAt: Date;
  deliveredAt: Date | null;
  reaction: string | null;
};
const rows: Row[] = [];
let agreedTime = new Date();

vi.mock("@gennety/db", () => ({
  prisma: {
    match: {
      findUnique: vi.fn(async () => ({
        id: MATCH,
        status: "scheduled",
        userAId: A,
        userBId: B,
        agreedTime,
        proxyOpenedAt: null,
        proxyClosesAt: null,
        proxyClosedAt: null,
        proxyReadAtA: null,
        proxyReadAtB: null,
        userA: { id: A, telegramId: -1n, platform: "mobile", language: "en", firstName: "Anna" },
        userB: { id: B, telegramId: -2n, platform: "mobile", language: "en", firstName: "Bohdan" },
      })),
      update: vi.fn(async () => ({})),
    },
    proxyMessage: {
      findMany: vi.fn(async () => [...rows].reverse()),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async ({ data }: { data: { senderId: string; body: string } }) => {
        const row: Row = {
          id: `44444444-4444-4444-8444-44444444444${rows.length}`,
          senderId: data.senderId,
          body: data.body,
          createdAt: new Date(),
          deliveredAt: null,
          reaction: null,
        };
        rows.push(row);
        return { id: row.id };
      }),
      update: vi.fn(async () => ({})),
      count: vi.fn(async () => 0),
    },
  },
}));
vi.mock("../../services/push.js", () => ({ sendPushToUser: vi.fn(async () => true) }));
vi.mock("../../services/main-bot-api.js", () => ({ getMainBotApi: () => null }));
vi.mock("../../services/outbound-recorder.js", () => ({
  withRedactedSummary: async (_s: string, fn: () => Promise<unknown>) => fn(),
}));

const { createProxyChatRouter } = await import("./proxy-chat.js");
const { JWT_ISSUER, JWT_AUDIENCE } = await import("../jwt.js");
const presence = await import("../../services/proxy-presence.js");

function tokenFor(userId: string): string {
  return jwt.sign({ sub: userId, typ: "access" }, JWT_SECRET, {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: "15m",
  });
}

function makeApp(holdMs = 2_000): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/v1/matches/:matchId/chat", createProxyChatRouter({ holdMs }));
  return app;
}

async function until(predicate: () => boolean, ms = 1_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) throw new Error("condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  rows.length = 0;
  // Inside the window: T-1h … T+2h around a date 30 minutes from now.
  agreedTime = new Date(Date.now() + 30 * 60_000);
  mockEnv.COORDINATION_FEATURE_ENABLED = true;
  presence.resetProxyPresenceForTest();
});

afterEach(() => {
  presence.resetProxyPresenceForTest();
});

describe("GET /chat — presence and version", () => {
  it("answers with the partner's presence and a version, and marks the reader in the chat", async () => {
    presence.markPresence({ matchId: MATCH, userId: B, place: "chat", typing: true });
    const res = await request(makeApp())
      .get(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    expect(res.status).toBe(200);
    expect(res.body.partnerPresence).toEqual({ online: true, inChat: true, typing: true });
    expect(typeof res.body.version).toBe("string");
    expect(presence.presenceOf(MATCH, A).inChat).toBe(true);
  });

  /** Presence belongs to the chat: before the window nobody is shown, nobody is stamped. */
  it("shows and stamps nothing outside the window", async () => {
    agreedTime = new Date(Date.now() + 5 * 60 * 60_000);
    presence.markPresence({ matchId: MATCH, userId: B, place: "app" });
    const res = await request(makeApp())
      .get(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    expect(res.status).toBe(200);
    expect(res.body.open).toBe(false);
    expect(res.body.partnerPresence).toEqual({ online: false, inChat: false, typing: false });
    expect(presence.presenceOf(MATCH, A).online).toBe(false);
  });

  it("refuses a stranger before holding anything", async () => {
    const stranger = "55555555-5555-4555-8555-555555555555";
    const res = await request(makeApp())
      .get(`/v1/matches/${MATCH}/chat?after=x.0`)
      .set("Authorization", `Bearer ${tokenFor(stranger)}`);
    expect(res.status).toBe(403);
    expect(presence.heldReadCount(MATCH)).toBe(0);
  });
});

describe("GET /chat?after= — the long-poll", () => {
  it("answers at once on a stale version", async () => {
    const started = Date.now();
    const res = await request(makeApp(5_000))
      .get(`/v1/matches/${MATCH}/chat?after=stale.0`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it("holds until the partner writes, then answers with the line", async () => {
    const app = makeApp(5_000);
    // First read: enters the chat and learns the version.
    const first = await request(app)
      .get(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    const held = request(app)
      .get(`/v1/matches/${MATCH}/chat?after=${first.body.version}`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .then((r) => r);
    await until(() => presence.heldReadCount(MATCH) === 1);

    const started = Date.now();
    const sent = await request(app)
      .post(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(B)}`)
      .send({ body: "I'm at the door" });
    expect(sent.status).toBe(200);

    const res = await held;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(res.body.messages.map((m: { body: string }) => m.body)).toEqual(["I'm at the door"]);
    expect(res.body.version).not.toBe(first.body.version);
  });

  it("answers 'nothing new' at the deadline", async () => {
    const app = makeApp(150);
    const first = await request(app)
      .get(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    const res = await request(app)
      .get(`/v1/matches/${MATCH}/chat?after=${first.body.version}`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(first.body.version);
    expect(presence.heldReadCount(MATCH)).toBe(0);
  });

  /**
   * The screen went away mid-hold (the app cancels its read when the chat
   * closes): the partner must see "left the chat" now, not 30 s later.
   */
  it("leaves the chat the moment the client hangs up", async () => {
    const server = http.createServer(makeApp(10_000));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    try {
      const first = await request(server)
        .get(`/v1/matches/${MATCH}/chat`)
        .set("Authorization", `Bearer ${tokenFor(A)}`);
      expect(presence.presenceOf(MATCH, A).inChat).toBe(true);

      const req = http.get({
        host: "127.0.0.1",
        port,
        path: `/v1/matches/${MATCH}/chat?after=${first.body.version}`,
        headers: { Authorization: `Bearer ${tokenFor(A)}` },
      });
      req.on("error", () => undefined);
      await until(() => presence.heldReadCount(MATCH) === 1);
      req.destroy();

      await until(() => presence.heldReadCount(MATCH) === 0);
      await until(() => !presence.presenceOf(MATCH, A).inChat);
      // Still in the app — only the chat screen went away.
      expect(presence.presenceOf(MATCH, A).online).toBe(true);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe("POST /chat/presence", () => {
  it("answers with the partner, never with the caller", async () => {
    const app = makeApp();
    const typing = await request(app)
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .send({ place: "chat", typing: true });
    expect(typing.status).toBe(200);
    expect(typing.body.partnerPresence).toEqual({ online: false, inChat: false, typing: false });

    const seen = await request(app)
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(B)}`)
      .send({ place: "app" });
    expect(seen.status).toBe(200);
    expect(seen.body.partnerPresence).toEqual({ online: true, inChat: true, typing: true });
  });

  it("wakes the partner's held read when typing starts", async () => {
    const app = makeApp(5_000);
    const first = await request(app)
      .get(`/v1/matches/${MATCH}/chat`)
      .set("Authorization", `Bearer ${tokenFor(A)}`);
    const held = request(app)
      .get(`/v1/matches/${MATCH}/chat?after=${first.body.version}`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .then((r) => r);
    await until(() => presence.heldReadCount(MATCH) === 1);

    await request(app)
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(B)}`)
      .send({ place: "chat", typing: true });

    const res = await held;
    expect(res.body.partnerPresence.typing).toBe(true);
  });

  it("clears on 'away'", async () => {
    const app = makeApp();
    await request(app)
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .send({ place: "app" });
    expect(presence.presenceOf(MATCH, A).online).toBe(true);
    const res = await request(app)
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .send({ place: "away" });
    expect(res.status).toBe(200);
    expect(presence.presenceOf(MATCH, A).online).toBe(false);
  });

  /** Outside the window nothing is recorded, and the app is told to stop beating. */
  it("is 409 closed outside the window, and records nothing", async () => {
    agreedTime = new Date(Date.now() + 5 * 60 * 60_000);
    const res = await request(makeApp())
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .send({ place: "app" });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("closed");
    expect(presence.presenceOf(MATCH, A).online).toBe(false);
  });

  it.each([
    [{ place: "moon" }],
    [{}],
    [{ place: "chat", typing: "yes" }],
  ])("is 400 on a malformed beat %j", async (body) => {
    const res = await request(makeApp())
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor(A)}`)
      .send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("bad-presence");
  });

  it("is 403 for a stranger", async () => {
    const res = await request(makeApp())
      .post(`/v1/matches/${MATCH}/chat/presence`)
      .set("Authorization", `Bearer ${tokenFor("55555555-5555-4555-8555-555555555555")}`)
      .send({ place: "app" });
    expect(res.status).toBe(403);
  });
});
