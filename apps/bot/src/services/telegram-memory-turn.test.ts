import { describe, it, expect, vi, beforeEach } from "vitest";

const agentMemoryOn = vi.fn();
vi.mock("./feature-preview.js", () => ({ agentMemoryOn: (...a: unknown[]) => agentMemoryOn(...a) }));
const buildPersonCard = vi.fn();
vi.mock("./chat-person-card.js", () => ({ buildPersonCard: (...a: unknown[]) => buildPersonCard(...a) }));
const memoryPromptBlocks = vi.fn();
vi.mock("./agent-memory.js", () => ({ memoryPromptBlocks: (...a: unknown[]) => memoryPromptBlocks(...a) }));
vi.mock("./agent-memory-tools.js", () => ({ AGENT_MEMORY_TOOLS: [{ function: { name: "recall" } }] }));
vi.mock("./chat-past-tools.js", () => ({ PAST_CHAT_TOOLS: [{ function: { name: "search_past_chats" } }, { function: { name: "read_past_chat" } }] }));

const { telegramMemoryTurn, TELEGRAM_PAST_CHATS_NOTE } = await import("./telegram-memory-turn.js");

const names = (tools: ReadonlyArray<unknown>) => tools.map((t) => (t as { function: { name: string } }).function.name);

beforeEach(() => {
  vi.clearAllMocks();
  buildPersonCard.mockResolvedValue("### Person card\nМаша, 21");
  memoryPromptBlocks.mockResolvedValue(["### What you remember about them\n- sister Masha"]);
});

describe("telegramMemoryTurn (agent concept phase 4 item 8)", () => {
  it("with the memory flag off, the Telegram turn is the old one: no card, no tools", async () => {
    agentMemoryOn.mockReturnValue(false);
    expect(await telegramMemoryTurn("u1")).toEqual({ userId: null, blocks: [], tools: [] });
    expect(buildPersonCard).not.toHaveBeenCalled();
  });

  it("with it on, the agent gets the app's person card, the memory block and search_past_chats", async () => {
    agentMemoryOn.mockReturnValue(true);
    const turn = await telegramMemoryTurn("u1");
    expect(turn.userId).toBe("u1");
    expect(turn.blocks[0]).toContain("Person card");
    expect(turn.blocks[1]).toContain("What you remember");
    expect(turn.blocks.at(-1)).toBe(TELEGRAM_PAST_CHATS_NOTE);
    expect(names(turn.tools)).toEqual(["recall", "search_past_chats", "read_past_chat"]);
    expect(memoryPromptBlocks).toHaveBeenCalledWith("u1", { on: true });
  });

  it("a person card that fails drops only the card", async () => {
    agentMemoryOn.mockReturnValue(true);
    buildPersonCard.mockRejectedValueOnce(new Error("db down"));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const turn = await telegramMemoryTurn("u1");
    expect(turn.blocks[0]).toContain("What you remember");
    expect(names(turn.tools)).toContain("search_past_chats");
    warn.mockRestore();
  });

  it("no user, no memory", async () => {
    expect(await telegramMemoryTurn(null)).toEqual({ userId: null, blocks: [], tools: [] });
    expect(agentMemoryOn).not.toHaveBeenCalled();
  });
});
