import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Чат приложения и ОБЩИЙ набор инструментов.
 *
 * Проверяется не то, что инструменты работают — это покрыто там, где они
 * живут, — а то, что чат до них дотягивается. До этого хода у него было два
 * собственных инструмента и статический промпт: агент в приложении и агент в
 * Telegram носили одно имя и умели разное. Тест держит границу, по которой их
 * свели: набор общий, бюджет записей общий, ключ исполнителей — `telegramId`.
 */

const env = { OPENAI_API_KEY: "k" };
vi.mock("../config.js", () => ({ env }));

const findUnique = vi.fn(async (_a: unknown): Promise<unknown> => ({
  telegramId: 4242n,
  language: "ru",
}));
const messageCreate = vi.fn(async (_a: unknown) => ({
  id: "m1",
  content: "ответ",
  createdAt: new Date("2026-09-08T10:00:00Z"),
}));
vi.mock("@gennety/db", () => ({
  prisma: {
    user: { findUnique: (a: unknown) => findUnique(a) },
    message: {
      create: (a: unknown) => messageCreate(a),
      findMany: async () => [],
    },
  },
}));

const executeAgentTool = vi.fn(async (_id: bigint, _name: string, _args: unknown) => ({
  result: JSON.stringify({ success: true }),
  receiptKey: "editBioSaved" as const,
  action: null,
}));
const buildSystemPrompt = vi.fn(async (_id: bigint) => "ОБЩИЙ ПРОМПТ");

vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [
    { type: "function", function: { name: "update_bio", parameters: {} } },
    { type: "function", function: { name: "get_my_standing", parameters: {} } },
  ],
  TOOL_KINDS: { update_bio: "write", get_my_standing: "read" },
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: (r: string) => JSON.parse(r).success === true,
  executeAgentTool: (id: bigint, n: string, a: unknown) => executeAgentTool(id, n, a),
}));
vi.mock("./prompt-builder.js", () => ({
  buildSystemPrompt: (id: bigint) => buildSystemPrompt(id),
}));

const applyChatProfilePatch = vi.fn(async () => ({ ok: true }));
vi.mock("./chat-profile-tools.js", () => ({
  applyChatProfilePatch: () => applyChatProfilePatch(),
  attachChatProfilePhoto: async () => ({ ok: true }),
}));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async () => null }));

/** Ответ модели: сначала вызовы инструментов, потом текст. */
function completion(calls: Array<{ name: string; args?: string }>) {
  return {
    choices: [
      {
        message: {
          role: "assistant",
          content: null,
          tool_calls: calls.map((c, i) => ({
            id: `c${i}`,
            type: "function",
            function: { name: c.name, arguments: c.args ?? "{}" },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  };
}
const plain = {
  choices: [
    { message: { role: "assistant", content: "готово" }, finish_reason: "stop" },
  ],
};

let queue: unknown[] = [];
const fetchFn = vi.fn(async () => ({
  ok: true,
  json: async () => queue.shift() ?? plain,
})) as unknown as typeof fetch;

const { runChatTurn } = await import("./chat-agent.js");

beforeEach(() => {
  executeAgentTool.mockClear();
  buildSystemPrompt.mockClear();
  applyChatProfilePatch.mockClear();
  queue = [];
});

describe("чат приложения ходит в общий набор инструментов", () => {
  it("инструмент меню исполняется общим исполнителем по telegramId", async () => {
    queue = [completion([{ name: "update_bio", args: '{"bio":"новое"}' }]), plain];

    const turn = await runChatTurn({ userId: "u1", text: "поменяй био", imageUrl: null }, { fetchFn });

    expect(executeAgentTool).toHaveBeenCalledWith(4242n, "update_bio", { bio: "новое" });
    // Чек пишет код, а не модель, и на языке аккаунта.
    expect(turn.receipts).toEqual(["«О себе» обновлено"]);
  });

  it("системный промпт берётся общий, а не свой", async () => {
    queue = [plain];

    await runChatTurn({ userId: "u1", text: "привет", imageUrl: null }, { fetchFn });

    expect(buildSystemPrompt).toHaveBeenCalledWith(4242n);
  });

  it("вторая запись за ход отвергается и до исполнителя не доходит", async () => {
    queue = [
      completion([
        { name: "update_bio", args: '{"bio":"раз"}' },
        { name: "update_bio", args: '{"bio":"два"}' },
      ]),
      plain,
    ];

    const turn = await runChatTurn({ userId: "u1", text: "поменяй дважды", imageUrl: null }, { fetchFn });

    expect(executeAgentTool).toHaveBeenCalledTimes(1);
    expect(turn.receipts).toHaveLength(1);
  });

  it("чтение бюджет не тратит", async () => {
    queue = [
      completion([
        { name: "get_my_standing" },
        { name: "update_bio", args: '{"bio":"после чтения"}' },
      ]),
      plain,
    ];

    await runChatTurn({ userId: "u1", text: "почему нет матчей", imageUrl: null }, { fetchFn });

    expect(executeAgentTool).toHaveBeenCalledTimes(2);
  });

  it("свои инструменты остаются свои и общего исполнителя не зовут", async () => {
    queue = [completion([{ name: "update_profile", args: '{"height":180}' }]), plain];

    await runChatTurn({ userId: "u1", text: "мой рост 180", imageUrl: null }, { fetchFn });

    expect(applyChatProfilePatch).toHaveBeenCalledOnce();
    expect(executeAgentTool).not.toHaveBeenCalled();
  });

  it("native-действие доезжает до вызывающего", async () => {
    executeAgentTool.mockResolvedValueOnce({
      result: JSON.stringify({ success: true }),
      receiptKey: null as never,
      action: { kind: "premium_cancel_confirm" } as never,
    });
    queue = [completion([{ name: "offer_cancel_premium" }]), plain];

    const turn = await runChatTurn({ userId: "u1", text: "отмени премиум", imageUrl: null }, { fetchFn });

    expect(turn.action).toEqual({ kind: "premium_cancel_confirm" });
  });
});
