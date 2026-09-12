import { beforeEach, describe, expect, it, vi } from "vitest";

const db = {
  user: { findUnique: vi.fn() },
  match: { findFirst: vi.fn() },
  noMatchNotice: { findFirst: vi.fn() },
  waitlistApplication: { findMany: vi.fn() },
  inboxItem: { findMany: vi.fn(), findFirst: vi.fn() },
};
vi.mock("@gennety/db", () => ({ prisma: db }));

const previousBatch = vi.fn();
vi.mock("./next-batch.js", () => ({ getPreviousBatchDate: (now: Date) => previousBatch(now) }));
vi.mock("./chat-topics.js", () => ({ listChatTopics: async () => ({ topics: [], hasMore: false }) }));

const { announcementRows, buildPulse, dropBatchRow, eventRows } = await import("./pulse.js");

const USER = "11111111-1111-4111-8111-111111111111";
const BATCH = new Date("2026-09-13T15:00:00Z");
const minutesAfter = (m: number) => new Date(BATCH.getTime() + m * 60_000);

beforeEach(() => {
  for (const model of Object.values(db)) for (const fn of Object.values(model)) fn.mockReset();
  previousBatch.mockReturnValue(BATCH);
  db.match.findFirst.mockResolvedValue(null);
  db.noMatchNotice.findFirst.mockResolvedValue(null);
  db.waitlistApplication.findMany.mockResolvedValue([]);
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

describe("eventRows", () => {
  const event = {
    id: "44444444-4444-4444-8444-444444444444",
    title: "Launch Night",
    venueName: "Sens",
    startsAt: new Date("2026-09-18T18:00:00Z"),
  };

  it.each([
    ["approved", "approved"],
    ["auto_approved", "approved"],
    ["pending_review", "pending"],
    ["screening", "pending"],
    ["waitlisted", "waitlisted"],
  ])("maps tier %s to %s, as a still row", async (tier, status) => {
    db.waitlistApplication.findMany.mockResolvedValue([{ tier, event }]);
    const [row] = await eventRows(USER, BATCH);
    expect(row).toMatchObject({ kind: "event_application", state: "active", status, title: "Launch Night" });
  });

  it("opens the announcement about the event when it is in the inbox", async () => {
    db.waitlistApplication.findMany.mockResolvedValue([{ tier: "approved", event }]);
    db.inboxItem.findMany.mockResolvedValue([{ id: "i1", announcement: { eventId: event.id } }]);
    const [row] = await eventRows(USER, BATCH);
    expect(row?.target).toEqual({ kind: "inbox_item", id: "i1" });
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

  it("shows a party once: the event row, not also its announcement", async () => {
    db.user.findUnique.mockResolvedValue({ status: "active" });
    db.waitlistApplication.findMany.mockResolvedValue([
      {
        tier: "approved",
        event: { id: "e1", title: "Launch Night", venueName: "Sens", startsAt: BATCH },
      },
    ]);
    // `announcementRows` and `eventRows` both read the inbox concurrently; answer
    // by the kind of select each one makes rather than by call order.
    db.inboxItem.findMany.mockImplementation(async (args: { select: Record<string, unknown> }) =>
      "announcement" in args.select
        ? [{ id: "i1", announcement: { eventId: "e1" } }]
        : [{ id: "i1", title: "Launch Night", body: "Friday", createdAt: BATCH, readAt: null }],
    );

    const rows = await buildPulse(USER, { now: minutesAfter(30) });

    expect(rows.map((r) => r.kind)).toEqual(["event_application"]);
  });

  it("puts running work first", async () => {
    db.user.findUnique.mockResolvedValue({ status: "active" });
    db.inboxItem.findMany.mockResolvedValue([{ id: "a", title: "A", body: "a", createdAt: BATCH, readAt: null }]);
    const rows = await buildPulse(USER, { now: minutesAfter(5) });
    expect(rows.map((r) => r.state)).toEqual(["processing", "active"]);
  });
});
