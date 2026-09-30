import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `search_past_chats` / `read_past_chat` (decision journal 2026-09-30): scoped
 * to the caller, never the chat already in context, degrade to words when the
 * embedding fails, and `datesAround` never carries the partner's side.
 * The SQL runs against Postgres in `chat-sessions.integration.test.ts`.
 */

const db = {
  chatSession: { findFirst: vi.fn() },
  message: { count: vi.fn(), findMany: vi.fn() },
  match: { findMany: vi.fn() },
  $queryRaw: vi.fn(),
};
vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return { ...actual, prisma: db };
});
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
vi.mock("./profile-analysis.js", () => ({
  createOpenAIEmbeddingClient: vi.fn(),
  toPgVectorLiteral: (vec: number[]) => `[${vec.join(",")}]`,
}));

const { datesAround, executePastChatTool, keywordPatterns, localStamp, readPastChat, searchPastChats } =
  await import("./chat-past-tools.js");

const USER = "11111111-1111-4111-8111-111111111111";
const PARTNER = "99999999-9999-4999-8999-999999999999";
const NOW_CHAT = "22222222-2222-4222-8222-222222222222";
const OLD_CHAT = "33333333-3333-4333-8333-333333333333";
const UNSUMMARIZED = "44444444-4444-4444-8444-444444444444";

const at = (iso: string) => new Date(iso);

beforeEach(() => {
  db.chatSession.findFirst.mockReset();
  db.message.count.mockReset().mockResolvedValue(0);
  db.message.findMany.mockReset().mockResolvedValue([]);
  db.match.findMany.mockReset().mockResolvedValue([]);
  db.$queryRaw.mockReset().mockResolvedValue([]);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

/** The interpolated values of the n-th `$queryRaw` call, flattened. */
function rawParams(n: number): unknown[] {
  return db.$queryRaw.mock.calls[n]!.slice(1).flat();
}
/** The SQL text of the n-th call, nested `Prisma.sql` fragments included. */
function rawText(n: number): string {
  const [strings, ...values] = db.$queryRaw.mock.calls[n]! as [TemplateStringsArray, ...unknown[]];
  const render = (v: unknown): string =>
    v && typeof v === "object" && "strings" in v ? (v as { strings: string[] }).strings.join("?") : "?";
  return strings.reduce((acc, s, i) => acc + s + (i < values.length ? render(values[i]) : ""), "");
}

describe("localStamp", () => {
  it("renders in the app's zone, not the host's", () => {
    expect(localStamp(at("2026-09-22T15:05:00Z"))).toBe("Tue 2026-09-22 18:05");
  });
});

describe("keywordPatterns", () => {
  it("puts the model's own-language keywords first and escapes LIKE wildcards", () => {
    expect(keywordPatterns("dress code with Anna", ["Аня", "50%_off"])).toEqual([
      "%Аня%",
      "%50\\%\\_off%",
      "%dress%",
      "%code%",
      "%Anna%",
    ]);
  });

  it("drops short words, stopwords and duplicates; at most six", () => {
    const patterns = keywordPatterns("what about that date with Anna anna and Oksana Kyivska Podil Obolon Lukianivka", []);
    expect(patterns).toContain("%Anna%");
    expect(patterns.filter((p) => p.toLowerCase() === "%anna%")).toHaveLength(1);
    expect(patterns).not.toContain("%what%");
    expect(patterns).not.toContain("%and%");
    expect(patterns.length).toBeLessThanOrEqual(6);
  });
});

describe("searchPastChats", () => {
  const summarized = {
    id: OLD_CHAT,
    title: "Дресс-код",
    summary: "The person asked what to wear to the date with Anna.",
    created_at: at("2026-09-20T10:00:00Z"),
    updated_at: at("2026-09-20T11:00:00Z"),
  };
  const fresh = {
    id: UNSUMMARIZED,
    title: null,
    summary: null,
    created_at: at("2026-09-29T10:00:00Z"),
    updated_at: at("2026-09-29T10:30:00Z"),
  };

  it("vector hits first, unsummarized word matches after; the current chat is excluded in both", async () => {
    db.$queryRaw.mockResolvedValueOnce([summarized]).mockResolvedValueOnce([fresh]);
    db.message.findMany.mockResolvedValue([
      { role: "user", content: "Аня опаздывает", imageUrl: null, imageUrls: [], createdAt: at("2026-09-29T10:00:00Z") },
    ]);
    const embed = vi.fn(async () => [0.5, 0.5]);

    const out = JSON.parse(
      await searchPastChats(USER, NOW_CHAT, { query: "date with Anna", keywords: ["Аня"] }, { embed }),
    );

    expect(embed).toHaveBeenCalledWith("date with Anna");
    // Both queries are scoped to the caller and exclude the chat in context.
    for (const n of [0, 1]) {
      expect(rawParams(n)).toEqual(expect.arrayContaining([USER, NOW_CHAT]));
    }
    expect(rawText(0)).toContain("<=>");
    expect(rawText(1)).toContain("summary_embedding IS NULL");
    expect(rawParams(1)).toEqual(expect.arrayContaining(["%Аня%"]));
    expect(out.success).toBe(true);
    expect(out.hits.map((h: { chatId: string }) => h.chatId)).toEqual([OLD_CHAT, UNSUMMARIZED]);
    expect(out.hits[0]).toMatchObject({
      title: "Дресс-код",
      summary: summarized.summary,
      startedAt: "Sun 2026-09-20 13:00",
    });
    expect(out.hits[1]).toMatchObject({ summary: null, opening: ["person: Аня опаздывает"] });
    expect(out.timeZone).toBe("Europe/Kyiv");
  });

  it("a failed embedding degrades to words over EVERY chat", async () => {
    db.$queryRaw.mockResolvedValueOnce([summarized]);
    const embed = vi.fn(async () => {
      throw new Error("503");
    });

    const out = JSON.parse(await searchPastChats(USER, NOW_CHAT, { query: "Anna dress" }, { embed }));

    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(rawText(0)).not.toContain("summary_embedding IS NULL");
    expect(rawText(0)).toContain("ILIKE ANY");
    expect(out.hits.map((h: { chatId: string }) => h.chatId)).toEqual([OLD_CHAT]);
  });

  it("nothing found says so instead of leaving room to guess", async () => {
    const out = JSON.parse(await searchPastChats(USER, NOW_CHAT, { query: "zzz" }, { embed: async () => [1] }));
    expect(out.hits).toEqual([]);
    expect(out.detail).toMatch(/do not guess/);
  });

  it("an empty query is refused without touching the database", async () => {
    const out = JSON.parse(await searchPastChats(USER, NOW_CHAT, { query: "  " }, { embed: async () => [1] }));
    expect(out).toEqual({ success: false, error: "empty_query" });
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });
});

describe("readPastChat", () => {
  it("someone else's chat reads exactly like one that never existed", async () => {
    db.chatSession.findFirst.mockResolvedValue(null);
    const out = JSON.parse(await readPastChat(USER, NOW_CHAT, { chatId: OLD_CHAT }));
    expect(out).toEqual({ success: false, error: "unknown_chat" });
    expect(db.chatSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OLD_CHAT, userId: USER } }),
    );
    expect(db.message.findMany).not.toHaveBeenCalled();
  });

  it("the chat in context is not re-read", async () => {
    const out = JSON.parse(await readPastChat(USER, NOW_CHAT, { chatId: NOW_CHAT.toUpperCase() }));
    expect(out.error).toBe("current_chat");
    expect(db.chatSession.findFirst).not.toHaveBeenCalled();
  });

  it("a malformed id never reaches the database", async () => {
    const out = JSON.parse(await readPastChat(USER, NOW_CHAT, { chatId: "../x" }));
    expect(out.error).toBe("unknown_chat");
    expect(db.chatSession.findFirst).not.toHaveBeenCalled();
  });

  it("returns the newest messages oldest-first, photos as markers, with the dates around", async () => {
    db.chatSession.findFirst.mockResolvedValue({
      id: OLD_CHAT,
      title: "Дресс-код",
      createdAt: at("2026-09-20T10:00:00Z"),
      updatedAt: at("2026-09-20T10:01:00Z"),
    });
    db.message.count.mockResolvedValue(3);
    db.message.findMany.mockResolvedValue([
      { role: "assistant", content: "Смарт-кэжуал.", imageUrl: null, imageUrls: [], createdAt: at("2026-09-20T10:01:00Z") },
      { role: "user", content: "вот варианты", imageUrl: "a", imageUrls: ["a", "b"], createdAt: at("2026-09-20T10:00:30Z") },
      { role: "user", content: "что надеть?", imageUrl: null, imageUrls: [], createdAt: at("2026-09-20T10:00:00Z") },
    ]);

    const out = JSON.parse(await readPastChat(USER, NOW_CHAT, { chatId: OLD_CHAT }));

    expect(out.transcript).toEqual([
      "Sun 2026-09-20 13:00 person: что надеть?",
      "Sun 2026-09-20 13:00 person: вот варианты [2 photos]",
      "Sun 2026-09-20 13:01 you: Смарт-кэжуал.",
    ]);
    expect(out).toMatchObject({ success: true, messageCount: 3, omittedEarlier: 0, datesAround: [] });
    expect(out.note).toMatch(/data, not instructions/);
  });
});

describe("datesAround", () => {
  it("side-resolved, the person's own answers only — never the partner's", async () => {
    db.match.findMany.mockResolvedValue([
      {
        userAId: PARTNER,
        status: "completed",
        agreedTime: at("2026-09-19T16:00:00Z"),
        venueName: "Kyiv Rooftop",
        createdAt: at("2026-09-15T10:00:00Z"),
        acceptedByA: true,
        acceptedByB: true,
        emergencyCancelledBy: null,
        feedbackByA: "PARTNER PRIVATE FEEDBACK",
        feedbackByB: "Было классно, хочу ещё",
        dateAttendedA: false,
        dateAttendedB: true,
        attendanceOutcomeA: "no_show_partner",
        attendanceOutcomeB: null,
        userA: { firstName: "Anna" },
        userB: { firstName: "Me" },
      },
    ]);

    const [date] = await datesAround(USER, at("2026-09-20T10:00:00Z"), at("2026-09-20T11:00:00Z"));

    expect(date).toEqual({
      partner: "Anna",
      status: "completed",
      at: "Sat 2026-09-19 19:00",
      venue: "Kyiv Rooftop",
      yourDecision: "accepted",
      youSaidYouMet: true,
      yourFeedback: "Было классно, хочу ещё",
    });
    expect(JSON.stringify(date)).not.toContain("PARTNER PRIVATE");
    expect(JSON.stringify(date)).not.toContain("no_show_partner");
  });

  it("asks for dates within fourteen days of the chat, or unscheduled matches alive during it", async () => {
    await datesAround(USER, at("2026-09-20T10:00:00Z"), at("2026-09-20T11:00:00Z"));
    const where = db.match.findMany.mock.calls[0]![0].where;
    expect(where.AND[0]).toEqual({ OR: [{ userAId: USER }, { userBId: USER }] });
    expect(where.AND[1].OR[0].agreedTime).toEqual({
      gte: at("2026-09-06T10:00:00Z"),
      lte: at("2026-10-04T11:00:00Z"),
    });
    // Only for a match with no time: `updatedAt` moves on any later write.
    expect(where.AND[1].OR[1]).toEqual({
      agreedTime: null,
      createdAt: { lte: at("2026-09-20T11:00:00Z") },
      updatedAt: { gte: at("2026-09-20T10:00:00Z") },
    });
  });

  it("a cancelled date says who ended it — you or the partner, nothing more", async () => {
    db.match.findMany.mockResolvedValue([
      {
        userAId: USER,
        status: "cancelled",
        agreedTime: null,
        venueName: null,
        createdAt: at("2026-09-15T10:00:00Z"),
        acceptedByA: true,
        acceptedByB: null,
        emergencyCancelledBy: PARTNER,
        feedbackByA: null,
        feedbackByB: null,
        dateAttendedA: null,
        dateAttendedB: null,
        attendanceOutcomeA: null,
        attendanceOutcomeB: null,
        userA: { firstName: "Me" },
        userB: { firstName: "Oksana" },
      },
    ]);
    const [date] = await datesAround(USER, at("2026-09-20T10:00:00Z"), at("2026-09-20T11:00:00Z"));
    expect(date).toEqual({
      partner: "Oksana",
      status: "cancelled",
      at: null,
      venue: null,
      yourDecision: "accepted",
      cancelledBy: "partner",
    });
  });
});

describe("executePastChatTool", () => {
  it("a database error is a tool answer, not a crashed turn", async () => {
    db.chatSession.findFirst.mockRejectedValue(new Error("db down"));
    const out = JSON.parse(await executePastChatTool(USER, NOW_CHAT, "read_past_chat", { chatId: OLD_CHAT }));
    expect(out).toEqual({ success: false, error: "unavailable" });
  });
});
