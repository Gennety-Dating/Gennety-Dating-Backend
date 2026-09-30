import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Titles and summaries of chat sessions (decision journal 2026-09-30): what the
 * small model's answer is allowed to become, when it is asked at all, and that
 * every write is a compare-and-set that can never overwrite a hand-set title.
 */

const db = {
  chatSession: { findUnique: vi.fn(), updateMany: vi.fn() },
  message: { count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
  $executeRaw: vi.fn(),
  $queryRaw: vi.fn(),
};
vi.mock("@gennety/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@gennety/db")>();
  return { ...actual, prisma: db };
});
vi.mock("../config.js", () => ({ env: { OPENAI_API_KEY: "sk-test" } }));
vi.mock("./openai.js", () => ({ callOpenAIJson: vi.fn() }));
vi.mock("./profile-analysis.js", () => ({
  createOpenAIEmbeddingClient: vi.fn(),
  toPgVectorLiteral: (vec: number[]) => `[${vec.join(",")}]`,
}));

const {
  acceptChatTitle,
  maybeTitleChatSession,
  renderDigestTranscript,
  resetChatDigestBackoff,
  sanitizeChatSummary,
  sanitizeChatTitle,
  summarizeChatSession,
  summaryDue,
  sweepChatSessionDigests,
  titleDue,
} = await import("./chat-session-digest.js");

type CallJson = NonNullable<import("./chat-session-digest.js").DigestDeps["callJson"]>;
/** A model double answering with a fixed object — cast to the generic signature. */
const asCall = (fn: unknown): CallJson => fn as CallJson;

const CHAT = "22222222-2222-4222-8222-222222222222";

function sessionRow(over: Record<string, unknown> = {}) {
  return {
    id: CHAT,
    userId: "u1",
    title: null,
    titleByUser: false,
    titledAtCount: 0,
    summarizedAtCount: 0,
    user: { language: "ru" },
    ...over,
  };
}

const talk = [
  { role: "user", content: "что надеть на свидание в пятницу?", imageUrl: null, imageUrls: [] },
  { role: "assistant", content: "Смарт-кэжуал: рубашка и чиносы.", imageUrl: null, imageUrls: [] },
];

beforeEach(() => {
  for (const group of [db.chatSession, db.message]) for (const fn of Object.values(group)) fn.mockReset();
  db.$executeRaw.mockReset().mockResolvedValue(1);
  db.$queryRaw.mockReset().mockResolvedValue([]);
  db.chatSession.updateMany.mockResolvedValue({ count: 1 });
  db.message.findFirst.mockResolvedValue(null);
  resetChatDigestBackoff();
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

function loadChat(rows = talk, over: Record<string, unknown> = {}) {
  db.chatSession.findUnique.mockResolvedValue(sessionRow(over));
  db.message.count.mockResolvedValue(rows.length);
  // `findMany` is asked newest-first.
  db.message.findMany.mockResolvedValue([...rows].reverse());
}

describe("sanitizeChatTitle", () => {
  it("strips quotes, emoji, line breaks and the trailing period", () => {
    expect(sanitizeChatTitle('"Дресс-код на свидание." 👗')).toBe("Дресс-код на свидание");
    expect(sanitizeChatTitle("«Планы на\nпятницу»")).toBe("Планы на пятницу");
    expect(sanitizeChatTitle("'Why no matches'")).toBe("Why no matches");
    expect(sanitizeChatTitle("Title: Venue swap…")).toBe("Venue swap");
  });

  it("keeps apostrophes that are letters", () => {
    expect(sanitizeChatTitle("п'ятниця з Анею")).toBe("П'ятниця з Анею");
    expect(sanitizeChatTitle("Anna's birthday plan")).toBe("Anna's birthday plan");
  });

  it("capitalises the first letter only", () => {
    expect(sanitizeChatTitle("date with Anna")).toBe("Date with Anna");
  });

  it("caps at 60 characters on a word", () => {
    const title = sanitizeChatTitle(
      "Planning the second date with Anna at the rooftop bar near the river on Friday",
    )!;
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith(" ")).toBe(false);
    expect("Planning the second date with Anna at the rooftop bar near the river".startsWith(title)).toBe(true);
  });

  it("nothing usable is null", () => {
    for (const raw of ["", "  ", '""', "🙂🙂", ".", 42, null]) {
      expect(sanitizeChatTitle(raw), String(raw)).toBeNull();
    }
  });
});

describe("acceptChatTitle — never the opening line again", () => {
  const opener = "Что надеть на свидание в пятницу?";

  it("refuses the opener itself, whatever the case and punctuation", () => {
    expect(acceptChatTitle("что надеть на свидание в пятницу", opener)).toBeNull();
  });

  it("refuses the opener's first words", () => {
    expect(acceptChatTitle("Что надеть на", opener)).toBeNull();
  });

  it("accepts a title that names the topic", () => {
    expect(acceptChatTitle("Дресс-код для свидания", opener)).toBe("Дресс-код для свидания");
  });
});

describe("sanitizeChatSummary", () => {
  it("one paragraph, capped at 2000 on a sentence", () => {
    expect(sanitizeChatSummary("  A.\n\nB.  ")).toBe("A. B.");
    const long = sanitizeChatSummary("Sentence number one is here. ".repeat(120))!;
    expect(long.length).toBeLessThanOrEqual(2000);
    expect(long.endsWith(".")).toBe(true);
    expect(sanitizeChatSummary("   ")).toBeNull();
  });
});

describe("titleDue / summaryDue", () => {
  const s = { title: null, titleByUser: false, titledAtCount: 0 };

  it("the first title waits for the first assistant reply", () => {
    expect(titleDue(s, 1, false)).toBe(false);
    expect(titleDue(s, 2, false)).toBe(false);
    expect(titleDue(s, 2, true)).toBe(true);
  });

  it("a title is refreshed once the chat has grown by six", () => {
    const titled = { title: "X", titleByUser: false, titledAtCount: 2 };
    expect(titleDue(titled, 7, true)).toBe(false);
    expect(titleDue(titled, 8, true)).toBe(true);
  });

  it("a rejected attempt is not repeated at the same size", () => {
    expect(titleDue({ ...s, titledAtCount: 2 }, 2, true)).toBe(false);
    expect(titleDue({ ...s, titledAtCount: 2 }, 3, true)).toBe(true);
  });

  it("never over a hand-set title", () => {
    expect(titleDue({ title: "Моё", titleByUser: true, titledAtCount: 0 }, 50, true)).toBe(false);
  });

  it("a summary is stale exactly when the chat grew", () => {
    expect(summaryDue({ summarizedAtCount: 0 }, 1)).toBe(false);
    expect(summaryDue({ summarizedAtCount: 0 }, 2)).toBe(true);
    expect(summaryDue({ summarizedAtCount: 4 }, 4)).toBe(false);
  });
});

describe("renderDigestTranscript", () => {
  it("names the speakers and shows photos as markers", () => {
    expect(
      renderDigestTranscript([
        { role: "user", content: "вот", imageUrl: "a", imageUrls: ["a", "b"] },
        { role: "assistant", content: "Красиво", imageUrl: null, imageUrls: [] },
      ]),
    ).toBe("Person: вот [2 photos]\nGennety: Красиво");
  });

  it("over budget keeps the opening two lines and the newest", () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `line ${i} ${"x".repeat(80)}`,
      imageUrl: null,
      imageUrls: [],
    }));
    const text = renderDigestTranscript(rows, 1_000);
    expect(text.length).toBeLessThanOrEqual(1_000);
    expect(text).toContain("line 0 ");
    expect(text).toContain("line 1 ");
    expect(text).toContain("line 39 ");
    expect(text).toContain("[… earlier messages omitted …]");
  });
});

describe("maybeTitleChatSession", () => {
  it("titles in the account language with the cheap model, CAS on the count", async () => {
    loadChat();
    const callJson = vi.fn(async () => ({ title: "Дресс-код для свидания" }));

    expect(await maybeTitleChatSession(CHAT, { callJson: asCall(callJson) })).toBe("titled");

    const [system, transcript, options] = callJson.mock.calls[0]! as unknown as [
      string,
      string,
      { model: string },
    ];
    expect(system).toContain("Write it in Russian");
    expect(system).toContain("Never quote or paraphrase the person's first message");
    expect(transcript).toContain("Person: что надеть");
    expect(options.model).toBeTruthy();
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT, titleByUser: false, titledAtCount: 0 },
      data: { title: "Дресс-код для свидания", titledAtCount: 2 },
    });
  });

  it("a hand-set title is never sent to the model", async () => {
    loadChat(talk, { title: "Моё", titleByUser: true });
    const callJson = vi.fn();
    expect(await maybeTitleChatSession(CHAT, { callJson })).toBe("skipped");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("no title before the first assistant reply", async () => {
    loadChat([talk[0]!, { ...talk[0]!, content: "алло?" }]);
    const callJson = vi.fn();
    expect(await maybeTitleChatSession(CHAT, { callJson })).toBe("skipped");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("an echo of the opener records the attempt but writes no title", async () => {
    loadChat();
    const callJson = vi.fn(async () => ({ title: "Что надеть на свидание в пятницу" }));
    expect(await maybeTitleChatSession(CHAT, { callJson: asCall(callJson) })).toBe("rejected");
    expect(db.chatSession.updateMany).toHaveBeenCalledWith({
      where: { id: CHAT, titleByUser: false, titledAtCount: 0 },
      data: { titledAtCount: 2 },
    });
  });

  it("a failed call writes nothing", async () => {
    loadChat();
    expect(await maybeTitleChatSession(CHAT, { callJson: vi.fn(async () => null) })).toBe("failed");
    expect(db.chatSession.updateMany).not.toHaveBeenCalled();
  });
});

describe("summarizeChatSession", () => {
  it("writes summary, embedding and title in one guarded statement", async () => {
    loadChat();
    const callJson = vi.fn(async () => ({
      title: "Дресс-код для свидания",
      summary: "The person asked what to wear to a Friday date. Gennety suggested smart casual.",
    }));
    const embed = vi.fn(async () => [0.1, 0.2]);

    expect(await summarizeChatSession(CHAT, { callJson: asCall(callJson), embed })).toBe("summarized");

    const [system] = callJson.mock.calls[0]! as unknown as [string];
    expect(system).toContain("In English, whatever language the conversation was in");
    expect(embed).toHaveBeenCalledWith(
      "Дресс-код для свидания\nThe person asked what to wear to a Friday date. Gennety suggested smart casual.",
    );
    const sql = db.$executeRaw.mock.calls[0]!;
    const text = (sql[0] as TemplateStringsArray).join("?");
    expect(text).toContain("summary_embedding =");
    expect(text).toContain("CASE WHEN title_by_user");
    expect(text).toContain("AND summarized_at_count =");
    expect(sql).toContain("[0.1,0.2]");
  });

  it("an embedding that fails writes nothing — an unfindable summary is worse than none", async () => {
    loadChat();
    const callJson = vi.fn(async () => ({ title: "T", summary: "S." }));
    const embed = vi.fn(async () => {
      throw new Error("429");
    });
    expect(await summarizeChatSession(CHAT, { callJson: asCall(callJson), embed })).toBe("failed");
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("a fresh summary is not redone", async () => {
    loadChat(talk, { summarizedAtCount: 2, title: "T", titledAtCount: 2 });
    const callJson = vi.fn();
    expect(await summarizeChatSession(CHAT, { callJson, embed: vi.fn() })).toBe("skipped");
    expect(callJson).not.toHaveBeenCalled();
  });

  it("the person's title is kept: no title is proposed to the statement", async () => {
    loadChat(talk, { title: "Моё", titleByUser: true });
    const callJson = vi.fn(async () => ({ title: "Другое", summary: "S." }));
    await summarizeChatSession(CHAT, { callJson: asCall(callJson), embed: vi.fn(async () => [1]) });
    const params = db.$executeRaw.mock.calls[0]!.slice(1);
    expect(params).not.toContain("Другое");
  });
});

describe("sweepChatSessionDigests", () => {
  it("digests the chats the query picks and backs off the ones that fail", async () => {
    db.$queryRaw.mockResolvedValueOnce([{ id: CHAT }]);
    loadChat();
    const callJson = vi.fn(async () => null);

    const first = await sweepChatSessionDigests({ callJson, embed: vi.fn(), now: () => new Date("2026-09-30T12:00:00Z") });
    expect(first).toEqual({ scanned: 1, summarized: 0, failed: 1 });

    // The next pass excludes the chat in backoff inside the query itself.
    db.$queryRaw.mockResolvedValueOnce([]);
    await sweepChatSessionDigests({ callJson, embed: vi.fn(), now: () => new Date("2026-09-30T12:05:00Z") });
    const params = db.$queryRaw.mock.calls[1]!.slice(1).flat();
    expect(params).toContain(CHAT);
  });
});
