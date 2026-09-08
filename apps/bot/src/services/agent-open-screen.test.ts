import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Новые экраны `open_screen`: справка, «подари свидание» и смена города.
 *
 * Проверяется не то, что кнопка рисуется, а два инварианта, которые её и
 * делают безопасной: агент отдаёт СУЩЕСТВУЮЩИЙ callback (выдумать он его не
 * может), и каждый гейт отказывает молча — текст отказа не должен рассказывать
 * про экран, которого человеку видеть не положено.
 */

const env = {
  TICKET_FEATURE_ENABLED: true,
  PREMIUM_FEATURE_ENABLED: true,
  REMATCH_FEATURE_ENABLED: true,
  REFERRAL_FEATURE_ENABLED: true,
  OPENAI_API_KEY: "k",
};
vi.mock("../config.js", () => ({ env }));

const findUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  language: "en",
  profile: { homeCityKey: "kyiv" },
}));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
  },
  Prisma: {},
}));

vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: true }) }));
// Киев запущен, Львов — нет.
vi.mock("../handlers/menu/city-switch.js", () => ({
  isMarketPending: (key: string | null | undefined) => Boolean(key) && key !== "kyiv",
}));

const { executeAgentTool } = await import("./menu-agent.js");

async function open(screen: string) {
  return executeAgentTool(1n, "open_screen", { screen });
}

beforeEach(() => {
  findUnique.mockReset();
  findUnique.mockResolvedValue({ language: "en", profile: { homeCityKey: "kyiv" } });
  env.REFERRAL_FEATURE_ENABLED = true;
});

describe("open_screen — новые экраны", () => {
  it("справка доступна всегда и ведёт на существующий callback", async () => {
    const out = await open("help");

    expect(out.action).toEqual({
      kind: "entry_point",
      entry: { label: expect.any(String), callbackData: "menu:help" },
    });
  });

  it("«подари свидание» скрыто, когда фича выключена", async () => {
    env.REFERRAL_FEATURE_ENABLED = false;

    const out = await open("referral");

    expect(out.action).toBeNull();
    expect(JSON.parse(out.result).success).toBe(false);
  });

  it("смена города предлагается тому, чей город не запущен", async () => {
    findUnique.mockResolvedValue({ language: "en", profile: { homeCityKey: "lviv" } });

    const out = await open("city");

    expect(out.action).toEqual({
      kind: "entry_point",
      entry: { label: expect.any(String), callbackData: "menu:city" },
    });
  });

  it("тому, кто уже в запущенном городе, кнопки нет", async () => {
    findUnique.mockResolvedValue({ language: "en", profile: { homeCityKey: "kyiv" } });

    const out = await open("city");

    expect(out.action).toBeNull();
    const parsed = JSON.parse(out.result);
    expect(parsed.success).toBe(false);
    // Отказ обязан велеть молчать, а не объяснять, чего человек лишён.
    expect(parsed.error).toMatch(/show no button/i);
  });

  it("несуществующий экран отвергается, а не выдумывается", async () => {
    const out = await open("wallet");

    expect(out.action).toBeNull();
    expect(JSON.parse(out.result).error).toMatch(/Unknown screen/);
  });
});
