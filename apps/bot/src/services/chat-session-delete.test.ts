import { beforeEach, describe, expect, it, vi } from "vitest";

/** Deleting a chat for good (decision 2026-11-22). */

const order: string[] = [];
const db = {
  chatSession: { findFirst: vi.fn(), findMany: vi.fn(), deleteMany: vi.fn() },
  message: { findMany: vi.fn(), count: vi.fn() },
  agentMemory: { deleteMany: vi.fn() },
  agentReminder: { updateMany: vi.fn() },
  $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
    order.push("rows");
    return work(db);
  }),
};
vi.mock("@gennety/db", () => ({ prisma: db }));
vi.mock("../config.js", () => ({ env: { SUPABASE_CHAT_BUCKET: "chat" } }));
const deleteStorageObject = vi.fn(async (_b: string, _p: string) => {
  order.push("photo");
  return true;
});
vi.mock("./storage.js", () => ({ deleteStorageObject: (b: string, p: string) => deleteStorageObject(b, p) }));

const { deleteArchivedChats, deleteChatSession } = await import("./chat-session-delete.js");
const { withChatLock } = await import("./chat-turn-lock.js");

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  order.length = 0;
  for (const group of [db.chatSession, db.message, db.agentMemory, db.agentReminder]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  db.chatSession.findFirst.mockResolvedValue({ id: CHAT });
  db.message.findMany.mockResolvedValue([]);
  db.message.count.mockResolvedValue(0);
  deleteStorageObject.mockClear();
});

describe("deleteChatSession", () => {
  it("erases the photos first, then the rows", async () => {
    db.message.findMany.mockResolvedValue([
      { imageUrl: `${USER}/1.jpg`, imageUrls: [`${USER}/1.jpg`, `${USER}/2.jpg`] },
    ]);
    expect(await deleteChatSession(USER, CHAT, { forget: false })).toBe("deleted");
    expect(deleteStorageObject.mock.calls).toEqual([["chat", `${USER}/1.jpg`], ["chat", `${USER}/2.jpg`]]);
    expect(order).toEqual(["photo", "photo", "rows"]);
    expect(db.chatSession.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, id: { in: [CHAT] } } });
  });

  it("a photo that could not be erased stops everything", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    db.message.findMany.mockResolvedValue([{ imageUrl: null, imageUrls: [`${USER}/1.jpg`] }]);
    deleteStorageObject.mockResolvedValueOnce(false);
    expect(await deleteChatSession(USER, CHAT, { forget: true })).toBe("storage");
    expect(db.chatSession.deleteMany).not.toHaveBeenCalled();
    expect(db.agentMemory.deleteMany).not.toHaveBeenCalled();
  });

  it("a photo another chat also shows stays", async () => {
    db.message.findMany.mockResolvedValue([{ imageUrl: null, imageUrls: [`${USER}/1.jpg`] }]);
    db.message.count.mockResolvedValueOnce(1);
    expect(await deleteChatSession(USER, CHAT, { forget: false })).toBe("deleted");
    expect(deleteStorageObject).not.toHaveBeenCalled();
  });

  it("someone else's path in a row is never touched", async () => {
    db.message.findMany.mockResolvedValue([{ imageUrl: "99999999-9999-4999-8999-999999999999/1.jpg", imageUrls: [] }]);
    await deleteChatSession(USER, CHAT, { forget: false });
    expect(deleteStorageObject).not.toHaveBeenCalled();
  });

  it("forgets the notes only when asked; reminders stay and lose the link", async () => {
    await deleteChatSession(USER, CHAT, { forget: false });
    expect(db.agentMemory.deleteMany).not.toHaveBeenCalled();
    await deleteChatSession(USER, CHAT, { forget: true });
    expect(db.agentMemory.deleteMany).toHaveBeenCalledWith({ where: { userId: USER, sourceSessionId: { in: [CHAT] } } });
    expect(db.agentReminder.updateMany).toHaveBeenCalledWith({
      where: { userId: USER, sessionId: { in: [CHAT] } },
      data: { sessionId: null },
    });
  });

  it("a foreign, unknown or malformed id deletes nothing", async () => {
    db.chatSession.findFirst.mockResolvedValue(null);
    expect(await deleteChatSession(USER, CHAT, { forget: true })).toBe("unknown");
    expect(await deleteChatSession(USER, "archived", { forget: true })).toBe("unknown");
    expect(db.chatSession.deleteMany).not.toHaveBeenCalled();
  });

  it("waits for a reply in flight", async () => {
    let finish = () => {};
    const turn = withChatLock(USER, () => new Promise<void>((resolve) => { finish = () => { order.push("reply"); resolve(); }; }));
    const deletion = deleteChatSession(USER, CHAT, { forget: false });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(db.chatSession.deleteMany).not.toHaveBeenCalled();
    finish();
    await Promise.all([turn, deletion]);
    expect(order).toEqual(["reply", "rows"]);
  });
});

describe("deleteArchivedChats", () => {
  it("deletes what is archived and says how many", async () => {
    db.chatSession.findMany.mockResolvedValue([{ id: CHAT }, { id: "b" }]);
    expect(await deleteArchivedChats(USER, { forget: false })).toEqual({ outcome: "deleted", deleted: 2 });
    expect(db.chatSession.findMany).toHaveBeenCalledWith({
      where: { userId: USER, archivedAt: { not: null } },
      select: { id: true },
    });
  });

  it("an empty archive is nothing to do", async () => {
    db.chatSession.findMany.mockResolvedValue([]);
    expect(await deleteArchivedChats(USER, { forget: true })).toEqual({ outcome: "deleted", deleted: 0 });
    expect(db.$transaction).not.toHaveBeenCalled();
  });
});

describe("withChatLock", () => {
  it("a failed piece of work does not block the next one", async () => {
    await expect(withChatLock(USER, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(await withChatLock(USER, async () => 7)).toBe(7);
  });
});
