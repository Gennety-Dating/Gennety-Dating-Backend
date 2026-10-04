import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_SESSION_LEGACY_GAP_MS } from "@gennety/shared";

/**
 * Chat sessions — which chat a turn lands in, and the inputs the routes trust
 * this module to judge (decision journal 2026-09-30). The SQL of the list is
 * exercised against Postgres in `chat-sessions.integration.test.ts`.
 */

const db = {
  chatSession: {
    createMany: vi.fn(),
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    updateMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
};
vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return { ...actual, prisma: db };
});

const {
  claimChatSession,
  continueOrOpenChatSession,
  normalizeChatSessionTitle,
  parseChatSessionIdField,
  renameChatSession,
  toChatSessionDto,
  touchChatSession,
  listChatSessions,
} = await import("./chat-sessions.js");
const { TOPIC_GAP_MS } = await import("./chat-topics.js");

const USER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const CHAT = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-30T12:00:00Z");

beforeEach(() => {
  for (const fn of Object.values(db.chatSession)) fn.mockReset();
  db.$queryRaw.mockReset().mockResolvedValue([]);
});

describe("parseChatSessionIdField", () => {
  it("absent is null — the legacy path", () => {
    expect(parseChatSessionIdField(undefined)).toBeNull();
    expect(parseChatSessionIdField(null)).toBeNull();
  });

  it("a UUID comes back lower-cased, the form Postgres hands back", () => {
    expect(parseChatSessionIdField(` ${CHAT.toUpperCase()} `)).toBe(CHAT);
  });

  it("anything else is invalid", () => {
    for (const raw of ["", "abc", 42, {}, [CHAT], `${CHAT}x`]) {
      expect(parseChatSessionIdField(raw), JSON.stringify(raw)).toBe("invalid");
    }
  });
});

describe("normalizeChatSessionTitle", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeChatSessionTitle("  Про \n\t Аню ")).toBe("Про Аню");
  });

  it("1..80 characters, counted as characters, not UTF-16 units", () => {
    expect(normalizeChatSessionTitle("x".repeat(80))).toBe("x".repeat(80));
    expect(normalizeChatSessionTitle("x".repeat(81))).toBeNull();
    expect(normalizeChatSessionTitle("🙂".repeat(80))).toBe("🙂".repeat(80));
    expect(normalizeChatSessionTitle("   ")).toBeNull();
    expect(normalizeChatSessionTitle(7)).toBeNull();
  });
});

describe("claimChatSession", () => {
  it("creates an unseen id for the caller without failing on a duplicate", async () => {
    db.chatSession.createMany.mockResolvedValue({ count: 1 });
    db.chatSession.findUnique.mockResolvedValue({ userId: USER });

    expect(await claimChatSession(USER, CHAT)).toBe(true);
    expect(db.chatSession.createMany).toHaveBeenCalledWith({
      data: [{ id: CHAT, userId: USER }],
      skipDuplicates: true,
    });
  });

  it("someone else's chat is refused and left as it was", async () => {
    db.chatSession.createMany.mockResolvedValue({ count: 0 });
    db.chatSession.findUnique.mockResolvedValue({ userId: OTHER });

    expect(await claimChatSession(USER, CHAT)).toBe(false);
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("continueOrOpenChatSession — the legacy six-hour rule", () => {
  it("is the same six hours the old topic index cut at", () => {
    expect(CHAT_SESSION_LEGACY_GAP_MS).toBe(TOPIC_GAP_MS);
  });

  it("continues the most recent chat while it is under six hours quiet", async () => {
    db.chatSession.findFirst.mockResolvedValue({
      id: CHAT,
      updatedAt: new Date(NOW.getTime() - CHAT_SESSION_LEGACY_GAP_MS + 1),
    });

    expect(await continueOrOpenChatSession(USER, NOW)).toBe(CHAT);
    expect(db.chatSession.create).not.toHaveBeenCalled();
    expect(db.chatSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: USER },
        orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      }),
    );
  });

  it("opens a new chat at six hours of silence", async () => {
    db.chatSession.findFirst.mockResolvedValue({
      id: CHAT,
      updatedAt: new Date(NOW.getTime() - CHAT_SESSION_LEGACY_GAP_MS),
    });
    db.chatSession.create.mockResolvedValue({ id: "new" });

    expect(await continueOrOpenChatSession(USER, NOW)).toBe("new");
    expect(db.chatSession.create).toHaveBeenCalledWith({
      data: { userId: USER, createdAt: NOW, updatedAt: NOW },
      select: { id: true },
    });
  });

  it("opens the first chat of someone who never had one", async () => {
    db.chatSession.findFirst.mockResolvedValue(null);
    db.chatSession.create.mockResolvedValue({ id: "first" });
    expect(await continueOrOpenChatSession(USER, NOW)).toBe("first");
  });
});

describe("touchChatSession", () => {
  it("only ever moves updatedAt forward", async () => {
    db.chatSession.updateMany.mockResolvedValue({ count: 1 });
    await touchChatSession(CHAT, NOW);
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT, updatedAt: { lt: NOW } },
      data: { updatedAt: NOW },
    });
  });
});

describe("toChatSessionDto", () => {
  const base = {
    id: CHAT,
    created_at: new Date("2026-09-29T10:00:00Z"),
    updated_at: new Date("2026-09-29T11:00:00Z"),
    message_count: 3,
  };

  it("an untitled chat is named by its opening line, condensed", () => {
    const dto = toChatSessionDto({
      ...base,
      title: null,
      opener: "что  надеть\nна свидание в пятницу вечером в кафе на Подоле, если там будет прохладно и ветрено?",
    });
    expect(dto.title.startsWith("что надеть на свидание")).toBe(true);
    expect(dto.title.endsWith("…")).toBe(true);
    expect(dto.title.length).toBeLessThanOrEqual(65);
    expect(dto).toMatchObject({
      id: CHAT,
      createdAt: "2026-09-29T10:00:00.000Z",
      updatedAt: "2026-09-29T11:00:00.000Z",
      messageCount: 3,
    });
  });

  it("a title wins over the opener", () => {
    expect(toChatSessionDto({ ...base, title: "Дресс-код", opener: null }).title).toBe("Дресс-код");
  });
});

describe("listChatSessions / renameChatSession — ownership", () => {
  it("a cursor that is not the caller's chat is null (404), and no page is read", async () => {
    db.chatSession.findFirst.mockResolvedValue(null);
    expect(await listChatSessions(USER, { limit: 30, before: CHAT })).toBeNull();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("one row over the page says hasMore", async () => {
    const row = (id: string) => ({
      id,
      title: id,
      created_at: NOW,
      updated_at: NOW,
      message_count: 2,
      opener: null,
    });
    db.$queryRaw.mockResolvedValue([row("a"), row("b"), row("c")]);
    const page = await listChatSessions(USER, { limit: 2 });
    expect(page?.hasMore).toBe(true);
    expect(page?.sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("renaming someone else's chat changes nothing and is null", async () => {
    db.chatSession.updateMany.mockResolvedValue({ count: 0 });
    expect(await renameChatSession(USER, CHAT, "Моё")).toBeNull();
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT, userId: USER },
      data: { title: "Моё", titleByUser: true },
    });
  });

  it("a malformed id never reaches the database", async () => {
    expect(await renameChatSession(USER, "nope", "x")).toBeNull();
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
  });
});
