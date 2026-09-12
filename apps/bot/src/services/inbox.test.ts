import { beforeEach, describe, expect, it, vi } from "vitest";

const inbox = {
  create: vi.fn(),
  count: vi.fn(),
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  updateMany: vi.fn(),
};
vi.mock("@gennety/db", () => ({ prisma: { inboxItem: inbox } }));

const signed = vi.fn();
vi.mock("./storage.js", () => ({
  createAnnouncementAssetSignedUrl: (path: string, ttl: number) => signed(path, ttl),
}));

const { getInboxItemDetail, listInbox, markInboxRead, recordTransactionalInboxItem } = await import("./inbox.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-13T18:00:00Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: ID,
  type: "announcement",
  title: "Launch Night",
  body: "Friday at Sens",
  createdAt: NOW,
  readAt: null,
  matchId: null,
  announcementId: "33333333-3333-4333-8333-333333333333",
  ...over,
});

beforeEach(() => {
  for (const fn of Object.values(inbox)) fn.mockReset();
  signed.mockReset();
  inbox.count.mockResolvedValue(0);
});

describe("recordTransactionalInboxItem", () => {
  it("keeps a real match id and drops anything that is not one", async () => {
    inbox.create.mockResolvedValue({ id: ID });
    await recordTransactionalInboxItem({
      userId: USER,
      type: "match.proposed",
      title: "T",
      body: "B",
      data: { matchId: "not-a-uuid" },
    });
    expect(inbox.create.mock.calls[0][0].data).toMatchObject({ matchId: null, type: "match.proposed" });
    expect(inbox.create.mock.calls[0][0].data.pushedAt).toBeInstanceOf(Date);
  });
});

describe("listInbox", () => {
  it("pages newest first and reports the unread count", async () => {
    inbox.findMany.mockResolvedValue([row(), row({ id: "b" }), row({ id: "c" })]);
    inbox.count.mockResolvedValue(2);

    const result = await listInbox(USER, { limit: 2 });

    expect(result).toMatchObject({ ok: true, unreadCount: 2, hasMore: true });
    if (result.ok) expect(result.items).toHaveLength(2);
    expect(inbox.findMany.mock.calls[0][0]).toMatchObject({
      where: { userId: USER },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 3,
    });
    expect(inbox.count).toHaveBeenCalledWith({ where: { userId: USER, readAt: null } });
  });

  it("refuses a cursor from someone else's inbox", async () => {
    inbox.findUnique.mockResolvedValue({ userId: OTHER });
    await expect(listInbox(USER, { before: ID })).resolves.toEqual({ ok: false, error: "unknown_cursor" });
    expect(inbox.findMany).not.toHaveBeenCalled();
  });
});

describe("markInboxRead", () => {
  it("scopes the write to the caller and returns the new count", async () => {
    inbox.updateMany.mockResolvedValue({ count: 1 });
    inbox.count.mockResolvedValue(4);

    await expect(markInboxRead(USER, [ID])).resolves.toEqual({ ok: true, unreadCount: 4 });
    expect(inbox.updateMany.mock.calls[0][0]).toMatchObject({
      where: { userId: USER, id: { in: [ID] }, readAt: null },
    });
  });

  it.each([[[]], [["nope"]], ["not-an-array"], [Array.from({ length: 201 }, () => ID)]])(
    "refuses %j",
    async (ids) => {
      await expect(markInboxRead(USER, ids)).resolves.toEqual({ ok: false, error: "invalid_ids" });
      expect(inbox.updateMany).not.toHaveBeenCalled();
    },
  );
});

describe("getInboxItemDetail", () => {
  const withAnnouncement = (media: Record<string, unknown>) =>
    row({
      announcement: {
        body: "A night for everyone.",
        suggestedQuestions: ["What should I wear?"],
        event: null,
        ...media,
      },
    });

  it("signs the video and its poster for a day", async () => {
    inbox.findFirst.mockResolvedValue(
      withAnnouncement({ mediaKind: "video", mediaPath: "a/media.mp4", posterPath: "a/poster.jpg" }),
    );
    signed.mockImplementation(async (path: string) => `https://signed/${path}`);

    const detail = await getInboxItemDetail(USER, ID);

    expect(detail?.announcement?.media).toEqual({
      kind: "video",
      url: "https://signed/a/media.mp4",
      posterUrl: "https://signed/a/poster.jpg",
    });
    expect(signed).toHaveBeenCalledWith("a/media.mp4", 86_400);
    expect(inbox.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: ID, userId: USER } });
  });

  // The words are the announcement; a storage hiccup must not blank the sheet.
  it("drops the media, not the sheet, when signing fails", async () => {
    inbox.findFirst.mockResolvedValue(withAnnouncement({ mediaKind: "image", mediaPath: "a/m.jpg", posterPath: null }));
    signed.mockResolvedValue(null);

    const detail = await getInboxItemDetail(USER, ID);

    expect(detail?.announcement).toEqual({ body: "A night for everyone.", suggestedQuestions: ["What should I wear?"] });
  });

  it("returns a transactional row without an announcement block", async () => {
    inbox.findFirst.mockResolvedValue(row({ type: "match.proposed", announcementId: null, announcement: null }));
    const detail = await getInboxItemDetail(USER, ID);
    expect(detail).toEqual({ item: expect.objectContaining({ type: "match.proposed" }) });
  });
});
