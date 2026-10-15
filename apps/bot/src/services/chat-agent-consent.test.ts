import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Consent gate (2026-10-15): "вот мои любимые духи" is not "save my perfume".
 * The live evals caught the agent saving shared facts straight to the profile;
 * a profile write the person neither asked for nor agreed to now never reaches
 * the executor, and the model hears why and turns it into an offer.
 */

const userFindUnique = vi.fn();
const messageFindMany = vi.fn(async (): Promise<unknown[]> => []);
vi.mock("@gennety/db", () => ({
  prisma: {
    message: {
      create: vi.fn(async ({ data }: { data: { content: string } }) => ({
        id: "m1",
        content: data.content,
        createdAt: new Date("2026-10-15T03:10:00.000Z"),
      })),
      delete: vi.fn(async () => ({})),
      findMany: () => messageFindMany(),
    },
    user: { findUnique: (a: unknown) => userFindUnique(a) },
  },
}));
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
vi.mock("./storage.js", () => ({ createChatImageSignedUrl: async () => null }));
vi.mock("./openai-fetch.js", () => ({ openaiFetch: vi.fn() }));
vi.mock("./chat-profile-tools.js", () => ({ applyChatProfilePatch: vi.fn(), attachChatProfilePhoto: vi.fn() }));
vi.mock("./prompt-builder.js", () => ({ buildSystemPrompt: vi.fn(async () => "SYSTEM") }));
const executeAgentTool = vi.fn();
vi.mock("./menu-agent.js", () => ({
  AGENT_TOOLS: [],
  TOOL_KINDS: { update_hobbies: "write" },
  MAX_WRITES_PER_TURN: 1,
  toolReportedSuccess: () => true,
  executeAgentTool: (...a: unknown[]) => executeAgentTool(...a),
}));
vi.mock("./chat-sessions.js", () => ({
  continueOrOpenChatSession: async () => "s",
  touchChatSession: async () => undefined,
}));
vi.mock("./chat-session-digest.js", () => ({ afterChatTurn: () => undefined }));
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: async () => null }));

const { runChatTurn, collapseRepeat } = await import("./chat-agent.js");

describe("collapseRepeat", () => {
  const answer = "о, у тебя три разных настроения.\n\nХочешь, добавлю их в интересы?";

  it("a reply written twice is kept once, whatever joins the halves", () => {
    expect(collapseRepeat(`${answer}\n${answer}`)).toBe(answer);
    expect(collapseRepeat(`${answer}\n\n${answer}`)).toBe(answer);
  });

  it("a reworded second copy replaces the first (live eval, 2026-10-15)", () => {
    const reply =
      "у тебя очень цельный вкус: Le Beau, Russian Tea и Tobacco Memories — свежий, чайный и тёплый табачный профили. Такой набор хорошо задаёт настроение для разговора о запахах и любимых местах.\n\n" +
      "добавить эти духи в интересы профиля?\n" +
      "у тебя очень цельный вкус: Le Beau, Russian Tea и Tobacco Memories — свежий, чайный и тёплый табачный профили. Такой набор легко станет хорошей темой для разговора на свидании.\n\n" +
      "добавить эти духи в интересы профиля?";
    expect(collapseRepeat(reply)).toBe(
      "у тебя очень цельный вкус: Le Beau, Russian Tea и Tobacco Memories — свежий, чайный и тёплый табачный профили. Такой набор легко станет хорошей темой для разговора на свидании.\n\n" +
        "добавить эти духи в интересы профиля?",
    );
  });

  it("two different thoughts are not a repeat", () => {
    const reply = "Tobacco Memories — самый вечерний из трёх, тёплый и плотный.\n\nRussian Tea тоже подойдёт, если хочется мягче.";
    expect(collapseRepeat(reply)).toBe(reply);
  });

  it("leaves short echoes and ordinary replies alone", () => {
    expect(collapseRepeat("да да")).toBe("да да");
    expect(collapseRepeat(answer)).toBe(answer);
  });
});

const USER = "11111111-1111-4111-8111-111111111111";
const CHAT = "44444444-4444-4444-8444-444444444444";

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

function turn(consented: boolean) {
  const sent: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
  let call = 0;
  const fetchFn = (async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body));
    call += 1;
    if (call === 1) {
      return json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [{ id: "w1", type: "function", function: { name: "update_hobbies", arguments: '{"add":["духи"]}' } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      });
    }
    return json({ choices: [{ message: { content: "готово" }, finish_reason: "stop" }] });
  }) as unknown as typeof fetch;
  const consent = vi.fn(async () => consented);
  return { sent, fetchFn, consent };
}

beforeEach(() => {
  userFindUnique.mockReset().mockResolvedValue({ telegramId: 1n, language: "ru" });
  messageFindMany.mockReset().mockResolvedValue([
    // newest first, as the query returns them
    { role: "user", content: "вот мои любимые духи", imageUrl: null, imageUrls: [], context: null },
    { role: "assistant", content: "классный выбор. добавить в интересы?", imageUrl: null, imageUrls: [], context: null },
  ]);
  executeAgentTool.mockReset().mockResolvedValue({
    result: JSON.stringify({ success: true }),
    receiptKey: null,
    action: null,
  });
});

describe("chat agent consent gate", () => {
  it("asks with the person's message and the offer it answers, and holds the write on a no", async () => {
    const { sent, fetchFn, consent } = turn(false);

    await runChatTurn({ userId: USER, text: "вот мои любимые духи", imageUrls: [], sessionId: CHAT }, { fetchFn, consent });

    expect(consent).toHaveBeenCalledWith({
      previous: "классный выбор. добавить в интересы?",
      message: "вот мои любимые духи",
      tool: "update_hobbies",
      args: { add: ["духи"] },
    });
    expect(executeAgentTool).not.toHaveBeenCalled();
    const toolReply = sent[1]!.messages.find((m) => m.role === "tool")!;
    expect(String(toolReply.content)).toContain("no_consent");
  });

  it("a yes lets the write through", async () => {
    const { fetchFn, consent } = turn(true);

    await runChatTurn({ userId: USER, text: "да, добавь", imageUrls: [], sessionId: CHAT }, { fetchFn, consent });

    expect(executeAgentTool).toHaveBeenCalledWith(1n, "update_hobbies", { add: ["духи"] });
  });

  it("reads and other tools never ask", async () => {
    const { consent } = turn(false);
    let call = 0;
    const fetchFn = (async () => {
      call += 1;
      return call === 1
        ? json({
            choices: [
              {
                message: {
                  content: null,
                  tool_calls: [{ id: "r1", type: "function", function: { name: "get_my_profile", arguments: "{}" } }],
                },
                finish_reason: "tool_calls",
              },
            ],
          })
        : json({ choices: [{ message: { content: "вот" }, finish_reason: "stop" }] });
    }) as unknown as typeof fetch;

    await runChatTurn({ userId: USER, text: "что у меня в профиле?", imageUrls: [], sessionId: CHAT }, { fetchFn, consent });

    expect(consent).not.toHaveBeenCalled();
    expect(executeAgentTool).toHaveBeenCalledWith(1n, "get_my_profile", {});
  });
});
