/**
 * Chat sessions against a REAL Postgres (decision journal 2026-09-30).
 *
 * The unit tests mock `$queryRaw`, so none of this file's SQL runs anywhere
 * else: the list's lateral count and fallback line, the `(updated_at, id)`
 * cursor, the digest pick with its UTC wall-time cutoff, the keyword fallback's
 * `ILIKE ANY`, the pgvector ordering and the guarded summary UPDATE.
 *
 * The pgvector cases skip on a database without the extension (a scratch
 * Postgres); CI's `pgvector/pgvector` image runs them all.
 *
 * Prerequisites (same as every integration file):
 *   docker compose -f docker-compose.test.yml up -d
 *   DATABASE_URL=postgresql://gennety:gennety@localhost:5433/gennety_test \
 *     pnpm --filter @gennety/db db:push
 */

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  cleanDatabase,
  integrationPrisma as db,
  seedUser,
} from "../../../../packages/db/src/test-integration.js";
import {
  claimChatSession,
  continueOrOpenChatSession,
  getChatSession,
  listChatSessions,
  renameChatSession,
  touchChatSession,
} from "./chat-sessions.js";
import {
  resetChatDigestBackoff,
  summarizeChatSession,
  sweepChatSessionDigests,
} from "./chat-session-digest.js";
import { datesAround, readPastChat, searchPastChats } from "./chat-past-tools.js";

const [{ n: vectorInstalled }] = await db.$queryRaw<Array<{ n: number }>>`
  SELECT count(*)::int AS n FROM pg_extension WHERE extname = 'vector'
`;
const hasVector = vectorInstalled > 0;

beforeEach(async () => {
  await cleanDatabase();
  resetChatDigestBackoff();
});

afterAll(async () => {
  await db.$disconnect();
});

const T0 = new Date("2026-09-20T10:00:00.000Z");
const minutes = (m: number) => new Date(T0.getTime() + m * 60_000);

async function chat(
  userId: string,
  rows: Array<{ role: "user" | "assistant" | "system"; content: string; at: Date; imageUrls?: string[] }>,
  over: { title?: string; titleByUser?: boolean } = {},
): Promise<string> {
  const first = rows[0]?.at ?? T0;
  const last = rows[rows.length - 1]?.at ?? T0;
  const session = await db.chatSession.create({
    data: { userId, createdAt: first, updatedAt: last, ...over },
  });
  for (const row of rows) {
    await db.message.create({
      data: {
        userId,
        sessionId: session.id,
        role: row.role,
        content: row.content,
        imageUrls: row.imageUrls ?? [],
        imageUrl: row.imageUrls?.[0] ?? null,
        createdAt: row.at,
      },
    });
  }
  return session.id;
}

/** A unit vector along one axis — cosine picks by axis. */
function axis(i: number): number[] {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
}

async function setEmbedding(sessionId: string, vec: number[], summary: string): Promise<void> {
  await db.$executeRaw`
    UPDATE chat_sessions
    SET summary = ${summary}, summary_embedding = ${`[${vec.join(",")}]`}::vector, summarized_at_count = 99
    WHERE id = ${sessionId}::uuid
  `;
}

describe("listChatSessions", () => {
  it("most recent first, only chats with a real message, counts without system rows", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const older = await chat(me.id, [
      { role: "assistant", content: "Привет! Я Gennety.", at: minutes(0) },
      { role: "user", content: "  что   надеть\nв пятницу?", at: minutes(1) },
      { role: "system", content: "sys", at: minutes(2) },
    ]);
    const newer = await chat(
      me.id,
      [
        { role: "user", content: "почему нет пары", at: minutes(60) },
        { role: "assistant", content: "Потому что…", at: minutes(61) },
      ],
      { title: "Почему нет пары" },
    );
    await chat(me.id, [{ role: "system", content: "only system", at: minutes(90) }]);
    await claimChatSession(me.id, "55555555-5555-4555-8555-555555555555");
    await chat(other.id, [{ role: "user", content: "чужое", at: minutes(120) }]);

    const page = await listChatSessions(me.id, { limit: 30 });

    expect(page?.hasMore).toBe(false);
    expect(page?.sessions.map((s) => s.id)).toEqual([newer, older]);
    // The person's own line names an untitled chat, even when the assistant spoke first.
    expect(page?.sessions[1]).toMatchObject({ title: "что надеть в пятницу?", messageCount: 2 });
    expect(page?.sessions[0]).toMatchObject({
      title: "Почему нет пары",
      messageCount: 2,
      updatedAt: minutes(61).toISOString(),
      createdAt: minutes(60).toISOString(),
    });
  });

  it("pages on (updated_at, id) — a tie on updated_at neither skips nor repeats", async () => {
    const me = await seedUser();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      ids.push(await chat(me.id, [{ role: "user", content: `chat ${i}`, at: minutes(i < 3 ? 10 : i) }]));
    }
    const seen: string[] = [];
    let before: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page = await listChatSessions(me.id, { limit: 2, before });
      seen.push(...page!.sessions.map((s) => s.id));
      if (!page!.hasMore) break;
      before = page!.sessions.at(-1)!.id;
    }
    expect([...seen].sort()).toEqual([...ids].sort());
    expect(new Set(seen).size).toBe(5);
  });

  it("someone else's cursor is null", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const theirs = await chat(other.id, [{ role: "user", content: "x", at: T0 }]);
    expect(await listChatSessions(me.id, { limit: 5, before: theirs })).toBeNull();
  });
});

describe("claim, rename, touch, legacy rule", () => {
  it("claims once for the owner and never for anyone else", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const id = "66666666-6666-4666-8666-666666666666";
    expect(await claimChatSession(me.id, id)).toBe(true);
    expect(await claimChatSession(me.id, id)).toBe(true);
    expect(await claimChatSession(other.id, id)).toBe(false);
    expect(await db.chatSession.count({ where: { id } })).toBe(1);
  });

  it("a rename freezes the title and is invisible to anyone else", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const id = await chat(me.id, [{ role: "user", content: "x", at: T0 }]);
    expect(await renameChatSession(other.id, id, "Чужое")).toBeNull();
    const renamed = await renameChatSession(me.id, id, "Про Аню");
    expect(renamed).toMatchObject({ id, title: "Про Аню", messageCount: 1 });
    expect(await db.chatSession.findUnique({ where: { id } })).toMatchObject({ titleByUser: true });
    expect(await getChatSession(other.id, id)).toBeNull();
  });

  it("touch only moves forward; the legacy rule reads it", async () => {
    const me = await seedUser();
    const id = await chat(me.id, [{ role: "user", content: "x", at: minutes(0) }]);
    await touchChatSession(id, minutes(30));
    await touchChatSession(id, minutes(5));
    expect((await db.chatSession.findUnique({ where: { id } }))!.updatedAt).toEqual(minutes(30));

    expect(await continueOrOpenChatSession(me.id, minutes(30 + 359))).toBe(id);
    const fresh = await continueOrOpenChatSession(me.id, minutes(30 + 360));
    expect(fresh).not.toBe(id);
    expect(await db.chatSession.count({ where: { userId: me.id } })).toBe(2);
  });

  it("deleting the account takes the chats and their messages with it", async () => {
    const me = await seedUser();
    await chat(me.id, [{ role: "user", content: "x", at: T0 }]);
    await db.user.delete({ where: { id: me.id } });
    expect(await db.chatSession.count()).toBe(0);
    expect(await db.message.count()).toBe(0);
  });
});

describe("digest pick", () => {
  it("picks quiet chats that owe a summary, in UTC regardless of the server zone", async () => {
    const me = await seedUser();
    const now = new Date();
    const quiet = await chat(me.id, [
      { role: "user", content: "a", at: new Date(now.getTime() - 3 * 3_600_000) },
      { role: "assistant", content: "b", at: new Date(now.getTime() - 2 * 3_600_000) },
    ]);
    await chat(me.id, [
      { role: "user", content: "live", at: new Date(now.getTime() - 5 * 60_000) },
      { role: "assistant", content: "still", at: new Date(now.getTime() - 4 * 60_000) },
    ]);
    await chat(me.id, [{ role: "user", content: "one line", at: new Date(now.getTime() - 3 * 3_600_000) }]);

    const transcripts: string[] = [];
    const result = await sweepChatSessionDigests({
      now: () => now,
      embed: async () => axis(0),
      callJson: async <T,>(_system: string, transcript: string) => {
        transcripts.push(transcript);
        return null as T | null;
      },
    });
    // The digest itself failed (null model answer) — what matters is WHICH chat it tried:
    // not the live one (4 minutes quiet), not the one-line one (nothing to summarize).
    expect(result).toEqual({ scanned: 1, summarized: 0, failed: 1 });
    expect(transcripts).toEqual(["Person: a\nGennety: b"]);
    expect(await db.chatSession.findUnique({ where: { id: quiet } })).toMatchObject({
      summary: null,
      summarizedAtCount: 0,
    });
  });
});

describe("past-chat tools", () => {
  it("keyword fallback over unsummarized chats: own chats only, never the current one", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const current = await chat(me.id, [{ role: "user", content: "где мы говорили про Аню?", at: minutes(100) }]);
    const past = await chat(me.id, [
      { role: "user", content: "Аня предложила Kyivska Rooftop", at: minutes(0) },
      { role: "assistant", content: "Отличное место", at: minutes(1) },
    ]);
    await chat(other.id, [{ role: "user", content: "Аня тоже тут", at: minutes(0) }]);
    await chat(me.id, [{ role: "user", content: "100% не про неё", at: minutes(50) }]);

    const out = JSON.parse(
      await searchPastChats(me.id, current, { query: "rooftop with Anna", keywords: ["Аня", "100%"] }, {
        embed: async () => {
          throw new Error("no embeddings in this test");
        },
      }),
    );

    const ids = out.hits.map((h: { chatId: string }) => h.chatId);
    expect(ids).toContain(past);
    expect(ids).not.toContain(current);
    expect(out.hits.find((h: { chatId: string }) => h.chatId === past)).toMatchObject({
      summary: null,
      opening: ["person: Аня предложила Kyivska Rooftop", "you: Отличное место"],
    });
  });

  it("read_past_chat reads its own chat and nothing of anyone else's", async () => {
    const me = await seedUser();
    const other = await seedUser();
    const mine = await chat(me.id, [
      { role: "user", content: "вот фото", at: minutes(0), imageUrls: ["a/1.jpg", "a/2.jpg"] },
      { role: "system", content: "sys", at: minutes(0.5) },
      { role: "assistant", content: "Красиво", at: minutes(1) },
    ]);
    const theirs = await chat(other.id, [{ role: "user", content: "secret", at: minutes(0) }]);

    const read = JSON.parse(await readPastChat(me.id, "77777777-7777-4777-8777-777777777777", { chatId: mine }));
    expect(read.messageCount).toBe(2);
    expect(read.transcript).toEqual([
      "Sun 2026-09-20 13:00 person: вот фото [2 photos]",
      "Sun 2026-09-20 13:01 you: Красиво",
    ]);
    const foreign = JSON.parse(await readPastChat(me.id, mine, { chatId: theirs }));
    expect(foreign).toEqual({ success: false, error: "unknown_chat" });
  });

  it("datesAround finds the date scheduled near the chat and resolves the side", async () => {
    const me = await seedUser({ firstName: "Me" });
    const anna = await seedUser({ firstName: "Anna", gender: "female" });
    await db.match.create({
      data: {
        userAId: anna.id,
        userBId: me.id,
        status: "scheduled",
        agreedTime: minutes(60 * 24 * 3),
        venueName: "Kyiv Rooftop",
        acceptedByA: true,
        acceptedByB: true,
        feedbackByA: "PARTNER ONLY",
      },
    });
    await db.match.create({
      data: {
        userAId: me.id,
        userBId: anna.id,
        status: "completed",
        agreedTime: minutes(-60 * 24 * 40),
        createdAt: minutes(-60 * 24 * 45),
      },
    });

    // A match still in planning during the chat — no time yet — counts too.
    const oksana = await seedUser({ firstName: "Oksana", gender: "female" });
    await db.match.create({
      data: { userAId: me.id, userBId: oksana.id, status: "proposed", createdAt: minutes(-60) },
    });

    // The date forty days back is out, however recently its row was written.
    const dates = await datesAround(me.id, T0, minutes(60));
    expect(dates).toHaveLength(2);
    expect(dates.find((d) => d.partner === "Anna")).toMatchObject({
      status: "scheduled",
      venue: "Kyiv Rooftop",
      yourDecision: "accepted",
    });
    expect(dates.find((d) => d.partner === "Oksana")).toMatchObject({
      status: "proposed",
      at: null,
      yourDecision: null,
    });
    expect(JSON.stringify(dates)).not.toContain("PARTNER ONLY");
  });

  it.skipIf(!hasVector)("vector search orders by meaning and skips the current chat", async () => {
    const me = await seedUser();
    const current = await chat(me.id, [{ role: "user", content: "now", at: minutes(100) }]);
    const dress = await chat(me.id, [{ role: "user", content: "x", at: minutes(0) }]);
    const venue = await chat(me.id, [{ role: "user", content: "y", at: minutes(10) }]);
    await setEmbedding(dress, axis(1), "Dress code for the date.");
    await setEmbedding(venue, axis(2), "Venue change to a rooftop.");
    await setEmbedding(current, axis(2), "The current chat.");

    const out = JSON.parse(
      await searchPastChats(me.id, current, { query: "rooftop venue" }, { embed: async () => axis(2) }),
    );
    expect(out.hits.map((h: { chatId: string }) => h.chatId)).toEqual([venue, dress]);
  });

  it.skipIf(!hasVector)("the summary UPDATE is guarded: a rename mid-call keeps the person's title", async () => {
    const me = await seedUser();
    const id = await chat(me.id, [
      { role: "user", content: "что надеть?", at: minutes(0) },
      { role: "assistant", content: "Смарт-кэжуал", at: minutes(1) },
    ]);
    const answer = { title: "Дресс-код", summary: "The person asked what to wear." };
    const outcome = await summarizeChatSession(id, {
      embed: async () => axis(3),
      callJson: async <T,>() => {
        // The person renames while the model is writing.
        await db.chatSession.update({ where: { id }, data: { title: "Моё", titleByUser: true } });
        return answer as T;
      },
    });
    expect(outcome).toBe("summarized");
    const row = await db.chatSession.findUnique({ where: { id } });
    expect(row).toMatchObject({ title: "Моё", titleByUser: true, summary: answer.summary, summarizedAtCount: 2 });
  });
});
