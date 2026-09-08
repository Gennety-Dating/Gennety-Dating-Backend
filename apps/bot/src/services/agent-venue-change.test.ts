import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `propose_venue_change` — доска смены места из разговора.
 *
 * Проверяется то, что делает инструмент безопасным: он ничего не меняет сам
 * (класс `confirm`), адрес доски строит СЕРВЕР тем же кодом, что вешает кнопку
 * на карточку свидания, и предлагается он только при забронированном свидании.
 */

const env = { VENUE_CHANGE_FEATURE_ENABLED: true, OPENAI_API_KEY: "k" };
vi.mock("../config.js", () => ({ env }));

const userFindUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  id: "u1",
  language: "ru",
  theme: "dark",
}));
const matchFindFirst = vi.fn(async (_a: unknown): Promise<unknown> => ({ id: "m-9" }));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    match: { findFirst: (a: unknown) => matchFindFirst(a) },
  },
  Prisma: {},
}));

vi.mock("../handlers/matching/venue-change.js", () => ({
  shouldOfferVenueChange: () => env.VENUE_CHANGE_FEATURE_ENABLED,
  buildVenueChangeButton: (matchId: string, lang: string) => ({
    text: "🔄 Сменить место",
    web_app: { url: `https://app.example/venue-change?match=${matchId}&lang=${lang}` },
  }),
}));
vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: false }) }));
vi.mock("../handlers/menu/city-switch.js", () => ({ isMarketPending: () => false }));
vi.mock("./post-date-feedback.js", () => ({ pendingFeedbackFor: async () => null }));
vi.mock("../handlers/date/feedback.js", () => ({ recordPostDateFeedback: async () => ({ ok: true }) }));

const { executeAgentTool, TOOL_KINDS } = await import("./menu-agent.js");

beforeEach(() => {
  env.VENUE_CHANGE_FEATURE_ENABLED = true;
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", language: "ru", theme: "dark" });
  matchFindFirst.mockReset();
  matchFindFirst.mockResolvedValue({ id: "m-9" });
});

describe("propose_venue_change", () => {
  it("объявлен как confirm — сам ничего не меняет", () => {
    expect(TOOL_KINDS.propose_venue_change).toBe("confirm");
  });

  it("отдаёт ссылку доски, а не callback: у Mini App его нет", async () => {
    const out = await executeAgentTool(1n, "propose_venue_change", {});

    expect(out.action).toEqual({
      kind: "entry_point",
      entry: {
        label: "🔄 Сменить место",
        url: "https://app.example/venue-change?match=m-9&lang=ru",
      },
    });
    // Модель не видит адреса и не может его подменить — она называет экран.
    expect(out.receiptKey).toBeNull();
  });

  it("ищется только забронированное свидание", async () => {
    await executeAgentTool(1n, "propose_venue_change", {});

    const where = (matchFindFirst.mock.calls[0]![0] as { where: Record<string, unknown> }).where;
    expect(where.status).toBe("scheduled");
    // Отменённое экстренно — не место для смены места.
    expect(where.emergencyCancelledBy).toBeNull();
  });

  it("без забронированного свидания кнопки нет", async () => {
    matchFindFirst.mockResolvedValue(null);

    const out = await executeAgentTool(1n, "propose_venue_change", {});

    expect(out.action).toBeNull();
    expect(JSON.parse(out.result).error).toMatch(/show no button/i);
  });

  it("фича выключена — молчим и до базы не идём", async () => {
    env.VENUE_CHANGE_FEATURE_ENABLED = false;

    const out = await executeAgentTool(1n, "propose_venue_change", {});

    expect(out.action).toBeNull();
    expect(matchFindFirst).not.toHaveBeenCalled();
  });

  it("инструкция не обещает, что место переедет", async () => {
    const out = await executeAgentTool(1n, "propose_venue_change", {});

    // Смена — договорённость двоих; обещание одной стороне было бы ложью.
    expect(JSON.parse(out.result).instruction).toMatch(/do not promise/i);
  });
});
