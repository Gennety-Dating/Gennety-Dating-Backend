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

const pendingFeedbackFor = vi.fn(async (_id: string): Promise<unknown> => ({
  matchId: "m-7",
  submitted: false,
  answered: false,
}));
vi.mock("./post-date-feedback.js", () => ({
  pendingFeedbackFor: (id: string) => pendingFeedbackFor(id),
}));

const recordPostDateFeedback = vi.fn(
  async (_i: unknown): Promise<{ ok: true } | { ok: false; reason: string }> => ({ ok: true }),
);
vi.mock("../handlers/date/feedback.js", () => ({
  recordPostDateFeedback: (i: unknown) => recordPostDateFeedback(i),
}));

vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: false }) }));
vi.mock("../handlers/menu/city-switch.js", () => ({ isMarketPending: () => false }));

const { AGENT_TOOLS, executeAgentTool, TOOL_KINDS } = await import("./menu-agent.js");

const STORY = "Было легко, проговорили три часа и не заметили, я бы увиделся ещё";

beforeEach(() => {
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", language: "ru" });
  pendingFeedbackFor.mockReset();
  pendingFeedbackFor.mockResolvedValue({ matchId: "m-7", submitted: false, answered: false });
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

  /**
   * A13-M27. Каждый повтор раньше перезаписывал рассказ и заново гонял анализ,
   * который ДОПИСЫВАЕТ ограничения, — одна и та же жалоба ложилась в профиль
   * столько раз, сколько модель её «записала».
   */
  it("второй рассказ не записывается, а форма остаётся открытой", async () => {
    pendingFeedbackFor.mockResolvedValue({ matchId: "m-7", submitted: false, answered: true });

    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    expect(recordPostDateFeedback).not.toHaveBeenCalled();
    const parsed = JSON.parse(out.result);
    expect(parsed.success).toBe(false);
    expect(parsed.instruction).toMatch(/NOT recorded/);
    // Решение 2026-09-08: рассказ форму не отменяет — модель вправе это сказать.
    expect(parsed.instruction).toMatch(/still open/);
  });

  it("рассказ после формы ничего не добавляет и не записывается", async () => {
    pendingFeedbackFor.mockResolvedValue({ matchId: "m-7", submitted: true, answered: true });

    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    expect(recordPostDateFeedback).not.toHaveBeenCalled();
    const parsed = JSON.parse(out.result);
    expect(parsed.instruction).toMatch(/NOT recorded/);
    expect(parsed.instruction).toMatch(/already answered the feedback form/);
    expect(parsed.instruction).not.toMatch(/still open/);
  });

  it("описание инструмента обещает, что форма остаётся доступной", () => {
    const tool = AGENT_TOOLS.find((t) => t.function.name === "record_date_feedback");
    expect(tool?.function.description).toContain("the form stays available either way");
  });

  it("гонка с формой кончается тем же отказом, а не кодом причины", async () => {
    recordPostDateFeedback.mockResolvedValue({ ok: false, reason: "already-submitted" });

    const out = await executeAgentTool(1n, "record_date_feedback", { feedback: STORY });

    const parsed = JSON.parse(out.result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toBe("already_submitted");
    expect(parsed.instruction).toMatch(/NOT recorded/);
    // Который источник выиграл гонку, неизвестно — не обещаем ни того, ни другого.
    expect(parsed.instruction).not.toMatch(/still open|already answered/);
  });
});
