import { describe, expect, it, vi } from "vitest";

vi.mock("../../config.js", () => ({ env: {} }));
vi.mock("@gennety/db", () => ({ prisma: {}, Prisma: {} }));
vi.mock("../auth-middleware.js", () => ({ requireAuth: () => undefined }));
vi.mock("../rate-limit.js", () => ({ memoryIdeasLimiter: () => undefined }));

const { clusterNotes } = await import("./agent-memory.js");
type Note = Parameters<typeof clusterNotes>[0][number];
let n = 0;
const note = (over: Partial<Note>): Note => ({
  id: `id-${(n += 1)}`,
  kind: "fact",
  text: "x",
  subject: null,
  dueOn: null,
  recurring: false,
  status: null,
  outcome: null,
  provenance: "noticed",
  surface: "app",
  lastSeenAt: new Date(0),
  createdAt: new Date(0),
  ...over,
});

describe("clusterNotes", () => {
  it("puts a person's notes together and the rest by kind", () => {
    const clusters = clusterNotes([
      note({ kind: "person", subject: "Маша, сестра", text: "Маша — старшая сестра" }),
      note({ kind: "fact", text: "Маша считает, что Олег тебе не пара" }),
      note({ kind: "story", subject: "Олег", text: "переписываются", status: "open" }),
      note({ kind: "followup", subject: "Олег", text: "написать первой", status: "open" }),
      note({ kind: "fact", text: "Учится в КПИ" }),
      note({ kind: "date", text: "Сессия", dueOn: "2027-01-15" }),
      note({ kind: "followup", text: "Начать не с «привет»", status: "open" }),
    ]);
    expect(clusters.map((c) => [c.kind, c.title, c.notes.length])).toEqual([
      ["person", "Маша", 2],
      ["story", "Олег", 2],
      ["about", null, 1],
      ["followups", null, 1],
      ["dates", null, 1],
    ]);
  });
});
