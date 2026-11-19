import { beforeEach, describe, expect, it, vi } from "vitest";

const store = {
  addNote: vi.fn(),
  forgetAll: vi.fn(),
  forgetNote: vi.fn(),
  isMemoryKind: (v: unknown) => ["fact", "person", "story", "followup", "date"].includes(v as string),
  isMemoryPaused: vi.fn(async () => false),
  recallNotes: vi.fn(async () => []),
  setMemoryPaused: vi.fn(),
  updateNote: vi.fn(),
};
class AgentMemoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
vi.mock("./agent-memory.js", () => ({ ...store, AgentMemoryError }));

const { executeAgentMemoryTool, resetArmedForgetAll } = await import("./agent-memory-tools.js");
const ID = "11111111-1111-4111-8111-111111111111";
const ctx = (turnKey: string, at = 0) => ({ userId: "u", surface: "app" as const, sessionId: null, turnKey, now: () => at });
const parse = (s: string) => JSON.parse(s) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  resetArmedForgetAll();
});

describe("forget_memory all", () => {
  it("never forgets everything in the turn that asked", async () => {
    const first = parse(await executeAgentMemoryTool(ctx("t1"), "forget_memory", { all: true, confirmed: true }));
    expect(first.success).toBe(false);
    expect(first.error).toBe("needs_confirmation");
    const again = parse(await executeAgentMemoryTool(ctx("t1"), "forget_memory", { all: true, confirmed: true }));
    expect(again.success).toBe(false);
    expect(store.forgetAll).not.toHaveBeenCalled();
  });

  it("forgets on the next turn after the yes", async () => {
    store.forgetAll.mockResolvedValueOnce(7);
    await executeAgentMemoryTool(ctx("t1"), "forget_memory", { all: true });
    const done = parse(await executeAgentMemoryTool(ctx("t2", 60_000), "forget_memory", { all: true, confirmed: true }));
    expect(done).toMatchObject({ success: true, forgotten: 7 });
  });

  it("an old arming does not count", async () => {
    await executeAgentMemoryTool(ctx("t1"), "forget_memory", { all: true });
    const late = parse(await executeAgentMemoryTool(ctx("t2", 11 * 60_000), "forget_memory", { all: true, confirmed: true }));
    expect(late.success).toBe(false);
    expect(store.forgetAll).not.toHaveBeenCalled();
  });
});

describe("other calls", () => {
  it("forgetting one note needs an id from recall", async () => {
    const bad = parse(await executeAgentMemoryTool(ctx("t"), "forget_memory", { id: "Дима" }));
    expect(bad.error).toBe("bad_id");
    const good = parse(await executeAgentMemoryTool(ctx("t"), "forget_memory", { id: ID }));
    expect(good.success).toBe(true);
    expect(store.forgetNote).toHaveBeenCalledWith("u", ID);
  });

  it("recall with nothing found says so instead of inventing", async () => {
    const r = parse(await executeAgentMemoryTool(ctx("t"), "recall", { query: "Аня" }));
    expect(r.notes).toEqual([]);
    expect(String(r.instruction)).toMatch(/do not remember/);
  });

  it("recall while paused returns nothing", async () => {
    store.isMemoryPaused.mockResolvedValueOnce(true);
    const r = parse(await executeAgentMemoryTool(ctx("t"), "recall", {}));
    expect(r).toMatchObject({ paused: true, notes: [] });
    expect(store.recallNotes).not.toHaveBeenCalled();
  });

  it("a never-kept note is refused with a line to say", async () => {
    store.addNote.mockRejectedValueOnce(new AgentMemoryError("never-kept"));
    const r = parse(await executeAgentMemoryTool(ctx("t"), "remember", { kind: "fact", text: "антидепрессанты" }));
    expect(r).toMatchObject({ success: false, error: "never-kept" });
  });

  it("remember is the person's own words: provenance told", async () => {
    store.addNote.mockResolvedValueOnce({ id: ID, kind: "fact", text: "x", lastSeenAt: new Date(), status: null });
    await executeAgentMemoryTool({ ...ctx("t"), sessionId: "s1" }, "remember", { kind: "fact", text: "x" });
    expect(store.addNote.mock.calls[0]![1]).toMatchObject({ provenance: "told", surface: "app", sourceSessionId: "s1" });
  });
});
