import { prisma } from "@gennety/db";
import {
  ANNOUNCEMENT_PUSH_TYPE,
  PULSE_ANNOUNCEMENT_DAYS,
  PULSE_CHAT_TOPICS_MAX,
  PULSE_DATE_PAST_DAYS,
  PULSE_DROP_WINDOW_MINUTES,
  PULSE_ROWS_MAX,
  VENUE_SELECTION_MAX_ATTEMPTS,
  type PulseRowKind,
  type PulseRowState,
} from "@gennety/shared";
import { getPreviousBatchDate } from "./next-batch.js";
import { listChatTopics } from "./chat-topics.js";

/**
 * Live Pulse — the rows under the status panel on the iOS Today screen
 * (decision journal 2026-09-13).
 *
 * Built from server state and nothing else, the way `UiHint` is. Three row
 * states, and the first one is the whole reason this is a server endpoint
 * rather than a client animation:
 *
 *  - `processing` — a real job is running for this person right now, with a
 *    deadline it will settle by (`deadlineAt`). Only those three exist: the drop
 *    batch in its first minutes, a scheduled venue-selection retry, and nothing
 *    else. Decision F2: between drops nothing runs, so nothing may spin — the
 *    Telegram "calibrating pairs" shimmer is scripted and has no place here.
 *  - `active` — something the person holds: an unread announcement.
 *  - `past` — what already happened: a completed date, a read announcement, a
 *    recent conversation with the agent.
 *
 * Which rows a scene may show is the client's call (it knows the scene); the
 * server returns every candidate, capped.
 *
 * Privacy (F4) holds here too: no row counts or describes another person.
 */

export interface PulseTargetDto {
  /** today | map | inbox_item | chat | chat_topic — string on the wire. */
  kind: string;
  /** Inbox item id for `inbox_item`, topic anchor id for `chat_topic`. */
  id?: string;
}

export interface PulseRowDto {
  /** Stable across polls, so the client can animate only real changes. */
  id: string;
  kind: PulseRowKind;
  state: PulseRowState;
  /** Content the server owns (an announcement's title). Null when the client writes the copy from `kind`. */
  title: string | null;
  subtitle: string | null;
  /** Machine value the client's copy branches on. Null unless a kind defines one. */
  status: string | null;
  /** The instant the row is about (date time, arrival). */
  at: string | null;
  /** `processing` only: when the job settles at the latest. */
  deadlineAt: string | null;
  target: PulseTargetDto;
}

export interface PulseDeps {
  now?: Date;
  topics?: typeof listChatTopics;
}

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

export async function buildPulse(userId: string, deps: PulseDeps = {}): Promise<PulseRowDto[]> {
  const now = deps.now ?? new Date();
  const topics = deps.topics ?? listChatTopics;

  const [user, drop, venue, announcements, pastDate, chat] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, select: { status: true } }),
    dropBatchRow(userId, now),
    venueSearchRow(userId),
    announcementRows(userId, now),
    pastDateRow(userId, now),
    topics(userId, PULSE_CHAT_TOPICS_MAX).then((r) => r.topics).catch(() => []),
  ]);
  if (!user) return [];

  const rows: PulseRowDto[] = [];
  if (drop && user.status === "active") rows.push(drop);
  if (venue) rows.push(venue);
  rows.push(...announcements.active);
  if (pastDate) rows.push(pastDate);
  rows.push(...announcements.past);
  for (const topic of chat.slice(0, PULSE_CHAT_TOPICS_MAX)) {
    rows.push({
      id: `chat_topic:${topic.anchorId}`,
      kind: "chat_topic",
      state: "past",
      title: topic.title,
      subtitle: null,
      status: null,
      at: topic.updatedAt,
      deadlineAt: null,
      target: { kind: "chat_topic", id: topic.anchorId },
    });
  }
  return rows.slice(0, PULSE_ROWS_MAX);
}

/**
 * The drop batch runs at the cron instant and dispatches over the next minutes;
 * the person's outcome is a match or, ~15 minutes on, the no-match notice. The
 * row spins only inside that bounded window and only until the outcome exists.
 */
export async function dropBatchRow(userId: string, now: Date): Promise<PulseRowDto | null> {
  const batchAt = getPreviousBatchDate(now);
  const deadline = new Date(batchAt.getTime() + PULSE_DROP_WINDOW_MINUTES * MINUTE);
  if (now.getTime() >= deadline.getTime()) return null;

  const [match, notice] = await Promise.all([
    prisma.match.findFirst({
      where: { OR: [{ userAId: userId }, { userBId: userId }], createdAt: { gte: batchAt } },
      select: { id: true },
    }),
    prisma.noMatchNotice.findFirst({
      where: { userId, sentAt: { gte: batchAt } },
      select: { id: true },
    }),
  ]);
  if (match || notice) return null;
  return {
    id: `drop_batch:${batchAt.toISOString()}`,
    kind: "drop_batch",
    state: "processing",
    title: null,
    subtitle: null,
    status: null,
    at: batchAt.toISOString(),
    deadlineAt: deadline.toISOString(),
    target: { kind: "today" },
  };
}

/**
 * A venue selection that failed and is waiting on its durable retry
 * (`retryDueVenueSelections`: at most three attempts). The deadline is the
 * retry's own due time — the one moment something will certainly happen.
 */
export async function venueSearchRow(userId: string): Promise<PulseRowDto | null> {
  const match = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      status: "negotiating_venue",
      venueSelectionNextRetryAt: { not: null },
      venueSelectionAttempts: { lt: VENUE_SELECTION_MAX_ATTEMPTS },
    },
    select: { id: true, venueSelectionNextRetryAt: true },
  });
  if (!match?.venueSelectionNextRetryAt) return null;
  return {
    id: `venue_search:${match.id}`,
    kind: "venue_search",
    state: "processing",
    title: null,
    subtitle: null,
    status: null,
    at: null,
    deadlineAt: match.venueSelectionNextRetryAt.toISOString(),
    target: { kind: "map" },
  };
}

export async function announcementRows(
  userId: string,
  now: Date,
): Promise<{ active: PulseRowDto[]; past: PulseRowDto[] }> {
  const rows = await prisma.inboxItem.findMany({
    where: {
      userId,
      type: ANNOUNCEMENT_PUSH_TYPE,
      createdAt: { gte: new Date(now.getTime() - PULSE_ANNOUNCEMENT_DAYS * DAY) },
    },
    select: { id: true, title: true, body: true, createdAt: true, readAt: true },
    orderBy: { createdAt: "desc" },
    take: 3,
  });
  const toRow = (r: (typeof rows)[number]): PulseRowDto => ({
    id: `announcement:${r.id}`,
    kind: "announcement",
    state: r.readAt ? "past" : "active",
    title: r.title,
    subtitle: r.body,
    status: null,
    at: r.createdAt.toISOString(),
    deadlineAt: null,
    target: { kind: "inbox_item", id: r.id },
  });
  return {
    active: rows.filter((r) => !r.readAt).map(toRow),
    past: rows.filter((r) => r.readAt).slice(0, 1).map(toRow),
  };
}

/**
 * The most recent completed date, while it is still recent. Opens the inbox
 * row the product sent about that match when there is one, so the agent chat
 * can be grounded on it; the plain chat otherwise.
 */
export async function pastDateRow(userId: string, now: Date): Promise<PulseRowDto | null> {
  const match = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      status: "completed",
      agreedTime: { gte: new Date(now.getTime() - PULSE_DATE_PAST_DAYS * DAY), lte: now },
    },
    select: { id: true, agreedTime: true, venueName: true },
    orderBy: { agreedTime: "desc" },
  });
  if (!match?.agreedTime) return null;
  const item = await prisma.inboxItem.findFirst({
    where: { userId, matchId: match.id },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return {
    id: `date_past:${match.id}`,
    kind: "date_past",
    state: "past",
    title: match.venueName,
    subtitle: null,
    status: null,
    at: match.agreedTime.toISOString(),
    deadlineAt: null,
    target: item ? { kind: "inbox_item", id: item.id } : { kind: "chat" },
  };
}
