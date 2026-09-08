import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `propose_report_partner` — жалоба на человека из матча.
 *
 * Проверяется то, что делает инструмент безопасным, а не то, что он работает:
 * он НИЧЕГО не подаёт сам (класс `confirm`), отдаёт существующий callback
 * карточки матча, и не отказывает после свидания — неприятное чаще всплывает
 * именно тогда.
 */

const env = { OPENAI_API_KEY: "k" };
vi.mock("../config.js", () => ({ env }));

const userFindUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  id: "u1",
  language: "en",
}));
const matchFindFirst = vi.fn(async (_a: unknown): Promise<unknown> => ({ id: "m-42" }));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => userFindUnique(a) },
    match: { findFirst: (a: unknown) => matchFindFirst(a) },
  },
  Prisma: {},
}));
vi.mock("./rematch.js", () => ({ checkRematchEligibility: async () => ({ ok: false }) }));
vi.mock("../handlers/menu/city-switch.js", () => ({ isMarketPending: () => false }));

const { executeAgentTool, TOOL_KINDS } = await import("./menu-agent.js");

beforeEach(() => {
  userFindUnique.mockReset();
  userFindUnique.mockResolvedValue({ id: "u1", language: "en" });
  matchFindFirst.mockReset();
  matchFindFirst.mockResolvedValue({ id: "m-42" });
});

describe("propose_report_partner", () => {
  it("объявлен как confirm — значит сам ничего не пишет", () => {
    expect(TOOL_KINDS.propose_report_partner).toBe("confirm");
  });

  it("отдаёт существующий callback карточки матча, а не выдуманный", async () => {
    const out = await executeAgentTool(1n, "propose_report_partner", {});

    expect(out.action).toEqual({
      kind: "entry_point",
      entry: { label: expect.any(String), callbackData: "report:open:m-42" },
    });
    // Чека нет: ничего не сохранилось, и сообщать «готово» было бы враньём.
    expect(out.receiptKey).toBeNull();
  });

  it("после свидания жалоба всё ещё возможна", async () => {
    await executeAgentTool(1n, "propose_report_partner", {});

    const where = (matchFindFirst.mock.calls[0]![0] as {
      where: { status: { in: string[] } };
    }).where;
    expect(where.status.in).toContain("completed");
  });

  it("без матча — отказ, но с указанием отнестись серьёзно", async () => {
    matchFindFirst.mockResolvedValue(null);

    const out = await executeAgentTool(1n, "propose_report_partner", {});

    expect(out.action).toBeNull();
    const parsed = JSON.parse(out.result);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toMatch(/seriously/i);
  });

  it("инструкция запрещает выспрашивать подробности", async () => {
    const out = await executeAgentTool(1n, "propose_report_partner", {});

    // Человек не должен пересказывать неприятное дважды — агенту и форме.
    expect(JSON.parse(out.result).instruction).toMatch(/do not ask for details/i);
  });
});
