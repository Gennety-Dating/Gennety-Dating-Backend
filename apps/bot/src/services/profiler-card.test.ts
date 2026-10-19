import { describe, expect, it, vi } from "vitest";
import { contextualProfilerQuestion, profilerQuestionBank, profilerQuestionById, profilerQuestionInput } from "@gennety/shared";
import { closeProfilerCard, deliverProfilerCard, parseProfilerCardCallback, profilerCardContent } from "./profiler-card.js";

const badRequest = { error_code: 400 };
function apiFixture() {
  return {
    raw: { sendRichMessage: vi.fn().mockResolvedValue({ message_id: 8 }), editMessageText: vi.fn().mockResolvedValue({}) },
    sendMessage: vi.fn().mockResolvedValue({ message_id: 9 }),
    editMessageText: vi.fn().mockResolvedValue({}),
  };
}

describe("Telegram Profiler card", () => {
  it("every bank/context button fits callback limits and uses Bot API callback_data markup", () => {
    const questions = [...profilerQuestionBank("female"), ...profilerQuestionBank("male"),
      contextualProfilerQuestion("female", "format", "3f2b8c4e-9a1d-4e5f-8b7c-6d5e4f3a2b1c")!];
    for (const question of questions) {
      for (const language of ["en", "ru", "uk", "de", "pl"] as const) {
        const card = profilerCardContent(question, language);
        expect(card.html).toContain('type="callback_data"');
        for (const button of card.keyboard.inline_keyboard.flat()) {
          if (!("callback_data" in button)) continue;
          expect(Buffer.byteLength(button.callback_data)).toBeLessThanOrEqual(64);
          expect(parseProfilerCardCallback(button.callback_data)).not.toBeNull();
        }
      }
    }
  });

  it("open options show a selection and explicit send; free-text questions stay free", () => {
    const question = profilerQuestionBank("female").find((q) => profilerQuestionInput(q))!;
    const option = profilerQuestionInput(question)!.options[0]!;
    const card = profilerCardContent(question, "en", { revision: 2, optionIds: [option.id] });
    expect(card.keyboard.inline_keyboard[0]![0]!.text).toMatch(/^✓ /);
    expect(card.html).toContain(":2:send");
    expect(profilerCardContent(profilerQuestionById("f_humor")!, "en").keyboard.inline_keyboard).toHaveLength(1);
  });

  it("escapes context and never interpolates it into callback attributes", () => {
    const card = profilerCardContent(profilerQuestionById("f_humor")!, "en", undefined, '<script a="x">&');
    expect(card.html).toContain("&lt;script");
    expect(card.html).not.toContain("<script");
  });

  it("rejects malformed and unbounded callback revisions", () => {
    expect(parseProfilerCardCallback("pc:bad:0:send")).toBeNull();
    expect(parseProfilerCardCallback("pc:abcdefabcdef:999999999999999999999:skip")).toBeNull();
  });

  it("advances the existing rich message without sending another", async () => {
    const api = apiFixture();
    expect(await deliverProfilerCard(api as never, 123, profilerQuestionById("f_humor")!, "en", 7)).toBe(7);
    expect(api.raw.editMessageText).toHaveBeenCalledWith(expect.objectContaining({ message_id: 7, rich_message: expect.any(Object) }));
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
  });

  it("falls back to inline buttons when rich formatting is rejected", async () => {
    const api = apiFixture();
    api.raw.sendRichMessage.mockRejectedValue(badRequest);
    expect(await deliverProfilerCard(api as never, 123, profilerQuestionById("f_humor")!, "en")).toBe(9);
    expect(api.sendMessage).toHaveBeenCalledWith(123, expect.any(String), expect.objectContaining({ reply_markup: expect.any(Object) }));
  });

  it("replaces a deleted message, but never sends a duplicate after a timeout", async () => {
    const api = apiFixture();
    api.raw.editMessageText.mockRejectedValue(badRequest);
    api.editMessageText.mockRejectedValue(badRequest);
    expect(await deliverProfilerCard(api as never, 123, profilerQuestionById("f_humor")!, "en", 7)).toBe(8);
    api.raw.editMessageText.mockRejectedValue(new Error("network timeout"));
    api.raw.sendRichMessage.mockClear();
    await expect(deliverProfilerCard(api as never, 123, profilerQuestionById("f_humor")!, "en", 7)).rejects.toThrow("network timeout");
    expect(api.raw.sendRichMessage).not.toHaveBeenCalled();
  });

  it("retiring a card replaces embedded controls and removes fallback controls", async () => {
    const api = apiFixture();
    await closeProfilerCard(api as never, 123, 7, "en");
    const params = api.raw.editMessageText.mock.calls[0]![0] as unknown as { rich_message: { html: string }; reply_markup: unknown };
    expect(params.rich_message.html).not.toContain("tg-button");
    expect(params.reply_markup).toEqual({ inline_keyboard: [] });
  });
});
