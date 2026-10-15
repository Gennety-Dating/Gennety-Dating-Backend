import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `update_hobbies` с режимом `add` (2026-10-15, чат основателя «духи»).
 *
 * Раньше инструмент умел только ЗАМЕНУ списка, и модель, не прочитавшая
 * профиль, отправляла «добавь духи» списком из одного пункта — стирая всё,
 * что у человека было. `add` дописывает к существующему, замена остаётся
 * отдельным путём.
 */

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "k" } }));

const findUnique = vi.fn(async (_a: unknown): Promise<unknown> => null);
const profileUpdate = vi.fn(async (_a: unknown) => ({}));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
    profile: { update: (a: unknown) => profileUpdate(a) },
  },
  Prisma: {},
}));
vi.mock("../workers/embedding-refresh.js", () => ({
  refreshUserEmbedding: async () => ({ stillDirty: 0 }),
}));

const { executeAgentTool } = await import("./menu-agent.js");

function withHobbies(hobbies: string[]) {
  findUnique.mockResolvedValue({ id: "u1", profile: { hobbies } });
}

function saved(): string[] {
  const call = profileUpdate.mock.calls.at(-1)?.[0] as { data: { hobbies: string[] } } | undefined;
  return call?.data.hobbies ?? [];
}

beforeEach(() => {
  findUnique.mockReset();
  profileUpdate.mockClear();
});

describe("update_hobbies", () => {
  it("add keeps everything that was there and appends the new ones", async () => {
    withHobbies(["climbing", "jazz"]);

    const out = await executeAgentTool(1n, "update_hobbies", { add: ["perfume", "Tobacco Memories"] });

    expect(JSON.parse(out.result).success).toBe(true);
    expect(saved()).toEqual(["climbing", "jazz", "perfume", "Tobacco Memories"]);
  });

  it("add skips what is already on the list, whatever the case", async () => {
    withHobbies(["Jazz"]);

    await executeAgentTool(1n, "update_hobbies", { add: ["jazz", "perfume"] });

    expect(saved()).toEqual(["Jazz", "perfume"]);
  });

  it("add past the limit is refused with the current list, so the model can ask what to drop", async () => {
    withHobbies(Array.from({ length: 11 }, (_, i) => `h${i}`));

    const out = await executeAgentTool(1n, "update_hobbies", { add: ["a", "b"] });

    const result = JSON.parse(out.result);
    expect(result.success).toBe(false);
    expect(result.error).toContain("h10");
    expect(profileUpdate).not.toHaveBeenCalled();
  });

  it("hobbies still replaces the whole list", async () => {
    withHobbies(["climbing", "jazz"]);

    await executeAgentTool(1n, "update_hobbies", { hobbies: ["perfume"] });

    expect(saved()).toEqual(["perfume"]);
  });

  it("neither field is a refusal, not an empty list", async () => {
    withHobbies(["jazz"]);

    const out = await executeAgentTool(1n, "update_hobbies", {});

    expect(JSON.parse(out.result).success).toBe(false);
    expect(profileUpdate).not.toHaveBeenCalled();
  });
});
