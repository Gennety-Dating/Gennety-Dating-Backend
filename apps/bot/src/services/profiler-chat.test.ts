import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The Profiler inside the app's chat (decision journal 2026-11-13): the
 * question is a chat row, the next message answers it.
 */

const db = {
  message: { create: vi.fn(), findFirst: vi.fn() },
  profile: { findUnique: vi.fn() },
  chatSession: { updateMany: vi.fn() },
};
vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return { ...actual, prisma: db };
});

const native = {
  getNativeProfilerBatch: vi.fn(),
  answerNativeProfilerQuestion: vi.fn(),
  nativeProfilerQuestionOpen: vi.fn(),
  userLanguage: vi.fn(),
};
vi.mock("./profiler-native.js", () => native);

const {
  answerProfilerInChat,
  matchProfilerOption,
  openProfilerQuestionInChat,
  postDueProfilerQuestion,
  profilerChatText,
  readProfilerChatAttachment,
} = await import("./profiler-chat.js");

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-11-13T12:00:00Z");

const OPEN = { id: "f_date_spots", text: "Where do you like to go on a date?" };
const CLOSED = {
  id: "f_ctx:format:m1",
  text: "How did the format feel?",
  input: {
    kind: "chips" as const,
    closed: true,
    multiple: false,
    options: [
      { id: "great", text: "Just right" },
      { id: "meh", text: "Not my thing" },
    ],
  },
};

let rowSeq = 0;
beforeEach(() => {
  for (const group of [db.message, db.profile, db.chatSession]) {
    for (const fn of Object.values(group)) fn.mockReset();
  }
  for (const fn of Object.values(native)) fn.mockReset();
  native.userLanguage.mockResolvedValue("en");
  db.profile.findUnique.mockResolvedValue({ timeZone: "Europe/Kyiv" });
  db.chatSession.updateMany.mockResolvedValue({ count: 1 });
  rowSeq = 0;
  db.message.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    id: `row-${++rowSeq}`,
    imageUrl: null,
    createdAt: NOW,
    ...data,
  }));
});

describe("readProfilerChatAttachment", () => {
  it("reads only the profiler marker", () => {
    expect(readProfilerChatAttachment({ kind: "profiler_question", questionId: "q" })).toEqual({
      kind: "profiler_question",
      questionId: "q",
    });
    expect(readProfilerChatAttachment({ kind: "wishlist_proposal" })).toBeNull();
    expect(readProfilerChatAttachment(null)).toBeNull();
  });
});

describe("profilerChatText", () => {
  it("an open question is its text alone", () => {
    expect(profilerChatText(OPEN, "en", null)).toBe(OPEN.text);
  });

  it("a closed question numbers its options", () => {
    expect(profilerChatText(CLOSED, "en", null)).toBe(
      "How did the format feel?\n\n1. Just right\n2. Not my thing",
    );
  });
});

describe("matchProfilerOption", () => {
  it("a number or the option's words pick it", () => {
    expect(matchProfilerOption(CLOSED, "2", "en")).toBe("meh");
    expect(matchProfilerOption(CLOSED, " 1. ", "en")).toBe("great");
    expect(matchProfilerOption(CLOSED, "just right", "en")).toBe("great");
  });

  it("anything else is the person's own words", () => {
    expect(matchProfilerOption(CLOSED, "3", "en")).toBeNull();
    expect(matchProfilerOption(CLOSED, "it was fine, honestly", "en")).toBeNull();
    expect(matchProfilerOption(OPEN, "1", "en")).toBeNull();
  });
});

describe("postDueProfilerQuestion", () => {
  it("writes the due question as an assistant row with the marker", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({ question: OPEN, remaining: 3 });
    db.message.findFirst.mockResolvedValue(null);
    const row = await postDueProfilerQuestion(USER, CHAT, NOW);
    expect(row?.content).toBe(OPEN.text);
    expect(db.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: USER,
        sessionId: CHAT,
        role: "assistant",
        attachment: { kind: "profiler_question", questionId: OPEN.id },
      }),
    });
  });

  it("does not ask twice in a chat that already ends with the question", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({ question: OPEN, remaining: 3 });
    db.message.findFirst.mockResolvedValue({
      id: "q1",
      role: "assistant",
      attachment: { kind: "profiler_question", questionId: OPEN.id },
    });
    expect(await postDueProfilerQuestion(USER, CHAT, NOW)).toBeNull();
    expect(db.message.create).not.toHaveBeenCalled();
  });

  it("nothing due — nothing written", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({});
    expect(await postDueProfilerQuestion(USER, CHAT, NOW)).toBeNull();
    expect(db.message.create).not.toHaveBeenCalled();
  });
});

describe("openProfilerQuestionInChat", () => {
  it("the chat waits on a question only while it ends with a live one", async () => {
    db.message.findFirst.mockResolvedValue({
      id: "q1",
      role: "assistant",
      attachment: { kind: "profiler_question", questionId: OPEN.id },
    });
    native.nativeProfilerQuestionOpen.mockResolvedValue(true);
    expect(await openProfilerQuestionInChat(USER, CHAT)).toBe(OPEN.id);

    native.nativeProfilerQuestionOpen.mockResolvedValue(false);
    expect(await openProfilerQuestionInChat(USER, CHAT)).toBeNull();
  });

  it("an ordinary last reply is no question", async () => {
    db.message.findFirst.mockResolvedValue({ id: "a1", role: "assistant", attachment: null });
    expect(await openProfilerQuestionInChat(USER, CHAT)).toBeNull();
    db.message.findFirst.mockResolvedValue({ id: "u1", role: "user", attachment: null });
    expect(await openProfilerQuestionInChat(USER, CHAT)).toBeNull();
    expect(native.nativeProfilerQuestionOpen).not.toHaveBeenCalled();
  });
});

describe("answerProfilerInChat", () => {
  it("records the words and replies with the next question", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({ question: OPEN, remaining: 2 });
    native.answerNativeProfilerQuestion.mockResolvedValue({
      ok: true,
      outcome: "next",
      question: CLOSED,
      remaining: 1,
    });
    const answered = await answerProfilerInChat({
      userId: USER,
      sessionId: CHAT,
      questionId: OPEN.id,
      text: "Rooftops",
      now: NOW,
    });
    expect(native.answerNativeProfilerQuestion).toHaveBeenCalledWith(
      USER,
      OPEN.id,
      { kind: "text", text: "Rooftops", source: "text" },
      NOW,
    );
    expect(answered?.user).toMatchObject({ role: "user", content: "Rooftops" });
    expect(answered?.reply).toMatchObject({
      role: "assistant",
      attachment: { kind: "profiler_question", questionId: CLOSED.id },
    });
  });

  it("a number answers a closed question with its option", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({ question: CLOSED, remaining: 1 });
    native.answerNativeProfilerQuestion.mockResolvedValue({ ok: true, outcome: "done" });
    const answered = await answerProfilerInChat({
      userId: USER,
      sessionId: CHAT,
      questionId: CLOSED.id,
      text: "2",
      now: NOW,
    });
    expect(native.answerNativeProfilerQuestion).toHaveBeenCalledWith(
      USER,
      CLOSED.id,
      { kind: "text", text: "", optionIds: ["meh"], source: "tap" },
      NOW,
    );
    expect(answered?.reply).toMatchObject({ role: "assistant", content: "I know you a little better now" });
  });

  it("a refused batch closes with the gentle line", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({ question: OPEN, remaining: 2 });
    native.answerNativeProfilerQuestion.mockResolvedValue({ ok: true, outcome: "paused" });
    const answered = await answerProfilerInChat({
      userId: USER,
      sessionId: CHAT,
      questionId: OPEN.id,
      text: "not now",
      now: NOW,
    });
    expect(answered?.reply.content).toContain("I won't push");
  });

  it("an answer that is not taken writes nothing — the concierge gets the turn", async () => {
    native.getNativeProfilerBatch.mockResolvedValue({});
    native.answerNativeProfilerQuestion.mockResolvedValue({ ok: false, error: "question_not_active" });
    expect(
      await answerProfilerInChat({ userId: USER, sessionId: CHAT, questionId: OPEN.id, text: "hi", now: NOW }),
    ).toBeNull();
    expect(db.message.create).not.toHaveBeenCalled();
  });
});
