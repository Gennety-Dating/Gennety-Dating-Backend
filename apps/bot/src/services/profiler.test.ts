import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    profile: { update: vi.fn().mockResolvedValue({}) },
    profilerAnswer: { upsert: vi.fn().mockResolvedValue({}), findUnique: vi.fn() },
  },
}));

import { prisma } from "@gennety/db";
import {
  startProfilerBatch,
  recordProfilerAnswer,
  recordProfilerSkip,
  profilerCycleId,
  shouldReactToProfilerAnswer,
} from "./profiler.js";

type MockFn = ReturnType<typeof vi.fn>;
const mUserFind = (prisma.user as unknown as { findUnique: MockFn }).findUnique;
const mProfileUpdate = (prisma.profile as unknown as { update: MockFn }).update;
const mAnswerUpsert = (prisma.profilerAnswer as unknown as { upsert: MockFn }).upsert;
const mAnswerFind = (prisma.profilerAnswer as unknown as { findUnique: MockFn }).findUnique;

const sendMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } });
const editMessageText = vi.fn().mockResolvedValue({});
const deleteMessage = vi.fn().mockResolvedValue(true);
const setMessageReaction = vi.fn().mockResolvedValue(true);
// Bot API 10.1 rich surface (api.raw.*) — the in-batch Profiler delivery uses
// the native `<tg-thinking>` shimmer + rich-draft stream (`rich: true`).
const sendRichMessageDraft = vi.fn().mockResolvedValue(true);
const sendRichMessage = vi.fn().mockResolvedValue({ message_id: 1, chat: { id: 1 } });
const fakeApi = {
  sendMessage,
  editMessageText,
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
function userState(answers: unknown[], batchRemaining = 0) {
  return {
    id: "u1",
    telegramId: 123n,
    gender: "female",
    language: "en",
    profile: { timeZone: "Europe/Kyiv", profilerBatchRemaining: batchRemaining },
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
  mAnswerUpsert.mockReset().mockResolvedValue({});
  mAnswerFind.mockReset();
  sendMessage.mockClear();
  editMessageText.mockClear();
  deleteMessage.mockClear();
  setMessageReaction.mockClear();
  sendRichMessageDraft.mockClear();
  sendRichMessage.mockClear();
});

describe("startProfilerBatch", () => {
  it("sends the first (highest-priority) question and marks it active", async () => {
    mUserFind.mockResolvedValue(userState([]));
    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);

    expect(res).toBe("sent");
    // The opener also streams (native compose) and is finalised via
    // sendRichMessage carrying the Skip keyboard.
    expect(sendRichMessage).toHaveBeenCalledTimes(1);
    const params = sendRichMessage.mock.calls[0]![0] as {
      rich_message?: { markdown?: string };
      reply_markup?: unknown;
    };
    expect(params.rich_message?.markdown).toMatch(/first date/i);
    expect(JSON.stringify(params.reply_markup)).toContain("profiler:skip:f_date_spots");
    // Opener streams via the native compose path (a `<tg-thinking>` shimmer first).
    expect(richHtmls().some((h) => /<tg-thinking>/.test(h))).toBe(true);
    expect(activeUpdate()?.profilerActiveQuestionId).toBe("f_date_spots");
  });

  it("finishes silently when nothing is pending", async () => {
    const allAnswered = [
      "f_date_spots", "f_comm_style", "f_chronotype", "f_sport_pref",
      "f_turnoffs", "f_shared_interests", "f_activity_pref", "f_media",
    ].map((questionId) => ({
      questionId, answerText: "x", skipped: false, skipReturned: false,
      cycleId: profilerCycleId(new Date("2026-06-10T07:00:00Z")),
    }));
    mUserFind.mockResolvedValue(userState(allAnswered));

    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"), noWait);
    expect(res).toBe("done");
    expect(sendMessage).not.toHaveBeenCalled();
    // Final update nulls the schedule.
    const last = mProfileUpdate.mock.calls.at(-1)![0].data;
    expect(last.profilerNextAt).toBeNull();
    expect(last.profilerActiveQuestionId).toBeNull();
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

    // The thinking status is a native `<tg-thinking>` shimmer; the ack beat
    // carries the operator-chosen custom `<tg-emoji>` glyph.
    const htmls = richHtmls();
    expect(
      htmls.some(
        (h) =>
          /<tg-thinking>/.test(h) &&
          h.includes('emoji-id="5537203062138994712"') &&
          /Got it/.test(h),
      ),
    ).toBe(true);
    // The second beat is the "Thinking…" shimmer.
    expect(htmls.some((h) => /<tg-thinking>/.test(h) && /Thinking/.test(h))).toBe(true);

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
