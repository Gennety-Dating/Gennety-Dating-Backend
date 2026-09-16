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
vi.mock("./chat-topics.js", () => ({ listChatTopics: async () => ({ topics: [], hasMore: false }) }));

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
});
