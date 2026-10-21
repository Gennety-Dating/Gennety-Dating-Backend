import { beforeEach, describe, expect, it, vi } from "vitest";
import { contextualProfilerQuestion, profilerQuestionBank, profilerQuestionById, profilerQuestionInput } from "@gennety/shared";
import type { BotContext } from "../../session.js";

vi.mock("@gennety/db", () => ({ prisma: { user: { findUnique: vi.fn() }, profile: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } } }));
vi.mock("../../services/profiler.js", () => ({ recordProfilerCardAnswer: vi.fn().mockResolvedValue(true), recordProfilerSkip: vi.fn().mockResolvedValue(true) }));
vi.mock("../../services/profiler-card.js", async (original) => ({
  ...await original<typeof import("../../services/profiler-card.js")>(),
  deliverProfilerCard: vi.fn().mockResolvedValue(7), closeProfilerCard: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../services/profiler-context.js", () => ({ resolveProfilerQuestionContext: vi.fn().mockResolvedValue({ kind: "none" }), profilerContextMarkdown: vi.fn() }));

import { prisma } from "@gennety/db";
import { env } from "../../config.js";
import { closeProfilerCard, deliverProfilerCard, profilerCardToken } from "../../services/profiler-card.js";
import { recordProfilerCardAnswer, recordProfilerSkip } from "../../services/profiler.js";
import { handleProfilerCard } from "./card.js";

const q = profilerQuestionById("f_chronotype")!;
function user(questionId = q.id, messageId = 7) {
  return { id: "u", language: "en", status: "active", profile: { profilerActiveQuestionId: questionId, profilerQuestionMessageId: messageId, timeZone: "Europe/Kyiv" } };
}
function ctx(questionId = q.id, action = "0", revision = 0): BotContext {
  return { from: { id: 123 }, chat: { id: 123 }, api: {},
    callbackQuery: { data: `pc:${profilerCardToken(questionId)}:${revision}:${action}`, message: { message_id: 7 } },
    session: { language: "en", matchFlow: "idle", menuState: "idle", expectingPhoto: false },
    answerCallbackQuery: vi.fn().mockResolvedValue(true), reply: vi.fn().mockResolvedValue({}),
  } as unknown as BotContext;
}
beforeEach(() => {
  Object.assign(env, { PROFILER_CARDS_ENABLED: true });
  vi.clearAllMocks();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user() as never);
  vi.mocked(recordProfilerCardAnswer).mockResolvedValue(true);
});

describe("Profiler card interactions", () => {
  it("open answer selection is a persisted draft, not an answer", async () => {
    const context = ctx();
    await handleProfilerCard(context);
    expect(context.session.profilerCardDraft).toMatchObject({ questionId: q.id, messageId: 7, revision: 1, optionIds: [profilerQuestionInput(q)!.options[0]!.id] });
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
    expect(deliverProfilerCard).toHaveBeenCalled();
  });
  it("a restored session submits the selected ids and clears the draft", async () => {
    const context = ctx(q.id, "send", 3);
    context.session.profilerCardDraft = { questionId: q.id, messageId: 7, revision: 3, optionIds: ["middle"] };
    await handleProfilerCard(context);
    expect(recordProfilerCardAnswer).toHaveBeenCalledWith(context.api, "u", q.id, "en", ["middle"], "", 7);
    expect(context.session.profilerCardDraft).toBeUndefined();
  });
  it("a closed contextual question saves on one tap", async () => {
    const closed = contextualProfilerQuestion("female", "format", "3f2b8c4e-9a1d-4e5f-8b7c-6d5e4f3a2b1c")!;
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user(closed.id) as never);
    const context = ctx(closed.id);
    await handleProfilerCard(context);
    expect(recordProfilerCardAnswer).toHaveBeenCalledWith(context.api, "u", closed.id, "en", [profilerQuestionInput(closed)!.options[0]!.id], "", 7);
  });
  it("stale revisions refresh the current draft without submitting", async () => {
    const context = ctx(q.id, "send", 0);
    context.session.profilerCardDraft = { questionId: q.id, messageId: 7, revision: 1, optionIds: ["middle"] };
    await handleProfilerCard(context);
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
    expect(deliverProfilerCard).toHaveBeenCalled();
  });
  it("old-message buttons and other users cannot answer the active question", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(user(q.id, 99) as never);
    await handleProfilerCard(ctx());
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
    expect(closeProfilerCard).toHaveBeenCalled();
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    await handleProfilerCard(ctx());
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
  });
  it("another flow keeps ownership of the chat", async () => {
    const context = ctx();
    context.session.expectingPhoto = true;
    await handleProfilerCard(context);
    expect(deliverProfilerCard).not.toHaveBeenCalled();
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
  });
  it("own words retains selections and skip passes the message ownership guard", async () => {
    const context = ctx(q.id, "own");
    await handleProfilerCard(context);
    expect(context.session.profilerCardDraft?.writing).toBe(true);
    context.callbackQuery!.data = `pc:${profilerCardToken(q.id)}:1:skip`;
    await handleProfilerCard(context);
    expect(recordProfilerSkip).toHaveBeenCalledWith(context.api, "u", q.id, { expectedMessageId: 7 });
  });
  it("a failed save preserves the draft and offers retry", async () => {
    const context = ctx(q.id, "send", 1);
    context.session.profilerCardDraft = { questionId: q.id, messageId: 7, revision: 1, optionIds: ["middle"] };
    vi.mocked(recordProfilerCardAnswer).mockRejectedValueOnce(new Error("db down"));
    await handleProfilerCard(context);
    expect(context.session.profilerCardDraft?.optionIds).toEqual(["middle"]);
    expect(context.reply).toHaveBeenCalled();
  });
  it("flag rollback retires old interactive cards without accepting answers", async () => {
    Object.assign(env, { PROFILER_CARDS_ENABLED: false });
    await handleProfilerCard(ctx());
    expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
    expect(closeProfilerCard).toHaveBeenCalled();
  });
});


it("multiple choices remain selectable until explicit confirmation", async () => {
  const question = profilerQuestionBank("female").find((item) => profilerQuestionInput(item)?.multiple)!;
  expect(question).toBeDefined();
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user(question.id) as never);
  const context = ctx(question.id);
  await handleProfilerCard(context);
  context.callbackQuery!.data = `pc:${profilerCardToken(question.id)}:1:1`;
  await handleProfilerCard(context);
  expect(context.session.profilerCardDraft?.optionIds).toHaveLength(2);
  expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
  context.callbackQuery!.data = `pc:${profilerCardToken(question.id)}:2:0`;
  await handleProfilerCard(context);
  expect(context.session.profilerCardDraft?.optionIds).toEqual([profilerQuestionInput(question)!.options[1]!.id]);
});

it("iOS winning during a draft edit retires the controls instead of reviving them", async () => {
  vi.mocked(prisma.profile.updateMany).mockResolvedValueOnce({ count: 0 });
  const context = ctx();
  await handleProfilerCard(context);
  expect(deliverProfilerCard).not.toHaveBeenCalled();
  expect(closeProfilerCard).toHaveBeenCalled();
  expect(context.session.profilerCardDraft).toBeUndefined();
});

it("retires a travel card from the previous release without submitting its old choices", async () => {
  vi.mocked(prisma.user.findUnique).mockResolvedValue(user("f_travel") as never);
  const context = ctx("f_travel");
  context.session.profilerCardDraft = { questionId: "f_travel", messageId: 7, revision: 0, optionIds: ["sea"] };
  await handleProfilerCard(context);
  expect(recordProfilerCardAnswer).not.toHaveBeenCalled();
  expect(closeProfilerCard).toHaveBeenCalledWith(context.api, 123, 7, "en", profilerQuestionById("f_travel")!.text.en);
  expect(context.session.profilerCardDraft).toBeUndefined();
});
