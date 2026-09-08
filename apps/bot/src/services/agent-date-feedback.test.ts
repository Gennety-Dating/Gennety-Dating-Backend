import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `record_date_feedback` — рассказ о свидании, записанный из разговора.
 *
 * Проверяется не запись как таковая, а границы, которые делают её честной:
 * тот же конвейер, что у голосовой заметки (второго хранилища не заводим),
 * матч — только тот, о котором продукт уже спросил, и ни одной величины из
 * формы модель не выдумывает.
 */

const env = { OPENAI_API_KEY: "k" };
vi.mock("../config.js", () => ({ env }));

const userFindUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  id: "u1",
  language: "ru",
}));
vi.mock("@gennety/db", () => ({
  prisma: { user: { findUnique: (a: unknown) => userFindUnique(a) }, match: {} },
  Prisma: {},
}));

const pendingFeedbackFor = vi.fn(async (_id: string): Promise<unknown> => ({ matchId: "m-7" }));
vi.mock("./post-date-feedback.js", () => ({
  pendingFeedbackFor: (id: string) => pendingFeedbackFor(id),
}));

const recordPostDateFeedback = vi.fn(async (_i: unknown) => ({ ok: true }));
vi.mock("../handlers/date/feedback.js", () => ({
  recordPostDateFeedback: (i: unknown) => recordPostDateFeedback(i),
}));

vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: false }) }));
vi.mock("../handlers/menu/city-switch.js", () => ({ isMarketPending: () => false }));

const { executeAgentTool, TOOL_KINDS } = await import("./menu-agent.js");

const STORY = "Было легко, проговорили три часа и не заметили, я бы увиделся ещё";

beforeEach(() => {
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", language: "ru" });
  pendingFeedbackFor.mockReset();
  pendingFeedbackFor.mockResolvedValue({ matchId: "m-7" });
  recordPostDateFeedback.mockReset();
  recordPostDateFeedback.mockResolvedValue({ ok: true });
});

describe("record_date_feedback", () => {
  it("объявлен как write — попадает под бюджет хода", () => {
    expect(TOOL_KINDS.record_date_feedback).toBe("write");
  });

  it("идёт тем же конвейером, что голосовая заметка", async () => {
    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    expect(recordPostDateFeedback).toHaveBeenCalledWith({
      userId: "u1",
      matchId: "m-7",
      text: STORY,
      language: "ru",
    });
    expect(JSON.parse(out.result).success).toBe(true);
    expect(out.receiptKey).toBe("feedbackThanks");
  });

  it("свидание, о котором продукт ещё не спросил, не записывается", async () => {
    pendingFeedbackFor.mockResolvedValue(null);

    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    expect(recordPostDateFeedback).not.toHaveBeenCalled();
    expect(JSON.parse(out.result).success).toBe(false);
  });

  it("огрызок не записывается, а превращается в вопрос", async () => {
    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: "норм" });

    expect(recordPostDateFeedback).not.toHaveBeenCalled();
    expect(JSON.parse(out.result).error).toMatch(/one open question/i);
  });

  it("инструкция запрещает выпрашивать оценку", async () => {
    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    // Химия и «вторая встреча» — величины, которые человек выбирает сам в форме.
    expect(JSON.parse(out.result).instruction).toMatch(/do not ask for a rating/i);
  });
});
