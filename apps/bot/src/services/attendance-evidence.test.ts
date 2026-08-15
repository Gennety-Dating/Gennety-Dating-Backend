import { describe, it, expect, vi } from "vitest";
import { evidenceIsEmpty, resolveAttendanceTone } from "./attendance-evidence.js";

const EMPTY = { ownMessages: [], proxyMessages: [] };

describe("evidenceIsEmpty", () => {
  it("is true only when there is nothing at all to read", () => {
    expect(evidenceIsEmpty(EMPTY)).toBe(true);
    expect(evidenceIsEmpty({ ownMessages: ["было классно"], proxyMessages: [] })).toBe(false);
    expect(evidenceIsEmpty({ ownMessages: [], proxyMessages: ["я у входа"] })).toBe(false);
  });
});

describe("resolveAttendanceTone", () => {
  it("does not call the model at all when there is no evidence", async () => {
    // Это подавляющее большинство пар, и именно поэтому фича почти ничего не
    // стоит по токенам. Вызов здесь означал бы платить за каждое свидание.
    const callJson = vi.fn();
    expect(await resolveAttendanceTone(EMPTY, { callJson })).toBe("unknown");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("upgrades the tone only on a high-confidence verdict", async () => {
    const met = vi.fn().mockResolvedValue({ verdict: "met", confidence: "high" });
    expect(
      await resolveAttendanceTone({ ownMessages: ["было классно"], proxyMessages: [] }, {
        callJson: met,
      }),
    ).toBe("likely_met");

    const notMet = vi.fn().mockResolvedValue({ verdict: "not_met", confidence: "high" });
    expect(
      await resolveAttendanceTone({ ownMessages: ["она не пришла"], proxyMessages: [] }, {
        callJson: notMet,
      }),
    ).toBe("likely_not_met");
  });

  it("collapses a low-confidence verdict to the neutral question", async () => {
    // Строгость выражена структурно, а не просьбой в промпте: промпт может
    // ошибиться, конструкция — нет.
    const callJson = vi.fn().mockResolvedValue({ verdict: "met", confidence: "low" });
    expect(
      await resolveAttendanceTone({ ownMessages: ["ну ок"], proxyMessages: [] }, { callJson }),
    ).toBe("unknown");
  });

  it("collapses an unclear verdict even at high confidence", async () => {
    const callJson = vi.fn().mockResolvedValue({ verdict: "unclear", confidence: "high" });
    expect(
      await resolveAttendanceTone({ ownMessages: ["хм"], proxyMessages: [] }, { callJson }),
    ).toBe("unknown");
  });

  it("falls back to the neutral question when the model is unavailable", async () => {
    // `callOpenAIJson` returns null with no API key and on any failure. The
    // question must still be asked — the model only picks its wording.
    const callJson = vi.fn().mockResolvedValue(null);
    expect(
      await resolveAttendanceTone({ ownMessages: ["было классно"], proxyMessages: [] }, {
        callJson,
      }),
    ).toBe("unknown");
  });

  it("never lets a garbage payload through", async () => {
    const callJson = vi.fn().mockResolvedValue({ verdict: "met" });
    expect(
      await resolveAttendanceTone({ ownMessages: ["x"], proxyMessages: [] }, { callJson }),
    ).toBe("unknown");
  });
});
