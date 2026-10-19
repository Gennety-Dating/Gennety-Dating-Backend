import { beforeEach, describe, expect, it, vi } from "vitest";
import { profilerQuestionById, profilerQuestionInput } from "@gennety/shared";

const mocks = vi.hoisted(() => {
  const tx = {
    profile: { findUnique: vi.fn(), updateMany: vi.fn() },
    profilerAnswer: { upsert: vi.fn(), findUnique: vi.fn() },
  };
  return { tx, transaction: vi.fn(async (run: (db: typeof tx) => Promise<unknown>) => run(tx)) };
});
vi.mock("@gennety/db", () => ({ prisma: {
  $transaction: mocks.transaction,
  user: { findUnique: vi.fn() },
  profile: { update: vi.fn(), updateMany: vi.fn() },
  profilerAnswer: { upsert: vi.fn() },
  match: { findFirst: vi.fn().mockResolvedValue(null) },
} }));
vi.mock("./profiler-card.js", () => ({ deliverProfilerCard: vi.fn().mockResolvedValue(7), closeProfilerCard: vi.fn().mockResolvedValue(undefined) }));
vi.mock("./profiler-context.js", () => ({ loadProfilerContextSignals: vi.fn(), resolveProfilerQuestionContext: vi.fn().mockResolvedValue({ kind: "none" }), profilerContextMarkdown: vi.fn() }));

import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { closeProfilerCard, deliverProfilerCard } from "./profiler-card.js";
import { recordProfilerCardAnswer, recordProfilerSkip, startProfilerBatch } from "./profiler.js";

const question = profilerQuestionById("f_chronotype")!;
const option = profilerQuestionInput(question)!.options[0]!.id;
function state(remaining = 0) {
  return { id: "u", telegramId: 123n, gender: "female", language: "en",
    profile: { timeZone: "Europe/Kyiv", profilerBatchRemaining: remaining, profilerActiveQuestionId: null, profilerQuestionMessageId: 7 },
    profilerAnswers: [{ questionId: question.id, answerText: "early", skipped: false, skipReturned: false, cycleId: "2026-W43" }],
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(env, { PROFILER_CARDS_ENABLED: true });
  mocks.tx.profile.findUnique.mockResolvedValue({ profilerQuestionMessageId: 7 });
  mocks.tx.profile.updateMany.mockResolvedValue({ count: 1 });
  mocks.tx.profilerAnswer.upsert.mockResolvedValue({});
  mocks.tx.profilerAnswer.findUnique.mockResolvedValue(null);
  vi.mocked(prisma.user.findUnique).mockResolvedValue(state() as never);
  vi.mocked(prisma.profile.update).mockResolvedValue({} as never);
  vi.mocked(prisma.profile.updateMany).mockResolvedValue({ count: 1 });
  vi.mocked(deliverProfilerCard).mockResolvedValue(7);
});

describe("Profiler card persistence and continuation", () => {
  it("validates options before claiming, then writes the same option metadata as iOS inside the transaction", async () => {
    expect(await recordProfilerCardAnswer({} as never, "u", question.id, "en", ["forged"], "", 7)).toBe(false);
    expect(mocks.transaction).not.toHaveBeenCalled();
    expect(await recordProfilerCardAnswer({} as never, "u", question.id, "en", [option], "and coffee", 7)).toBe(true);
    expect(mocks.transaction).toHaveBeenCalledTimes(1);
    expect(mocks.tx.profile.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { userId: "u", profilerActiveQuestionId: question.id, profilerQuestionMessageId: 7 },
      data: expect.objectContaining({ profilerActiveQuestionId: null, profilerNextAt: expect.any(Date) }),
    }));
    expect(mocks.tx.profilerAnswer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ optionIds: [option], answerSource: "both", answerText: expect.stringContaining("and coffee") }),
    }));
    expect(prisma.profilerAnswer.upsert).not.toHaveBeenCalled();
    expect(closeProfilerCard).toHaveBeenCalledWith(expect.anything(), 123, 7, "en");
  });

  it("a failed answer write rejects the transaction and never advances or closes the question", async () => {
    mocks.tx.profilerAnswer.upsert.mockRejectedValueOnce(new Error("write failed"));
    await expect(recordProfilerCardAnswer({} as never, "u", question.id, "en", [option], "", 7)).rejects.toThrow("write failed");
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(deliverProfilerCard).not.toHaveBeenCalled();
    expect(closeProfilerCard).not.toHaveBeenCalled();
  });

  it("a duplicate/stale claim writes nothing and advances nothing", async () => {
    mocks.tx.profile.updateMany.mockResolvedValue({ count: 0 });
    expect(await recordProfilerCardAnswer({} as never, "u", question.id, "en", [option], "", 7)).toBe(false);
    expect(mocks.tx.profilerAnswer.upsert).not.toHaveBeenCalled();
    expect(closeProfilerCard).not.toHaveBeenCalled();
  });

  it("skip claims and persists in the same transaction", async () => {
    await recordProfilerSkip({} as never, "u", question.id, { expectedMessageId: 7 });
    expect(mocks.tx.profilerAnswer.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ skipped: true, answerText: null }),
    }));
    expect(mocks.tx.profile.updateMany).toHaveBeenCalled();
  });

  it("resumes the retained card after restart without resetting the batch budget", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(state(1) as never);
    expect(await startProfilerBatch({} as never, "u")).toBe("sent");
    expect(deliverProfilerCard).toHaveBeenCalledWith(expect.anything(), 123, expect.any(Object), "en", 7, undefined, null);
    expect(prisma.profile.update).not.toHaveBeenCalled();
    expect(prisma.profile.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ profilerBatchRemaining: 0 }),
    }));
  });

  it("failed delivery restores the due continuation and its unconsumed budget", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(state(1) as never);
    vi.mocked(deliverProfilerCard).mockRejectedValueOnce(new Error("network timeout"));
    expect(await startProfilerBatch({} as never, "u")).toBe("paused");
    expect(prisma.profile.updateMany).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ profilerActiveQuestionId: null, profilerBatchRemaining: 1, profilerNextAt: expect.any(Date) }),
    }));
  });

  it("iOS resolving during delivery prevents the card being left interactive", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(state(1) as never);
    vi.mocked(prisma.profile.updateMany).mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    await startProfilerBatch({} as never, "u");
    expect(closeProfilerCard).toHaveBeenCalledWith(expect.anything(), 123, 7, "en");
  });
});
