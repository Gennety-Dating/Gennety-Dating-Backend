import { describe, expect, it, vi } from "vitest";

const db = { user: { findUnique: vi.fn() } };
vi.mock("@gennety/db", () => ({ prisma: db }));
vi.mock("./push.js", () => ({ sendPushToUser: vi.fn() }));

const { ChatReplyWaiters, chatReplyPushBody, sendChatReplyPush, CHAT_REPLY_PUSH_TYPE } = await import("./chat-reply-push.js");

describe("ChatReplyWaiters", () => {
  it("one waiter that left: push", () => {
    const waiters = new ChatReplyWaiters();
    const settle = waiters.join("k", () => true);
    expect(settle()).toBe(true);
  });

  it("one waiter still there: no push", () => {
    const waiters = new ChatReplyWaiters();
    expect(waiters.join("k", () => false)()).toBe(false);
  });

  it("two that both left: exactly one push, from the last to settle", () => {
    const waiters = new ChatReplyWaiters();
    const a = waiters.join("k", () => true);
    const b = waiters.join("k", () => true);
    expect(a()).toBe(false);
    expect(b()).toBe(true);
  });

  it("one of two still there: no push either way round", () => {
    const waiters = new ChatReplyWaiters();
    const gone = waiters.join("k", () => true);
    const here = waiters.join("k", () => false);
    expect(here()).toBe(false);
    expect(gone()).toBe(false);
  });

  it("settling twice is a no-op", () => {
    const waiters = new ChatReplyWaiters();
    const settle = waiters.join("k", () => true);
    expect(settle()).toBe(true);
    expect(settle()).toBe(false);
  });
});

describe("chatReplyPushBody", () => {
  it("is the first bubble, on one line, cut for the lock screen", () => {
    expect(chatReplyPushBody("Нашёл.\nТихое кафе.\n\nВторой пузырь")).toBe("Нашёл. Тихое кафе.");
    expect(chatReplyPushBody("x".repeat(300))).toHaveLength(140);
  });
});

describe("sendChatReplyPush", () => {
  it("titles it in the account language and names the chat to open", async () => {
    db.user.findUnique.mockResolvedValue({ language: "ru" });
    const send = vi.fn(async () => true);
    await sendChatReplyPush({ userId: "u1", sessionId: "s1", content: "Привет", send });
    expect(send).toHaveBeenCalledWith("u1", {
      title: "Gennety ответил",
      body: "Привет",
      data: { type: CHAT_REPLY_PUSH_TYPE, sessionId: "s1" },
      collapseId: "chat.reply.s1",
    });
  });

  it("never throws", async () => {
    db.user.findUnique.mockRejectedValue(new Error("db down"));
    await expect(sendChatReplyPush({ userId: "u1", sessionId: "s1", content: "Привет", send: vi.fn() })).resolves.toBe(false);
  });
});
