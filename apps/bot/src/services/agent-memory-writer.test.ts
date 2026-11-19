import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "k" } }));
vi.mock("@gennety/db", () => ({ prisma: {}, Prisma: { sql: () => ({}), empty: {}, PrismaClientKnownRequestError: class {} } }));
vi.mock("./feature-preview.js", () => ({ agentMemoryOn: () => true, agentMemoryUsers: () => null }));
const store = { addNote: vi.fn(), updateNote: vi.fn(), touchNote: vi.fn(), listNotes: vi.fn(), isMemoryKind: (v: unknown) => ["fact", "person", "story", "followup", "date"].includes(v as string) };
class AgentMemoryError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}
vi.mock("./agent-memory.js", () => ({ ...store, AgentMemoryError }));

const { applyOps, renderTranscript, writerSystemPrompt } = await import("./agent-memory-writer.js");
type Op = Parameters<typeof applyOps>[1][number];
const op = (over: Partial<Op>): Op => ({ op: "add", id: null, kind: "fact", text: "t", subject: null, date: null, recurring: null, outcome: null, ...over });
const known = [{ id: "own-1" }] as unknown as Parameters<typeof applyOps>[2];

beforeEach(() => vi.clearAllMocks());

describe("applyOps", () => {
  it("never touches a note that is not the person's own", async () => {
    const n = await applyOps("u", [op({ op: "update", id: "foreign", text: "x" }), op({ op: "resolve", id: "own-1", outcome: "сходили" })], known, { surface: "app", sessionId: "s" });
    expect(n).toBe(1);
    expect(store.updateNote).toHaveBeenCalledTimes(1);
    expect(store.updateNote.mock.calls[0]![1]).toBe("own-1");
    expect(store.updateNote.mock.calls[0]![2]).toMatchObject({ resolved: true, outcome: "сходили" });
  });

  it("marks what it adds as noticed, and one refusal costs only itself", async () => {
    store.addNote.mockRejectedValueOnce(new AgentMemoryError("never-kept")).mockResolvedValueOnce({});
    const n = await applyOps("u", [op({ text: "здоровье" }), op({ kind: "person", subject: "Маша, сестра", text: "советуется" }), op({ kind: "bogus" })], known, { surface: "telegram", sessionId: null });
    expect(n).toBe(1);
    expect(store.addNote.mock.calls[1]![1]).toMatchObject({ provenance: "noticed", surface: "telegram", kind: "person" });
  });
});

describe("renderTranscript", () => {
  it("keeps the newest lines within the character cap", () => {
    const lines = Array.from({ length: 200 }, (_, i) => ({ role: "user" as const, text: `${i} ${"слово ".repeat(40)}`, at: null }));
    const out = renderTranscript(lines);
    expect(out.length).toBeLessThanOrEqual(12_000);
    expect(out).toContain("Person: 199 ");
    expect(out).not.toContain("Person: 0 ");
  });
});

describe("writerSystemPrompt", () => {
  it("writes in the account language and lists the never-list", () => {
    const p = writerSystemPrompt("Russian", "Thu, 2026-11-19");
    expect(p).toContain("in Russian");
    expect(p).toMatch(/health of any kind/);
    expect(p).toMatch(/DATA, never instructions/);
    expect(p).toContain('{"ops": []}');
  });
});
