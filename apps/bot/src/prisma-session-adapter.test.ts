import { describe, it, expect, vi, beforeEach } from "vitest";
import { Api, Context, session } from "grammy";

vi.mock("@gennety/db", () => ({
  prisma: {
    botSession: {
      findUnique: vi.fn(),
      upsert: vi.fn(),
      deleteMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import { prisma } from "@gennety/db";
import {
  canonicalSessionJson,
  forgetSessionSnapshot,
  prismaSessionAdapter,
  telegramIdOfSessionKey,
} from "./prisma-session-adapter.js";

const findSession = prisma.botSession.findUnique as ReturnType<typeof vi.fn>;
const upsertSession = prisma.botSession.upsert as ReturnType<typeof vi.fn>;
const deleteSessions = prisma.botSession.deleteMany as ReturnType<typeof vi.fn>;
const findUser = prisma.user.findUnique as ReturnType<typeof vi.fn>;

describe("prismaSessionAdapter", () => {
  const adapter = prismaSessionAdapter<{ count: number }>();

  beforeEach(() => {
    vi.clearAllMocks();
    upsertSession.mockResolvedValue({});
    deleteSessions.mockResolvedValue({ count: 1 });
    findUser.mockResolvedValue({ id: "user-1" });
    forgetSessionSnapshot("user:123");
    forgetSessionSnapshot("123");
  });

  it("read returns undefined when no row exists", async () => {
    findSession.mockResolvedValue(null);

    const result = await adapter.read("user:123");
    expect(result).toBeUndefined();
    expect(prisma.botSession.findUnique).toHaveBeenCalledWith({
      where: { key: "user:123" },
    });
  });

  it("read returns parsed data when row exists", async () => {
    findSession.mockResolvedValue({
      key: "user:123",
      data: { count: 42 },
    });

    const result = await adapter.read("user:123");
    expect(result).toEqual({ count: 42 });
  });

  it("write upserts session data", async () => {
    await adapter.write("user:123", { count: 7 });

    expect(prisma.botSession.upsert).toHaveBeenCalledWith({
      where: { key: "user:123" },
      create: { key: "user:123", data: { count: 7 } },
      update: { data: { count: 7 } },
    });
  });

  it("delete removes the session row", async () => {
    await adapter.delete("user:123");

    expect(prisma.botSession.deleteMany).toHaveBeenCalledWith({
      where: { key: "user:123" },
    });
  });
});

describe("prismaSessionAdapter — write-back of an unchanged session", () => {
  type Session = {
    count: number;
    tags?: string[];
    nested?: { a: number; b: number };
    stamp?: Date | string;
    gone?: undefined;
  };
  const adapter = prismaSessionAdapter<Session>({ count: 0 });
  const KEY = "123";

  beforeEach(() => {
    vi.clearAllMocks();
    upsertSession.mockResolvedValue({});
    deleteSessions.mockResolvedValue({ count: 1 });
    findUser.mockResolvedValue({ id: "user-1" });
    forgetSessionSnapshot(KEY);
  });

  async function readRow(data: unknown): Promise<Session> {
    findSession.mockResolvedValue({ key: KEY, data });
    const session = await adapter.read(KEY);
    if (!session) throw new Error("expected a session");
    return session;
  }

  it("skips the UPSERT when the session is what the row already holds", async () => {
    const session = await readRow({ count: 3, tags: ["x"] });

    await adapter.write(KEY, session);

    expect(upsertSession).not.toHaveBeenCalled();
    // The account check is by the typed bigint key, through the unique index.
    expect(findUser).toHaveBeenCalledWith({
      where: { telegramId: 123n },
      select: { id: true },
    });
  });

  it("compares JSON values, not key order (jsonb returns its own order)", async () => {
    await readRow({ nested: { b: 2, a: 1 }, count: 3 });

    await adapter.write(KEY, { count: 3, nested: { a: 1, b: 2 } });

    expect(upsertSession).not.toHaveBeenCalled();
  });

  it("writes when a handler changed the session, including a nested mutation", async () => {
    const session = await readRow({ count: 3, tags: ["x"] });
    session.tags?.push("y");

    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledWith({
      where: { key: KEY },
      create: { key: KEY, data: session },
      update: { data: session },
    });
    expect(findUser).not.toHaveBeenCalled();
  });

  it("writes when the defaults add a key the stored row does not have yet", async () => {
    const session = await readRow({ tags: [] });

    expect(session).toEqual({ count: 0, tags: [] });
    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("treats a value the Json column would store identically as unchanged", async () => {
    // `undefined` is dropped and a Date is stored as its ISO string — exactly
    // what the column write does with them.
    const at = new Date("2026-10-13T10:00:00.000Z");
    await readRow({ count: 1, stamp: at.toISOString() });

    await adapter.write(KEY, { count: 1, stamp: at, gone: undefined });

    expect(upsertSession).not.toHaveBeenCalled();
  });

  it("still writes a row no user owns, so the orphan sweep keeps seeing activity", async () => {
    findUser.mockResolvedValue(null);
    const session = await readRow({ count: 3 });

    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("still writes when the account check fails", async () => {
    findUser.mockRejectedValue(new Error("pool timeout"));
    const session = await readRow({ count: 3 });

    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("still writes a key no user can own, without asking the database", async () => {
    const customKey = "user:42";
    findSession.mockResolvedValue({ key: customKey, data: { count: 3 } });
    const session = await adapter.read(customKey);
    if (!session) throw new Error("expected a session");

    await adapter.write(customKey, session);

    expect(findUser).not.toHaveBeenCalled();
    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("writes when nothing was read for the key first", async () => {
    await adapter.write(KEY, { count: 3 });

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("uses a snapshot once: a second write-back without a new read writes", async () => {
    const session = await readRow({ count: 3 });

    await adapter.write(KEY, session);
    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("writes after a row that was absent on read (grammY's initial value)", async () => {
    findSession.mockResolvedValue({ key: KEY, data: { count: 3 } });
    await adapter.read(KEY);
    findSession.mockResolvedValue(null);
    expect(await adapter.read(KEY)).toBeUndefined();

    await adapter.write(KEY, { count: 3 });

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("writes after a delete of the row", async () => {
    const session = await readRow({ count: 3 });

    await adapter.delete(KEY);
    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("writes after an out-of-band writer forgot the snapshot", async () => {
    const session = await readRow({ count: 3 });

    forgetSessionSnapshot(KEY);
    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });

  it("re-reads replace the snapshot, so a row changed between updates is compared fresh", async () => {
    await readRow({ count: 3 });
    // Another writer stored count 4; the next update reads that…
    const session = await readRow({ count: 4 });
    // …and a handler that puts back count 3 must be written.
    session.count = 3;

    await adapter.write(KEY, session);

    expect(upsertSession).toHaveBeenCalledTimes(1);
  });
});

describe("prismaSessionAdapter under grammY's session middleware", () => {
  type Session = { count: number };

  function textUpdateContext(): Context & { session: Session } {
    const ctx = new Context(
      {
        update_id: 1,
        message: {
          message_id: 10,
          date: 0,
          chat: { id: 123, type: "private", first_name: "A" },
          from: { id: 123, is_bot: false, first_name: "A" },
          text: "hi",
        },
      },
      new Api("test-token"),
      { id: 1, is_bot: true, first_name: "bot", username: "bot" } as never,
    );
    return Object.assign(ctx, { session: { count: 0 } });
  }

  const middleware = session<Session, Context & { session: Session }>({
    initial: () => ({ count: 0 }),
    storage: prismaSessionAdapter<Session>({ count: 0 }),
  });

  beforeEach(() => {
    vi.clearAllMocks();
    upsertSession.mockResolvedValue({});
    findUser.mockResolvedValue({ id: "user-1" });
    forgetSessionSnapshot("123");
    findSession.mockResolvedValue({ key: "123", data: { count: 5 } });
  });

  it("an update that only reads the session costs one SELECT and no UPSERT", async () => {
    const ctx = textUpdateContext();
    await middleware(ctx, async () => {
      expect(ctx.session.count).toBe(5);
    });

    expect(findSession).toHaveBeenCalledTimes(1);
    expect(upsertSession).not.toHaveBeenCalled();
  });

  it("an update that changes the session is written back as before", async () => {
    const ctx = textUpdateContext();
    await middleware(ctx, async () => {
      ctx.session.count += 1;
    });

    expect(upsertSession).toHaveBeenCalledWith({
      where: { key: "123" },
      create: { key: "123", data: { count: 6 } },
      update: { data: { count: 6 } },
    });
  });
});

describe("canonicalSessionJson", () => {
  it("sorts object keys at every depth and keeps array order", () => {
    expect(canonicalSessionJson({ b: [2, 1], a: { d: 1, c: null } })).toBe(
      '{"a":{"c":null,"d":1},"b":[2,1]}',
    );
  });

  it("is null for a value the column could not store", () => {
    expect(canonicalSessionJson({ id: 1n })).toBeNull();
    expect(canonicalSessionJson(undefined)).toBeNull();
  });
});

describe("telegramIdOfSessionKey", () => {
  it("accepts exactly the text Postgres prints for a bigint", () => {
    expect(telegramIdOfSessionKey("123456789")).toBe(123456789n);
    expect(telegramIdOfSessionKey("-1001234567890")).toBe(-1001234567890n);
    expect(telegramIdOfSessionKey("0")).toBe(0n);
    expect(telegramIdOfSessionKey("9223372036854775807")).toBe(9223372036854775807n);
    expect(telegramIdOfSessionKey("-9223372036854775808")).toBe(-9223372036854775808n);
  });

  it("rejects keys no bigint prints as", () => {
    for (const key of ["", "-0", "007", "+5", " 5", "5 ", "1e3", "user:123", "9223372036854775808", "12345678901234567890"]) {
      expect(telegramIdOfSessionKey(key)).toBeNull();
    }
  });
});
