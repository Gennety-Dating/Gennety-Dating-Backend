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

const sendMessage = vi.fn().mockResolvedValue({});
const setMessageReaction = vi.fn().mockResolvedValue(true);
const fakeApi = { sendMessage, setMessageReaction } as never;

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
  setMessageReaction.mockClear();
});

describe("startProfilerBatch", () => {
  it("sends the first (highest-priority) question and marks it active", async () => {
    mUserFind.mockResolvedValue(userState([]));
    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"));

    expect(res).toBe("sent");
    expect(sendMessage).toHaveBeenCalledTimes(1);
    // First female question text.
    expect(sendMessage.mock.calls[0]![1]).toMatch(/first date/i);
    // Skip button carries the question id.
    const kb = sendMessage.mock.calls[0]![2].reply_markup;
    expect(JSON.stringify(kb)).toContain("profiler:skip:f_date_spots");
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

    const res = await startProfilerBatch(fakeApi, "u1", new Date("2026-06-10T07:00:00Z"));
    expect(res).toBe("done");
    expect(sendMessage).not.toHaveBeenCalled();
    // Final update nulls the schedule.
    const last = mProfileUpdate.mock.calls.at(-1)![0].data;
    expect(last.profilerNextAt).toBeNull();
    expect(last.profilerActiveQuestionId).toBeNull();
  });
});

describe("recordProfilerAnswer", () => {
  it("upserts the answer then sends the next question (batch continues)", async () => {
    // After the upsert, loadState is re-read with remaining > 0 and the first
    // question answered → next question should be sent immediately.
    mUserFind.mockResolvedValue(
      userState(
        [{ questionId: "f_date_spots", answerText: "cafes", skipped: false, skipReturned: false, cycleId: "x" }],
        2,
      ),
    );

    const ok = await recordProfilerAnswer(fakeApi, "u1", "f_date_spots", "rooftop cafes");
    expect(ok).toBe(true);
    expect(mAnswerUpsert).toHaveBeenCalledTimes(1);
    expect(mAnswerUpsert.mock.calls[0]![0].create.answerText).toBe("rooftop cafes");
    // Next question (f_comm_style) sent.
    expect(sendMessage).toHaveBeenCalledTimes(1);
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

    const ok = await recordProfilerSkip(fakeApi, "u1", "f_date_spots");
    expect(ok).toBe(true);
    const update = mAnswerUpsert.mock.calls[0]![0].update;
    expect(update).toEqual({ skipped: true, skipReturned: false, cycleId: expect.any(String) });
  });
});
