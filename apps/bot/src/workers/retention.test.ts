import { beforeEach, describe, expect, it, vi } from "vitest";

const emailOtp = { findMany: vi.fn(), deleteMany: vi.fn() };
const phoneOtp = { findMany: vi.fn(), deleteMany: vi.fn() };
const userSession = { findMany: vi.fn(), deleteMany: vi.fn() };
const proxyMessage = { findMany: vi.fn(), deleteMany: vi.fn() };
const chatEvent = { findMany: vi.fn(), deleteMany: vi.fn() };
const clientEvent = { findMany: vi.fn(), deleteMany: vi.fn() };
const eventFeedback = { findMany: vi.fn(), deleteMany: vi.fn() };
const $executeRaw = vi.fn();

vi.mock("@gennety/db", () => ({
  prisma: {
    emailOtp,
    phoneOtp,
    userSession,
    proxyMessage,
    chatEvent,
    clientEvent,
    eventFeedback,
    $executeRaw,
  },
}));

const {
  retentionTick,
  OTP_RETENTION_MS,
  SESSION_RETENTION_MS,
  PROXY_MESSAGE_RETENTION_MS,
  CHAT_EVENT_RETENTION_MS,
  CLIENT_EVENT_RETENTION_MS,
  EVENT_FEEDBACK_RETENTION_MS,
  ORPHAN_SESSION_RETENTION_MS,
} = await import("./retention.js");

const NOW = new Date("2026-08-01T03:45:00.000Z");

beforeEach(() => {
  for (const model of [emailOtp, phoneOtp, userSession, proxyMessage, chatEvent, clientEvent, eventFeedback]) {
    model.findMany.mockReset().mockResolvedValue([]);
    model.deleteMany.mockReset().mockResolvedValue({ count: 0 });
  }
  $executeRaw.mockReset().mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("retentionTick", () => {
  it("is a no-op when nothing is old enough", async () => {
    const result = await retentionTick(NOW);
    expect(result).toEqual({
      emailOtps: 0,
      phoneOtps: 0,
      sessions: 0,
      proxyMessages: 0,
      chatEvents: 0,
      clientEvents: 0,
      eventFeedback: 0,
      orphanBotSessions: 0,
    });
    for (const model of [emailOtp, phoneOtp, userSession, proxyMessage, chatEvent, clientEvent, eventFeedback]) {
      expect(model.deleteMany).not.toHaveBeenCalled();
    }
  });

  it("deletes aged OTP challenges by id, oldest first", async () => {
    emailOtp.findMany.mockResolvedValue([{ id: "e1" }, { id: "e2" }]);
    emailOtp.deleteMany.mockResolvedValue({ count: 2 });

    const result = await retentionTick(NOW);

    expect(emailOtp.findMany.mock.calls[0][0]).toMatchObject({
      where: { createdAt: { lt: new Date(NOW.getTime() - OTP_RETENTION_MS) } },
      orderBy: { createdAt: "asc" },
    });
    expect(emailOtp.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["e1", "e2"] } },
    });
    expect(result.emailOtps).toBe(2);
  });

  it("sweeps phone OTPs — the numbers no user cascade can reach", async () => {
    // `phone_otps` is keyed by NUMBER, not by user, because the funnel starts
    // before a User row exists. Numbers of people who never finished signing up
    // therefore survive a GDPR account deletion; this sweep is what removes them.
    phoneOtp.findMany.mockResolvedValue([{ id: "p1" }]);
    phoneOtp.deleteMany.mockResolvedValue({ count: 1 });

    const result = await retentionTick(NOW);

    expect(result.phoneOtps).toBe(1);
    expect(phoneOtp.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - OTP_RETENTION_MS) },
    });
  });

  it("never sweeps a session that is still usable, or one inside the reuse-detection window", async () => {
    // rotateRefreshToken detects a stolen token by finding an already-REVOKED
    // session by hash and revoking the whole family. Deleting revoked rows too
    // early silently degrades that to "token not found".
    await retentionTick(NOW);

    const cutoff = new Date(NOW.getTime() - SESSION_RETENTION_MS);
    const where = userSession.findMany.mock.calls[0][0].where;
    expect(where.expiresAt).toEqual({ lt: cutoff });
    expect(where.OR).toEqual([
      { revokedAt: null },
      { revokedAt: { lt: cutoff } },
    ]);
  });

  it("keeps proxy messages for the full moderation window", async () => {
    await retentionTick(NOW);
    expect(proxyMessage.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - PROXY_MESSAGE_RETENTION_MS) },
    });
    // 90 days — the same window the reference-selfie scrub uses.
    expect(PROXY_MESSAGE_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("sweeps the chat timeline on a shorter, 30-day window", async () => {
    // The timeline is what the concierge agent reads to answer a follow-up
    // ("why?") against the message above it — a question of minutes. It holds
    // message text, so it gets the shortest window of the four.
    await retentionTick(NOW);
    expect(chatEvent.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - CHAT_EVENT_RETENTION_MS) },
    });
    expect(CHAT_EVENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("sweeps the client funnel by RECEIPT time, on the 90 days the manifest promises", async () => {
    // `occurredAt` — часы устройства: телефон со сбитой датой либо пережил бы
    // ретеншен, либо был бы стёрт в день приёма. Считаем по своим часам.
    await retentionTick(NOW);
    expect(clientEvent.findMany.mock.calls[0][0]).toMatchObject({
      where: { receivedAt: { lt: new Date(NOW.getTime() - CLIENT_EVENT_RETENTION_MS) } },
      orderBy: { receivedAt: "asc" },
    });
    // Срок — обещание из privacy manifest приложения, а не техническая величина.
    expect(CLIENT_EVENT_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("names the client funnel in the log line — иначе свип не оставляет следа", async () => {
    // Строка лога — единственный признак, что свип отработал. Пока
    // `clientEvents` не входил в сумму, тик, удаливший ТОЛЬКО события клиента,
    // молчал целиком.
    clientEvent.findMany.mockResolvedValue([{ id: "c1" }]);
    clientEvent.deleteMany.mockResolvedValue({ count: 1 });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    const result = await retentionTick(NOW);

    expect(result.clientEvents).toBe(1);
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0][0])).toContain("clientEvents=1");
  });

  it("keeps an `unsafe` event-feedback row forever, and says so in SQL", async () => {
    // The exemption is written as an explicit OR rather than
    // `NOT (safety = 'unsafe')`, because in SQL a NULL comparison is neither
    // true nor false — the negation would silently retain every row that
    // carried no safety answer at all, which is most of them.
    await retentionTick(NOW);
    const where = eventFeedback.findMany.mock.calls[0][0].where;
    expect(where.createdAt).toEqual({
      lt: new Date(NOW.getTime() - EVENT_FEEDBACK_RETENTION_MS),
    });
    expect(where.OR).toEqual([{ safety: null }, { safety: { not: "unsafe" } }]);
    // Same window as the proxy-chat log and the reference selfie.
    expect(EVENT_FEEDBACK_RETENTION_MS).toBe(90 * 24 * 60 * 60 * 1000);
  });

  it("batches each table so one tick cannot run away", async () => {
    await retentionTick(NOW);
    for (const model of [emailOtp, phoneOtp, userSession, proxyMessage, chatEvent, clientEvent, eventFeedback]) {
      expect(model.findMany.mock.calls[0][0].take).toBe(1_000);
    }
  });

  it("reports per-table counts", async () => {
    emailOtp.findMany.mockResolvedValue([{ id: "e1" }]);
    emailOtp.deleteMany.mockResolvedValue({ count: 1 });
    proxyMessage.findMany.mockResolvedValue([{ id: "m1" }, { id: "m2" }]);
    proxyMessage.deleteMany.mockResolvedValue({ count: 2 });

    const result = await retentionTick(NOW);

    expect(result).toEqual({
      emailOtps: 1,
      phoneOtps: 0,
      sessions: 0,
      proxyMessages: 2,
      chatEvents: 0,
      clientEvents: 0,
      eventFeedback: 0,
      orphanBotSessions: 0,
    });
  });

  describe("orphaned chat sessions", () => {
    /** The tagged-template call: [strings, ...values]. */
    function rawCall() {
      const call = $executeRaw.mock.calls[0];
      return { sql: (call[0] as string[]).join("?"), values: call.slice(1) };
    }

    it("anti-joins bot_sessions against users, since no relation exists", async () => {
      await retentionTick(NOW);
      const { sql } = rawCall();
      expect(sql).toContain("DELETE FROM bot_sessions");
      // The coupling the schema does not express: chat id as text.
      expect(sql).toContain("u.telegram_id::text = b.key");
      expect(sql).toContain("u.id IS NULL");
    });

    it("will not race registration — only sessions untouched for a week", async () => {
      // `sessionMiddleware` runs before the handler that creates the `User`
      // row, so a chat mid-`/start` legitimately has a session and no user.
      // Without the floor this sweep would delete a live session.
      await retentionTick(NOW);
      const { values } = rawCall();
      expect(values).toContainEqual(new Date(NOW.getTime() - ORPHAN_SESSION_RETENTION_MS));
      expect(ORPHAN_SESSION_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);
    });

    it("is batched like every other table", async () => {
      await retentionTick(NOW);
      expect(rawCall().values).toContain(1_000);
    });

    it("counts what it deleted", async () => {
      $executeRaw.mockResolvedValue(5);
      const result = await retentionTick(NOW);
      expect(result.orphanBotSessions).toBe(5);
    });
  });
});
