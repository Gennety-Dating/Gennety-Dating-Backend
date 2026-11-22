import { prisma, Prisma } from "@gennety/db";
import {
  CHAT_SESSION_FALLBACK_TITLE_MAX,
  CHAT_SESSION_LEGACY_GAP_MS,
  CHAT_SESSION_TITLE_MAX,
} from "@gennety/shared";
import { isUuid } from "../utils/uuid.js";
import { condense } from "./chat-topics.js";

/**
 * Chat sessions — the app's agent chat as separate ChatGPT-style chats
 * (founder decision 2026-09-30, reversing the one-thread decision of
 * 2026-09-04 recorded in `chat-topics.ts`).
 *
 * A chat is a `chat_sessions` row plus the `messages` rows pointing at it. The
 * agent's context inside a chat is that chat alone (`chat-agent.ts`); older
 * chats reach it through `chat-past-tools.ts`. Titles and summaries are
 * `chat-session-digest.ts`.
 *
 * Which chat a turn lands in:
 *  - the client names it (`sessionId`, minted on the phone for a new chat) —
 *    the first turn with an unseen id creates the row for the caller, so a
 *    retried first message cannot open two chats; someone else's id is a 404;
 *  - nobody names it (older builds, the Telegram photo flow) — the most recent
 *    chat continues while its newest message is under six hours old, otherwise
 *    a new one opens. The same six hours the old topic index and the
 *    migration's backfill cut the stream at.
 */

export interface ChatSessionDto {
  id: string;
  /**
   * The model-written or hand-set title; until the first one lands, the
   * person's opening line, condensed (an assistant-only chat falls back to the
   * assistant's first line, as the old topic index did).
   */
  title: string;
  createdAt: string;
  /** The newest message's time. */
  updatedAt: string;
  /** Non-system messages. */
  messageCount: number;
  /** When the person archived it; `null` for a chat in the history list. */
  archivedAt: string | null;
  /** Memory notes last written from this chat — what a deletion may also forget. */
  memoryNotes: number;
}

/**
 * The optional `sessionId` of a turn: absent (`undefined`/`null`), a UUID
 * (lower-cased — the form Postgres hands back, so the echo in the response and
 * the list agree), or `"invalid"` for anything else, which is a 400.
 */
export function parseChatSessionIdField(raw: unknown): string | null | "invalid" {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const trimmed = raw.trim();
  return isUuid(trimmed) ? trimmed.toLowerCase() : "invalid";
}

/**
 * Make sure the chat exists and is the caller's. An unseen id is created for
 * the caller (`ON CONFLICT DO NOTHING` — two concurrent first messages with the
 * same id create one row, not two and not an error); an id that belongs to
 * someone else answers `false` and changes nothing.
 *
 * Writing into an archived chat brings it back (decision 2026-11-22): the
 * person is talking in it again, so it belongs in the history list.
 */
export async function claimChatSession(userId: string, sessionId: string): Promise<boolean> {
  await prisma.chatSession.createMany({
    data: [{ id: sessionId, userId }],
    skipDuplicates: true,
  });
  const row = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { userId: true, archivedAt: true },
  });
  if (row?.userId !== userId) return false;
  if (row.archivedAt) {
    await prisma.chatSession.updateMany({ where: { id: sessionId, userId }, data: { archivedAt: null } });
  }
  return true;
}

/** Is this an existing chat of the caller's? A non-UUID is simply "no". */
export async function ownsChatSession(userId: string, sessionId: string): Promise<boolean> {
  if (!isUuid(sessionId)) return false;
  const row = await prisma.chatSession.findFirst({
    where: { id: sessionId, userId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * The chat a turn with no `sessionId` lands in: the most recently active one
 * while it is under six hours quiet, a new one otherwise. An archived chat is
 * never continued by accident.
 *
 * Runs inside the per-user turn lock (`runChatTurn`), so two concurrent legacy
 * turns of one person cannot both decide to open a chat.
 */
export async function continueOrOpenChatSession(
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const latest = await prisma.chatSession.findFirst({
    where: { userId, archivedAt: null },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    select: { id: true, updatedAt: true },
  });
  if (latest && now.getTime() - latest.updatedAt.getTime() < CHAT_SESSION_LEGACY_GAP_MS) {
    return latest.id;
  }
  const created = await prisma.chatSession.create({
    data: { userId, createdAt: now, updatedAt: now },
    select: { id: true },
  });
  return created.id;
}

/**
 * Move the chat's `updatedAt` to the newest message's time. Never backwards: a
 * slow turn finishing after a faster one must not un-bump the list order.
 */
export async function touchChatSession(sessionId: string, at: Date): Promise<void> {
  await prisma.chatSession.updateMany({
    where: { id: sessionId, updatedAt: { lt: at } },
    data: { updatedAt: at },
  });
}

/**
 * A title typed by the person: whitespace (newlines included) collapsed and
 * trimmed, then 1..`CHAT_SESSION_TITLE_MAX` characters. `null` means 400.
 */
export function normalizeChatSessionTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/\s+/g, " ").trim();
  if (title.length === 0 || [...title].length > CHAT_SESSION_TITLE_MAX) return null;
  return title;
}

interface SessionRow {
  id: string;
  title: string | null;
  created_at: Date;
  updated_at: Date;
  message_count: number;
  opener: string | null;
  archived_at: Date | null;
}

/**
 * The one SELECT behind the list, the rename answer and the pulse rows: the
 * chat, its non-system message count, and — only for an untitled chat — the
 * line its fallback title is cut from (the person's first non-empty line, else
 * the assistant's).
 *
 * `countUpTo: 1` caps the count at one message (an EXISTS in count's clothes)
 * for a caller that shows no count and only needs "has a real message": the
 * pulse rows. Every row, its order and its title stay what the full count
 * gives; only `message_count` reads 0/1, which is why such rows never become a
 * `ChatSessionDto`.
 */
async function selectSessions(
  where: Prisma.Sql,
  opts: { withMessagesOnly: boolean; limit: number; countUpTo?: 1 },
): Promise<SessionRow[]> {
  const counted =
    opts.countUpTo === 1
      ? Prisma.sql`(
          SELECT 1 FROM messages m
          WHERE m.session_id = s.id AND m.role <> 'system'
          LIMIT 1
        ) AS first_message`
      : Prisma.sql`messages m
      WHERE m.session_id = s.id AND m.role <> 'system'`;
  return prisma.$queryRaw<SessionRow[]>`
    SELECT s.id, s.title, s.created_at, s.updated_at, c.n AS message_count, o.content AS opener,
      s.archived_at
    FROM chat_sessions s
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM ${counted}
    ) c
    LEFT JOIN LATERAL (
      SELECT m.content
      FROM messages m
      WHERE m.session_id = s.id AND m.role <> 'system' AND btrim(m.content) <> ''
      ORDER BY (m.role <> 'user'), m.created_at, m.id
      LIMIT 1
    ) o ON s.title IS NULL
    WHERE ${where} ${opts.withMessagesOnly ? Prisma.sql`AND c.n > 0` : Prisma.empty}
    ORDER BY s.updated_at DESC, s.id DESC
    LIMIT ${opts.limit}
  `;
}

/** The shown title: the stored one, else the opening line condensed. */
function sessionTitle(row: Pick<SessionRow, "title" | "opener">): string {
  return row.title ?? condense(row.opener ?? "", CHAT_SESSION_FALLBACK_TITLE_MAX);
}

export function toChatSessionDto(row: SessionRow, memoryNotes = 0): ChatSessionDto {
  return {
    id: row.id,
    title: sessionTitle(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: row.message_count,
    archivedAt: row.archived_at?.toISOString() ?? null,
    memoryNotes,
  };
}

/** What a Today pulse row shows of a chat. */
export interface RecentChatSessionDto {
  id: string;
  title: string;
  /** The newest message's time. */
  updatedAt: string;
}

/**
 * The person's most recent chats for the Today pulse rows (polled with every
 * Today refresh): the same chats, in the same order, with the same titles as
 * the first page of `listChatSessions` — without the per-chat message count
 * the pulse never shows, which made Postgres count every message of every chat
 * the person ever had on each poll. Here a chat stops being counted at its
 * first real message (`countUpTo: 1`).
 */
export async function listRecentChatSessions(
  userId: string,
  limit: number,
): Promise<RecentChatSessionDto[]> {
  const rows = await selectSessions(Prisma.sql`s.user_id = ${userId}::uuid AND s.archived_at IS NULL`, {
    withMessagesOnly: true,
    limit,
    countUpTo: 1,
  });
  return rows.map((row) => ({
    id: row.id,
    title: sessionTitle(row),
    updatedAt: row.updated_at.toISOString(),
  }));
}

export interface ListChatSessionsResult {
  sessions: ChatSessionDto[];
  hasMore: boolean;
  /** Chats in the archive, whichever list was asked for. */
  archivedCount: number;
}

/**
 * How many memory notes were last written from each chat. A read that fails
 * (memory not migrated yet) costs the number, never the list.
 */
async function memoryNotesOf(userId: string, sessionIds: string[]): Promise<Map<string, number>> {
  if (sessionIds.length === 0) return new Map();
  try {
    const rows = await prisma.agentMemory.groupBy({
      by: ["sourceSessionId"],
      where: { userId, sourceSessionId: { in: sessionIds } },
      _count: { _all: true },
    });
    return new Map(rows.flatMap((row) => (row.sourceSessionId ? [[row.sourceSessionId, row._count._all] as const] : [])));
  } catch (err) {
    console.warn("[chat] memory note count failed:", err);
    return new Map();
  }
}

/**
 * The person's chats, most recently active first. Only chats with at least one
 * non-system message: an id the phone claimed for a turn that never produced a
 * message (a refused voice note) is not a chat anyone had.
 *
 * `archived` picks the archive instead of the history; one chat is in exactly
 * one of them.
 *
 * `before` is a chat id, exclusive, compared on `(updated_at, id)` so ties are
 * total. `null` = the cursor is unknown or not the caller's (404).
 */
export async function listChatSessions(
  userId: string,
  opts: { limit: number; before?: string | null; archived?: boolean },
): Promise<ListChatSessionsResult | null> {
  if (opts.before && !(await ownsChatSession(userId, opts.before))) return null;
  // The cursor is compared inside SQL, against its own row — no timestamp ever
  // round-trips through JavaScript (a `timestamp(3)` column and a JS Date
  // disagree about zones the moment a session's TimeZone is not UTC).
  const cursor = opts.before
    ? Prisma.sql`AND (s.updated_at, s.id) < (
        SELECT cur.updated_at, cur.id FROM chat_sessions cur WHERE cur.id = ${opts.before}::uuid
      )`
    : Prisma.empty;
  const shelf = opts.archived ? Prisma.sql`AND s.archived_at IS NOT NULL` : Prisma.sql`AND s.archived_at IS NULL`;
  const [rows, archivedCount] = await Promise.all([
    selectSessions(Prisma.sql`s.user_id = ${userId}::uuid ${shelf} ${cursor}`, {
      withMessagesOnly: true,
      limit: opts.limit + 1,
    }),
    prisma.chatSession.count({
      where: { userId, archivedAt: { not: null }, messages: { some: { role: { not: "system" } } } },
    }),
  ]);
  const hasMore = rows.length > opts.limit;
  const page = hasMore ? rows.slice(0, opts.limit) : rows;
  const notes = await memoryNotesOf(userId, page.map((row) => row.id));
  return {
    sessions: page.map((row) => toChatSessionDto(row, notes.get(row.id) ?? 0)),
    hasMore,
    archivedCount,
  };
}

/** One chat of the caller's, or `null` for an unknown / foreign / malformed id. */
export async function getChatSession(
  userId: string,
  sessionId: string,
): Promise<ChatSessionDto | null> {
  if (!isUuid(sessionId)) return null;
  const [row] = await selectSessions(
    Prisma.sql`s.id = ${sessionId}::uuid AND s.user_id = ${userId}::uuid`,
    { withMessagesOnly: false, limit: 1 },
  );
  if (!row) return null;
  const notes = await memoryNotesOf(userId, [row.id]);
  return toChatSessionDto(row, notes.get(row.id) ?? 0);
}

/**
 * Change a chat: a title typed by the person (`titleByUser` — the titler leaves
 * it alone from here on), the archive, or both. `null` = unknown / foreign /
 * malformed id (404); the title must already be normalized
 * (`normalizeChatSessionTitle`). Neither moves `updatedAt`: a chat that comes
 * back from the archive returns to its own place in the list.
 */
export async function updateChatSession(
  userId: string,
  sessionId: string,
  change: { title?: string; archived?: boolean },
  now: Date = new Date(),
): Promise<ChatSessionDto | null> {
  if (!isUuid(sessionId)) return null;
  const updated = await prisma.chatSession.updateMany({
    where: { id: sessionId, userId },
    data: {
      ...(change.title === undefined ? {} : { title: change.title, titleByUser: true }),
      ...(change.archived === undefined ? {} : { archivedAt: change.archived ? now : null }),
    },
  });
  if (updated.count === 0) return null;
  return getChatSession(userId, sessionId);
}

/** «Вернуть все»: every archived chat goes back to the history list. */
export async function restoreArchivedChats(userId: string): Promise<number> {
  const { count } = await prisma.chatSession.updateMany({
    where: { userId, archivedAt: { not: null } },
    data: { archivedAt: null },
  });
  return count;
}
