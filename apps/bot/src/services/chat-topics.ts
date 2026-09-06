import { prisma } from "@gennety/db";

/**
 * Chat topics — a read-only index over the ONE continuous conversation that
 * `chat-agent.ts` holds with a user.
 *
 * This is deliberately not threading. There is no `threadId` column, no
 * per-thread context, no forking: `buildChatMessages` still feeds the model
 * the last N rows of the user's single `Message` stream, and always will.
 * A "topic" here is nothing but a slice of that stream cut at a long silence,
 * so the mobile app can offer a list of past conversations that jumps the
 * transcript to a point in time — the same room, scrolled back.
 *
 * Segmenting by silence rather than by meaning is a choice, not a shortcut:
 * a model-written title would cost a call per topic, drift between renders,
 * and need a cache column to stop drifting. The first thing the user said
 * after a silence is a title they wrote themselves, and it never changes.
 */

/** A gap longer than this starts a new topic. */
export const TOPIC_GAP_MS = 6 * 60 * 60 * 1000;

/** Ceiling on how far back the index looks. Beyond it, older topics are dropped. */
export const TOPIC_SCAN_LIMIT = 2_000;

export const TOPIC_TITLE_MAX = 64;
export const TOPIC_SNIPPET_MAX = 120;

export interface TopicSourceMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date;
}

export interface ChatTopic {
  /**
   * First message of the topic. The mobile client pages history back until
   * this id is loaded, then scrolls to it — hence "anchor" rather than "id":
   * the topic itself has no row of its own anywhere.
   */
  anchorId: string;
  title: string;
  snippet: string;
  startedAt: string;
  updatedAt: string;
  messageCount: number;
  /**
   * How many messages lie between the anchor and the newest message,
   * inclusive of both. The client turns this into an exact number of
   * `/history?before=` pages instead of guessing and re-requesting.
   */
  depth: number;
}

/** Collapse whitespace and cut on a whole word where one is near the limit. */
function condense(raw: string, max: number): string {
  const flat = raw.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  // Only honour the word boundary if it isn't throwing away most of the line.
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}

/**
 * Cut an oldest-first run of messages into topics, newest topic first.
 *
 * `system` rows are dropped before segmenting: the mobile transcript never
 * renders them (`ChatModel.entry(from:)` on the client), so a topic anchored
 * on one would scroll to a message that does not exist on screen.
 */
export function segmentTopics(messages: TopicSourceMessage[]): ChatTopic[] {
  const rows = messages.filter((m) => m.role !== "system");
  if (rows.length === 0) return [];

  const groups: TopicSourceMessage[][] = [];
  let current: TopicSourceMessage[] = [];
  let previousAt: number | null = null;

  for (const row of rows) {
    const at = row.createdAt.getTime();
    if (previousAt !== null && at - previousAt > TOPIC_GAP_MS) {
      groups.push(current);
      current = [];
    }
    current.push(row);
    previousAt = at;
  }
  if (current.length > 0) groups.push(current);

  const total = rows.length;
  let consumed = 0;
  const topics: ChatTopic[] = [];

  for (const group of groups) {
    const first = group[0]!;
    const last = group[group.length - 1]!;
    // The user's own opening line names the topic; an assistant-only stretch
    // (a nudge that went unanswered) falls back to what the assistant said.
    const titleSource = group.find((m) => m.role === "user") ?? first;
    topics.push({
      anchorId: first.id,
      title: condense(titleSource.content, TOPIC_TITLE_MAX),
      snippet: condense(last.content, TOPIC_SNIPPET_MAX),
      startedAt: first.createdAt.toISOString(),
      updatedAt: last.createdAt.toISOString(),
      messageCount: group.length,
      depth: total - consumed,
    });
    consumed += group.length;
  }

  return topics.reverse();
}

export interface ListChatTopicsResult {
  topics: ChatTopic[];
  /** Older topics exist beyond `TOPIC_SCAN_LIMIT` and are not listed. */
  hasMore: boolean;
}

export async function listChatTopics(
  userId: string,
  limit: number,
): Promise<ListChatTopicsResult> {
  // One row over the scan ceiling: the extra row is what tells us the index
  // is truncated, without a second COUNT over the whole table.
  const rows = await prisma.message.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: TOPIC_SCAN_LIMIT + 1,
    select: { id: true, role: true, content: true, createdAt: true },
  });
  const truncated = rows.length > TOPIC_SCAN_LIMIT;
  const scanned = truncated ? rows.slice(0, TOPIC_SCAN_LIMIT) : rows;
  scanned.reverse();

  const all = segmentTopics(scanned as TopicSourceMessage[]);
  return {
    topics: all.slice(0, limit),
    hasMore: truncated || all.length > limit,
  };
}
