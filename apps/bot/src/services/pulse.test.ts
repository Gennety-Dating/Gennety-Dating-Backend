import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  user: { findUnique: vi.fn() },
  match: { findFirst: vi.fn() },
  noMatchNotice: { findFirst: vi.fn() },
  inboxItem: { findMany: vi.fn(), findFirst: vi.fn() },
};
vi.mock("@gennety/db", () => ({ prisma: db }));

const previousBatch = vi.fn();
vi.mock("./next-batch.js", () => ({ getPreviousBatchDate: (now: Date) => previousBatch(now) }));
vi.mock("./chat-sessions.js", () => ({ listChatSessions: async () => ({ sessions: [], hasMore: false }) }));

const { announcementRows, buildPulse, dropBatchRow } = await import("./pulse.js");

const USER = "11111111-1111-4111-8111-111111111111";
const BATCH = new Date("2026-09-13T15:00:00Z");
const minutesAfter = (m: number) => new Date(BATCH.getTime() + m * 60_000);

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset();
  previousBatch.mockReturnValue(BATCH);
  db.match.findFirst.mockResolvedValue(null);
  db.noMatchNotice.findFirst.mockResolvedValue(null);
  db.inboxItem.findMany.mockResolvedValue([]);
  db.inboxItem.findFirst.mockResolvedValue(null);
});

describe("dropBatchRow — F2: only a real, bounded job spins", () => {
  it("spins in the minutes after the batch, with the window's end as its deadline", async () => {
    const row = await dropBatchRow(USER, minutesAfter(5));
    expect(row).toMatchObject({
      kind: "drop_batch",
      state: "processing",
      deadlineAt: minutesAfter(20).toISOString(),
    });
  });

  it("stops the moment the window closes, whatever else is true", async () => {
    expect(await dropBatchRow(USER, minutesAfter(20))).toBeNull();
    expect(db.match.findFirst).not.toHaveBeenCalled();
  });

  it("stops once the outcome exists — a match or the no-match notice", async () => {
    db.noMatchNotice.findFirst.mockResolvedValue({ id: "n1" });
    expect(await dropBatchRow(USER, minutesAfter(16))).toBeNull();
    db.noMatchNotice.findFirst.mockResolvedValue(null);
    db.match.findFirst.mockResolvedValue({ id: "m1" });
    expect(await dropBatchRow(USER, minutesAfter(3))).toBeNull();
  });
});

describe("announcementRows", () => {
  it("keeps unread as active and at most one read as past", async () => {
    const at = BATCH;
    db.inboxItem.findMany.mockResolvedValue([
      { id: "a", title: "A", body: "a", createdAt: at, readAt: null },
      { id: "b", title: "B", body: "b", createdAt: at, readAt: at },
      { id: "c", title: "C", body: "c", createdAt: at, readAt: at },
    ]);
    const rows = await announcementRows(USER, BATCH);
    expect(rows.active.map((r) => r.id)).toEqual(["announcement:a"]);
    expect(rows.past.map((r) => r.id)).toEqual(["announcement:b"]);
    expect(rows.past[0]?.state).toBe("past");
  });
});

describe("buildPulse", () => {
  it("never spins the drop for someone who is not in the pool", async () => {
    db.user.findUnique.mockResolvedValue({ status: "paused" });
    const rows = await buildPulse(USER, { now: minutesAfter(5) });
    expect(rows.find((r) => r.kind === "drop_batch")).toBeUndefined();
  });

  it("puts running work first", async () => {
    db.user.findUnique.mockResolvedValue({ status: "active" });
    db.inboxItem.findMany.mockResolvedValue([{ id: "a", title: "A", body: "a", createdAt: BATCH, readAt: null }]);
    const rows = await buildPulse(USER, { now: minutesAfter(5) });
    expect(rows.map((r) => r.state)).toEqual(["processing", "active"]);
  });

  /**
   * Chat rows are CHATS since 2026-09-30: one per recent session, titled with
   * the chat's title, the session id as target. The kind stays `chat_topic` for
   * builds that open the chat by it.
   */
  it("lists the recent chats as past rows keyed by the session", async () => {
    db.user.findUnique.mockResolvedValue({ status: "paused" });
    const sessions = vi.fn(async () => ({
      sessions: [
        {
          id: "s-2",
          title: "Дресс-код на свидание",
          createdAt: "2026-09-12T10:00:00.000Z",
          updatedAt: "2026-09-13T09:00:00.000Z",
          messageCount: 4,
        },
        {
          id: "s-1",
          title: "Почему нет пары",
          createdAt: "2026-09-10T10:00:00.000Z",
          updatedAt: "2026-09-10T11:00:00.000Z",
          messageCount: 2,
        },
      ],
      hasMore: true,
    }));

    const rows = await buildPulse(USER, { now: minutesAfter(30), sessions });

    expect(sessions).toHaveBeenCalledWith(USER, { limit: 2 });
    expect(rows).toEqual([
      expect.objectContaining({
        id: "chat_topic:s-2",
        kind: "chat_topic",
        state: "past",
        title: "Дресс-код на свидание",
        at: "2026-09-13T09:00:00.000Z",
        target: { kind: "chat_topic", id: "s-2" },
      }),
      expect.objectContaining({ id: "chat_topic:s-1", target: { kind: "chat_topic", id: "s-1" } }),
    ]);
  });

  it("a failing chat list costs the pulse its chat rows, not the pulse", async () => {
    db.user.findUnique.mockResolvedValue({ status: "paused" });
    const sessions = vi.fn(async () => {
      throw new Error("db down");
    });
    const rows = await buildPulse(USER, { now: minutesAfter(30), sessions });
    expect(rows).toEqual([]);
  });
});
