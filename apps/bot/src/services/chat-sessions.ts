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
 */
export async function claimChatSession(userId: string, sessionId: string): Promise<boolean> {
  await prisma.chatSession.createMany({
    data: [{ id: sessionId, userId }],
    skipDuplicates: true,
  });
  const row = await prisma.chatSession.findUnique({
    where: { id: sessionId },
    select: { userId: true },
  });
  return row?.userId === userId;
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
 * while it is under six hours quiet, a new one otherwise.
 *
 * Runs inside the per-user turn lock (`runChatTurn`), so two concurrent legacy
 * turns of one person cannot both decide to open a chat.
 */
export async function continueOrOpenChatSession(
  userId: string,
  now: Date = new Date(),
): Promise<string> {
  const latest = await prisma.chatSession.findFirst({
    where: { userId },
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
}

/**
 * The one SELECT behind the list, the rename answer and the pulse rows: the
 * chat, its non-system message count, and — only for an untitled chat — the
 * line its fallback title is cut from (the person's first non-empty line, else
 * the assistant's).
 */
async function selectSessions(
  where: Prisma.Sql,
  opts: { withMessagesOnly: boolean; limit: number },
): Promise<SessionRow[]> {
  return prisma.$queryRaw<SessionRow[]>`
    SELECT s.id, s.title, s.created_at, s.updated_at, c.n AS message_count, o.content AS opener
    FROM chat_sessions s
    CROSS JOIN LATERAL (
      SELECT count(*)::int AS n
      FROM messages m
      WHERE m.session_id = s.id AND m.role <> 'system'
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

export function toChatSessionDto(row: SessionRow): ChatSessionDto {
  return {
    id: row.id,
    title: row.title ?? condense(row.opener ?? "", CHAT_SESSION_FALLBACK_TITLE_MAX),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    messageCount: row.message_count,
  };
}

export interface ListChatSessionsResult {
  sessions: ChatSessionDto[];
  hasMore: boolean;
}

/**
 * The person's chats, most recently active first. Only chats with at least one
 * non-system message: an id the phone claimed for a turn that never produced a
 * message (a refused voice note) is not a chat anyone had.
 *
 * `before` is a chat id, exclusive, compared on `(updated_at, id)` so ties are
 * total. `null` = the cursor is unknown or not the caller's (404).
 */
export async function listChatSessions(
  userId: string,
  opts: { limit: number; before?: string | null },
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
  const rows = await selectSessions(Prisma.sql`s.user_id = ${userId}::uuid ${cursor}`, {
    withMessagesOnly: true,
    limit: opts.limit + 1,
  });
  const hasMore = rows.length > opts.limit;
  return {
    sessions: (hasMore ? rows.slice(0, opts.limit) : rows).map(toChatSessionDto),
    hasMore,
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
  return row ? toChatSessionDto(row) : null;
}

/**
 * Rename a chat by hand. From here on the titler leaves it alone
 * (`titleByUser`). `null` = unknown / foreign / malformed id (404); the title
 * must already be normalized (`normalizeChatSessionTitle`).
 */
export async function renameChatSession(
  userId: string,
  sessionId: string,
  title: string,
): Promise<ChatSessionDto | null> {
  if (!isUuid(sessionId)) return null;
  const updated = await prisma.chatSession.updateMany({
    where: { id: sessionId, userId },
    data: { title, titleByUser: true },
  });
  if (updated.count === 0) return null;
  return getChatSession(userId, sessionId);
}
