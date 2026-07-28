import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findUnique: vi.fn(),
    },
    profilerAnswer: { upsert: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
    match: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));

import { prisma } from "@gennety/db";
import { PROFILER_ANSWER_WINDOW_MS, profilerQuestionBank } from "@gennety/shared";
import {
  startProfilerBatch,
  recordProfilerAnswer,
  recordProfilerSkip,
  expireStalledProfilerQuestion,
  profilerCycleId,
  shouldReactToProfilerAnswer,
} from "./profiler.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mProfileUpdate = (prisma.profile as unknown as { update: MockFn }).update;
const mProfileUpdateMany = (prisma.profile as unknown as { updateMany: MockFn }).updateMany;
const mProfileFind = (prisma.profile as unknown as { findUnique: MockFn }).findUnique;
const mAnswerUpsert = (prisma.profilerAnswer as unknown as { upsert: MockFn }).upsert;
const mAnswerFind = (prisma.profilerAnswer as unknown as { findUnique: MockFn }).findUnique;
const mMatchFind = (prisma.match as unknown as { findFirst: MockFn }).findFirst;

const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } });
const editMessageText = vi.fn().mockResolvedValue({});
const editMessageReplyMarkup = vi.fn().mockResolvedValue({});
const deleteMessage = vi.fn().mockResolvedValue(true);
const setMessageReaction = vi.fn().mockResolvedValue(true);
// Bot API 10.1 rich surface (api.raw.*) — the in-batch Profiler delivery uses
// the native `<tg-thinking>` shimmer + rich-draft stream (`rich: true`).
const sendRichMessageDraft = vi.fn().mockResolvedValue(true);
const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } });
const fakeApi = {
  sendMessage,
  editMessageText,
  editMessageReplyMarkup,
  deleteMessage,
  setMessageReaction,
  raw: { sendRichMessageDraft, sendRichMessage },
} as never;

/** No-op delay so the status holds + reveal steps don't run real timers. */
const noWait = (_ms: number) => Promise.resolve();

/** Every rich-draft HTML the bot streamed (status shimmer + question drafts). */
function richHtmls(): string[] {
  return sendRichMessageDraft.mock.calls.map(
    (c) => ((c[0] as { rich_message?: { html?: string } })?.rich_message?.html ?? "") as string,
  );
}

/** loadState shape: female user with the given answer rows. */
function userState(answers: unknown[], batchRemaining = 0, activeQuestionId: string | null = null) {
  return {
    id: "u1",
    telegramId: 123n,
    gender: "female",
    language: "en",
    profile: {
      timeZone: "Europe/Kyiv",
      profilerBatchRemaining: batchRemaining,
      profilerActiveQuestionId: activeQuestionId,
    },
    profilerAnswers: answers,
  };
}

function activeUpdate(): Record<string, unknown> | undefined {
  // The update that sets the active question after a send.
  return mProfileUpdate.mock.calls
    .map((c) => c[0].data as Record<string, unknown>)
    .find((d) => typeof d.profilerActiveQuestionId === "string");
}

beforeEach(() => {
  mUserFind.mockReset();
  mProfileUpdate.mockReset().mockResolvedValue({});
  mProfileUpdateMany.mockReset().mockResolvedValue({ count: 1 });
  mProfileFind.mockReset().mockResolvedValue(null);
  mAnswerUpsert.mockReset().mockResolvedValue({});
  mAnswerFind.mockReset();
  mMatchFind.mockReset().mockResolvedValue(null);
  sendMessage.mockClear();
  editMessageText.mockClear();
  editMessageReplyMarkup.mockClear();
  deleteMessage.mockReset().mockResolvedValue(true);
  setMessageReaction.mockClear();
  sendRichMessageDraft.mockClear();
  sendRichMessage.mockClear();
});

describe("startProfilerBatch", () => {
  it("sends the first (highest-priority) question and marks it active", async () => {
    mUserFind.mockResolvedValue(userState([]));
    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);

    expect(res).toBe("sent");
    // The opener plays its shimmer and is finalised via sendRichMessage
    // carrying the Skip keyboard.
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    const params = sendRichMessage.mock.calls[0]![0] as {
      rich_message?: { markdown?: string };
      reply_markup?: unknown;
    };
    expect(params.rich_message?.markdown).toMatch(/first date/i);
    expect(JSON.stringify(params.reply_markup)).toContain("profiler:skip:f_date_spots");
    // One bare `<tg-thinking>` shimmer beat, then the question whole — the
    // opener never types itself out.
    const htmls = richHtmls();
    expect(htmls).toHaveLength(1);
    expect(htmls[0]).toMatch(/<tg-thinking>/);
    expect(htmls[0]).not.toContain("<tg-emoji");

    const active = activeUpdate()!;
    expect(active.profilerActiveQuestionId).toBe("f_date_spots");
    // The question owns free text only for a bounded window, and its message id
    // is anchored so a later explicit reply is still recognised as an answer.
    expect(active.profilerQuestionMessageId).toBe(1);
    expect((active.profilerAnswerWindowUntil as Date).getTime()).toBe(
      new Date("2026-06-10T07:00:00Z").getTime() + PROFILER_ANSWER_WINDOW_MS,
    );
  });

  it("clears the capture window when delivery fails", async () => {
    mUserFind.mockResolvedValue(userState([]));
    // Rich unsupported AND the classic fallback blocked → nothing was delivered.
    sendRichMessageDraft.mockRejectedValueOnce(new Error("rich unsupported"));
    sendMessage.mockRejectedValue(new Error("blocked"));
    try {
      const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);

      expect(res).toBe("paused");
      const last = mProfileUpdate.mock.calls.at(-1)![0].data;
      expect(last.profilerActiveQuestionId).toBeNull();
      expect(last.profilerAnswerWindowUntil).toBeNull();
      expect(last.profilerQuestionMessageId).toBeNull();
    } finally {
      sendMessage.mockResolvedValue({ message_id: 1, chat: { id: 1 } });
    }
  });

  it("silently defers to the next window when only THIS cycle is exhausted (refreshables pending next cycle)", async () => {
    // Derived from the bank (not hardcoded) so adding a question can't quietly
    // turn this into "all but the new ones". Everything answered in the CURRENT
    // cycle, so nothing is due for a refresh *yet* — but the female bank always
    // carries refreshable questions, so this must NOT be treated as final: a
    // null `profilerNextAt` would stop the dispatch sweep from ever checking
    // this user again, and next week's refresh would silently never fire.
    const allAnswered = profilerQuestionBank("female").map((q) => ({
      questionId: q.id, answerText: "x", skipped: false, skipReturned: false,
      cycleId: profilerCycleId(new Date("2026-06-10T07:00:00Z")),
    }));
    mUserFind.mockResolvedValue(userState(allAnswered));

    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);
    expect(res).toBe("done");
    expect(sendMessage).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    // Rescheduled to the next window, NOT nulled — the silent heartbeat that
    // lets the schedule revive once the cycle actually rolls over.
    const last = mProfileUpdate.mock.calls.at(-1)![0].data;
    expect(last.profilerNextAt).toBeInstanceOf(Date);
    expect(last.profilerActiveQuestionId).toBeNull();
  });

  it("truly finishes (nulls the schedule) only when the bank has no refreshable question at all", async () => {
    // A null gender resolves to an empty bank (no refreshable questions ever),
    // which is the one case where going fully silent is actually correct.
    mUserFind.mockResolvedValue({
      id: "u1",
      telegramId: 123n,
      gender: null,
      language: "en",
      profile: { timeZone: "Europe/Kyiv", profilerBatchRemaining: 0, profilerActiveQuestionId: null },
      profilerAnswers: [],
    });

    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);
    expect(res).toBe("done");
    const last = mProfileUpdate.mock.calls.at(-1)![0].data;
    expect(last.profilerNextAt).toBeNull();
  });
});

describe("recordProfilerAnswer", () => {
  it("upserts the answer then streams the next question (batch continues)", async () => {
    // After the upsert, loadState is re-read with remaining > 0 and the first
    // question answered → next question is delivered via the thinking status +
    // streamed reveal (the in-batch "advance" path).
    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "f_date_spots", answerText: "cafes", skipped: false, skipReturned: false, cycleId: "x" }],
        2,
      ),
    );

    const ok = await recordProfilerAnswer(fakeApi, "u1", "f_date_spots", "rooftop cafes", {
      wait: noWait,
    });
    expect(ok).toBe(true);
    expect(mAnswerUpsert).toHaveBeenCalledTimes(1);
    expect(mAnswerUpsert.mock.calls[0]![0].create.answerText).toBe("rooftop cafes");

    // The thinking status is a native `<tg-thinking>` shimmer, and it is BARE:
    // no `<tg-emoji>` glyph on either beat.
    const htmls = richHtmls();
    expect(htmls.some((h) => /<tg-thinking>/.test(h) && /Got it/.test(h))).toBe(true);
    expect(htmls.some((h) => /<tg-thinking>/.test(h) && /Thinking/.test(h))).toBe(true);
    expect(htmls.some((h) => h.includes("<tg-emoji"))).toBe(false);

    // The question itself is NOT typed out: the only drafts are the two status
    // beats, then the whole question lands in one message.
    expect(htmls).toHaveLength(2);

    // The next question (f_comm_style) is finalised via sendRichMessage (so the
    // streaming draft resolves in place — no orphaned reserved space) carrying
    // its Skip keyboard.
    const finalSend = sendRichMessage.mock.calls.find((c) =>
      JSON.stringify(c[0] ?? {}).includes("profiler:skip:f_comm_style"),
    );
    expect(finalSend).toBeDefined();
    expect(
      (finalSend![0] as { rich_message?: { markdown?: string } }).rich_message?.markdown,
    ).toMatch(/chatting about everything/i);

    expect(activeUpdate()?.profilerActiveQuestionId).toBe("f_comm_style");
  });

  it("rejects an unknown question id", async () => {
    const ok = await recordProfilerAnswer(fakeApi, "u1", "not_a_question", "hi");
    expect(ok).toBe(false);
    expect(mAnswerUpsert).not.toHaveBeenCalled();
  });

  it("saves the answer but does not send the next question while a date is being negotiated", async () => {
    // A match entered an in-progress negotiation (proposed/negotiating/
    // negotiating_venue) while this batch was mid-flight — the answer persists,
    // but the rest of the batch must NOT fire into the planning flow.
    mMatchFind.mockResolvedValue({ id: "m1" });
    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "f_date_spots", answerText: "cafes", skipped: false, skipReturned: false, cycleId: "x" }],
        2,
      ),
    );

    const ok = await recordProfilerAnswer(fakeApi, "u1", "f_date_spots", "rooftop cafes", {
      wait: noWait,
    });

    expect(ok).toBe(true);
    // The given answer is still recorded.
    expect(mAnswerUpsert).toHaveBeenCalledTimes(1);
    // No next question is streamed/finalised.
    expect(sendRichMessage).not.toHaveBeenCalled();
    // The batch is paused: active question cleared, remaining zeroed, rescheduled.
    const pause = mProfileUpdate.mock.calls.map((c) => c[0].data as Record<string, unknown>).at(-1)!;
    expect(pause.profilerActiveQuestionId).toBeNull();
    expect(pause.profilerBatchRemaining).toBe(0);
    expect(pause.profilerNextAt).toBeInstanceOf(Date);
  });

  it("likes only the selected later-batch Profiler answers", async () => {
    expect(shouldReactToProfilerAnswer("f_date_spots")).toBe(false);
    expect(shouldReactToProfilerAnswer("f_turnoffs")).toBe(true);
    expect(shouldReactToProfilerAnswer("m_planner")).toBe(true);

    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "m_planner", answerText: "planner", skipped: false, skipReturned: false, cycleId: "x" }],
        0,
      ),
    );

    const ok = await recordProfilerAnswer(fakeApi, "u1", "m_planner", "I plan ahead", {
      reactionTarget: { chatId: 123, messageId: 456 },
      wait: noWait,
    });

    expect(ok).toBe(true);
    expect(setMessageReaction).toHaveBeenCalledWith(
      123,
      456,
      [{ type: "emoji", emoji: "👍" }],
      { is_big: false },
    );
  });
});

describe("recordProfilerSkip", () => {
  it("marks the question skipped (first skip → not yet returned)", async () => {
    mAnswerFind.mockResolvedValue(null);
    mUserFind.mockResolvedValue(userState([], 0));

    const ok = await recordProfilerSkip(fakeApi, "u1", "f_date_spots", { wait: noWait });
    expect(ok).toBe(true);
    const update = mAnswerUpsert.mock.calls[0]![0].update;
    expect(update).toEqual({ skipped: true, skipReturned: false, cycleId: expect.any(String) });
  });

  it("streams the next question when the batch continues after a skip", async () => {
    mAnswerFind.mockResolvedValue(null);
    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "f_date_spots", answerText: null, skipped: true, skipReturned: false, cycleId: "x" }],
        2,
      ),
    );

    const ok = await recordProfilerSkip(fakeApi, "u1", "f_date_spots", { wait: noWait });
    expect(ok).toBe(true);
    // Native shimmer status, then the next question finalised via sendRichMessage.
    expect(richHtmls().some((h) => /<tg-thinking>/.test(h))).toBe(true);
    const finalSend = sendRichMessage.mock.calls.find((c) =>
      JSON.stringify(c[0] ?? {}).includes("profiler:skip:f_comm_style"),
    );
    expect(finalSend).toBeDefined();
    expect(activeUpdate()?.profilerActiveQuestionId).toBe("f_comm_style");
  });
});

describe("active-question claim (stale/duplicate taps)", () => {
  // The Skip keyboard is never stripped from older question messages, so any of
  // them can be tapped at any time — including a second tap on the one just
  // used. Before the atomic claim, each such tap re-ran record → advance and
  // pushed out another question; because a merely *sent* question has no
  // ProfilerAnswer row, the advance could even re-select the question still
  // sitting unanswered on screen and send it twice.
  it("ignores a skip for a question that is no longer active", async () => {
    mProfileUpdateMany.mockResolvedValue({ count: 0 }); // claim lost
    mAnswerFind.mockResolvedValue(null);
    mUserFind.mockResolvedValue(userState([], 2));

    const ok = await recordProfilerSkip(fakeApi, "u1", "f_date_spots", { wait: noWait });

    expect(ok).toBe(false);
    expect(mAnswerUpsert).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mProfileUpdate).not.toHaveBeenCalled();
  });

  it("ignores an answer for a question that is no longer active", async () => {
    mProfileUpdateMany.mockResolvedValue({ count: 0 });
    mUserFind.mockResolvedValue(userState([], 2));

    const ok = await recordProfilerAnswer(fakeApi, "u1", "f_date_spots", "cafes", {
      wait: noWait,
    });

    expect(ok).toBe(false);
    expect(mAnswerUpsert).not.toHaveBeenCalled();
    expect(sendRichMessage).not.toHaveBeenCalled();
  });

  it("claims exactly the question being answered", async () => {
    mUserFind.mockResolvedValue(userState([], 2));
    await recordProfilerAnswer(fakeApi, "u1", "f_date_spots", "cafes", { wait: noWait });

    // The claim also closes the capture window and drops the message anchor:
    // the resolved question must stop owning the user's free text.
    expect(mProfileUpdateMany).toHaveBeenCalledWith({
      where: { userId: "u1", profilerActiveQuestionId: "f_date_spots" },
      data: {
        profilerActiveQuestionId: null,
        profilerAnswerWindowUntil: null,
        profilerQuestionMessageId: null,
      },
    });
  });

  it("a double tap on the same Skip button only advances once", async () => {
    mAnswerFind.mockResolvedValue(null);
    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "f_date_spots", answerText: null, skipped: true, skipReturned: false, cycleId: "x" }],
        2,
      ),
    );
    // First tap wins the claim, the replay finds the column already cleared.
    mProfileUpdateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValue({ count: 0 });

    const first = await recordProfilerSkip(fakeApi, "u1", "f_date_spots", { wait: noWait });
    const second = await recordProfilerSkip(fakeApi, "u1", "f_date_spots", { wait: noWait });

    expect(first).toBe(true);
    expect(second).toBe(false);
    // Exactly one skip recorded (a second would flip skipReturned and drop the
    // question for the rest of the cycle) and exactly one question sent.
    expect(mAnswerUpsert).toHaveBeenCalledTimes(1);
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
  });
});

describe("expireStalledProfilerQuestion", () => {
  it("records the silence as an implicit skip and re-arms the schedule", async () => {
    mProfileFind.mockResolvedValue({
      profilerActiveQuestionId: "f_date_spots",
      timeZone: "Europe/Kyiv",
    });
    mAnswerFind.mockResolvedValue(null);

    const ok = await expireStalledProfilerQuestion("u1", new Date("2026-06-10T07:00:00Z"));

    expect(ok).toBe(true);
    // Implicit skip → returns once, exactly like an explicit Skip.
    expect(mAnswerUpsert.mock.calls[0]![0].create).toMatchObject({
      questionId: "f_date_spots",
      answerText: null,
      skipped: true,
      skipReturned: false,
    });
    // Schedule re-opened at the next local window, active cleared. Without this
    // the user's Profiler stayed silent forever.
    const last = mProfileUpdate.mock.calls.at(-1)![0].data;
    expect(last.profilerActiveQuestionId).toBeNull();
    expect(last.profilerBatchRemaining).toBe(0);
    expect(last.profilerNextAt).toBeInstanceOf(Date);
    // Nothing is sent — reclaiming is not a nag.
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("deletes the dead question message so it can't be answered into the void", async () => {
    mProfileFind.mockResolvedValueOnce({
      profilerActiveQuestionId: "f_date_spots",
      timeZone: "Europe/Kyiv",
      user: { telegramId: 123n },
    });
    // claimActiveQuestion re-reads the profile for the message id before nulling it.
    mProfileFind.mockResolvedValueOnce({ profilerQuestionMessageId: 77 });
    mAnswerFind.mockResolvedValue(null);

    await expireStalledProfilerQuestion("u1", new Date("2026-06-10T07:00:00Z"), fakeApi);

    expect(deleteMessage).toHaveBeenCalledWith(123, 77);
    // Deleted outright, not merely de-buttoned: a question with no button still
    // reads as open, and a reply to it reaches the menu agent with no context.
    expect(editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  it("falls back to stripping the keyboard when the message is too old to delete", async () => {
    mProfileFind.mockResolvedValueOnce({
      profilerActiveQuestionId: "f_date_spots",
      timeZone: "Europe/Kyiv",
      user: { telegramId: 123n },
    });
    mProfileFind.mockResolvedValueOnce({ profilerQuestionMessageId: 77 });
    mAnswerFind.mockResolvedValue(null);
    deleteMessage.mockRejectedValueOnce(new Error("message can't be deleted"));

    await expireStalledProfilerQuestion("u1", new Date("2026-06-10T07:00:00Z"), fakeApi);

    expect(editMessageReplyMarkup).toHaveBeenCalledWith(123, 77);
  });

  it("never overwrites an answer that landed in the same instant", async () => {
    mProfileFind.mockResolvedValue({
      profilerActiveQuestionId: "f_date_spots",
      timeZone: "Europe/Kyiv",
    });
    mAnswerFind.mockResolvedValue({
      questionId: "f_date_spots",
      answerText: "rooftop cafes",
      skipped: false,
      skipReturned: false,
      cycleId: "x",
    });

    await expireStalledProfilerQuestion("u1", new Date("2026-06-10T07:00:00Z"));

    expect(mAnswerUpsert).not.toHaveBeenCalled();
  });

  it("is a no-op when no question is active", async () => {
    mProfileFind.mockResolvedValue({ profilerActiveQuestionId: null, timeZone: "Europe/Kyiv" });

    expect(await expireStalledProfilerQuestion("u1")).toBe(false);
    expect(mProfileUpdate).not.toHaveBeenCalled();
  });
});
