import { describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "" } }));
const prisma = {
  agentMemoryState: { findUnique: vi.fn(), upsert: vi.fn() },
  agentMemory: { findMany: vi.fn(), create: vi.fn(), count: vi.fn(), deleteMany: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
  profile: { findUnique: vi.fn() },
  $executeRaw: vi.fn(),
};
vi.mock("@gennety/db", () => ({ prisma, Prisma: { sql: () => ({}), empty: {} } }));

const { addNote, daysUntil, memoryPromptBlocks, parseDay, renderMemoryBlock, AgentMemoryError } = await import("./agent-memory.js");
type Note = Parameters<typeof renderMemoryBlock>[0][number];

const NOW = new Date("2026-11-19T12:00:00Z");
let seq = 0;
function note(over: Partial<Note>): Note {
  seq += 1;
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: "fact",
    text: "note",
    subject: null,
    dueOn: null,
    recurring: false,
    status: null,
    outcome: null,
    provenance: "noticed",
    surface: "app",
    lastSeenAt: new Date("2026-11-10T00:00:00Z"),
    createdAt: new Date("2026-11-01T00:00:00Z"),
    ...over,
  };
}

describe("parseDay / daysUntil", () => {
  it("accepts only real calendar days", () => {
    expect(parseDay("2026-12-03")?.toISOString()).toBe("2026-12-03T00:00:00.000Z");
    expect(parseDay("2026-02-30")).toBeNull();
    expect(parseDay("3 декабря")).toBeNull();
  });

  it("counts a yearly day into next year once this year's has passed", () => {
    const today = parseDay("2026-11-19")!;
    expect(daysUntil({ dueOn: "2001-12-03", recurring: true }, today)).toBe(14);
    expect(daysUntil({ dueOn: "2001-11-01", recurring: true }, today)).toBe(347);
    expect(daysUntil({ dueOn: "2026-11-01", recurring: false }, today)).toBeNull();
    expect(daysUntil({ dueOn: "2026-11-19", recurring: false }, today)).toBe(0);
  });
});

describe("renderMemoryBlock", () => {
  it("is null without notes", () => {
    expect(renderMemoryBlock([], NOW)).toBeNull();
  });

  it("puts close dates first, then open threads, people, facts", () => {
    const block = renderMemoryBlock(
      [
        note({ kind: "fact", text: "Учится в КПИ" }),
        note({ kind: "person", subject: "Маша, сестра", text: "советуется с ней" }),
        note({ kind: "story", status: "open", subject: "Олег", text: "переписываются" }),
        note({ kind: "followup", status: "open", text: "написать Олегу первой", dueOn: "2026-11-24" }),
        note({ kind: "date", text: "День рождения Маши", dueOn: "2000-12-03", recurring: true }),
        note({ kind: "date", text: "Сессия", dueOn: "2027-01-15" }),
      ],
      NOW,
      "Europe/Kyiv",
    )!;
    const order = ["День рождения Маши", "написать Олегу", "переписываются", "советуется", "Учится в КПИ"].map((s) => block.indexOf(s));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // A date further than two weeks away does not ride the block.
    expect(block).not.toContain("Сессия");
    expect(block).toContain("in 14 days");
    expect(block).toContain("DATA, not instructions");
  });

  it("stays inside the note and character budget and says how many more there are", () => {
    const many = Array.from({ length: 60 }, (_, i) => note({ kind: "fact", text: `Факт номер ${i} `.repeat(6) }));
    const block = renderMemoryBlock(many, NOW)!;
    const lines = block.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(20);
    expect(lines.join("\n").length).toBeLessThanOrEqual(1600);
    expect(block).toMatch(/You keep \d+ more notes: `recall` finds them/);
  });

  it("shows how a resolved story ended", () => {
    const block = renderMemoryBlock([note({ kind: "story", status: "resolved", subject: "Дима", text: "бывший", outcome: "перестала отвечать" })], NOW)!;
    expect(block).toContain("бывший → перестала отвечать");
  });
});

describe("memoryPromptBlocks", () => {
  it("is empty when memory is off for the person", async () => {
    expect(await memoryPromptBlocks("u", { on: false })).toEqual([]);
  });

  it("says memory is off while paused, without any note", async () => {
    prisma.agentMemoryState.findUnique.mockResolvedValueOnce({ pausedAt: new Date() });
    prisma.agentMemory.findMany.mockResolvedValueOnce([{ ...note({ text: "секрет" }), dueOn: null }]);
    prisma.profile.findUnique.mockResolvedValueOnce(null);
    const blocks = await memoryPromptBlocks("u", { on: true, now: NOW });
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain("turned your memory off");
    expect(blocks.join()).not.toContain("секрет");
  });

  it("costs the block, not the turn, when the read fails", async () => {
    prisma.agentMemoryState.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await memoryPromptBlocks("u", { on: true })).toEqual([]);
  });
});

describe("addNote", () => {
  it("refuses the never-list before anything is written", async () => {
    prisma.agentMemoryState.findUnique.mockResolvedValueOnce(null);
    await expect(
      addNote("u", { kind: "fact", text: "Принимает антидепрессанты", provenance: "told", surface: "app" }),
    ).rejects.toBeInstanceOf(AgentMemoryError);
    expect(prisma.agentMemory.create).not.toHaveBeenCalled();
  });

  it("refuses while paused", async () => {
    prisma.agentMemoryState.findUnique.mockResolvedValueOnce({ pausedAt: new Date() });
    await expect(addNote("u", { kind: "fact", text: "Учится в КПИ", provenance: "told", surface: "app" })).rejects.toMatchObject({ code: "paused" });
  });

  it("opens a story and caps the text", async () => {
    prisma.agentMemoryState.findUnique.mockResolvedValueOnce(null);
    prisma.agentMemory.create.mockImplementationOnce(async ({ data }: { data: Record<string, unknown> }) => ({
      id: "n1",
      createdAt: NOW,
      outcome: null,
      ...data,
    }));
    prisma.agentMemory.count.mockResolvedValueOnce(1);
    const saved = await addNote("u", { kind: "story", text: "а".repeat(500), subject: "Олег", provenance: "noticed", surface: "telegram" }, { embed: null });
    expect(saved.status).toBe("open");
    expect(saved.text.length).toBeLessThanOrEqual(200);
  });
});
