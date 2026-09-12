import { prisma } from "@gennety/db";
import {
  ANNOUNCEMENT_MEDIA,
  INBOX_PAGE_DEFAULT,
  INBOX_PAGE_MAX,
  INBOX_PUSH_TYPES,
  INBOX_READ_BATCH_MAX,
} from "@gennety/shared";
import { createAnnouncementAssetSignedUrl } from "./storage.js";

/**
 * The in-app inbox behind the iOS bell (decision journal 2026-09-13).
 *
 * One row per person per thing that arrived for them. Two writers — the
 * announcement fan-out (`services/announcements.ts`) and the push dispatcher
 * for the allowlisted transactional types (`INBOX_PUSH_TYPES`) — and one
 * reader, the `/v1/inbox` routes.
 *
 * The unread count is `readAt IS NULL` and nothing else. It is what the bell's
 * dot means, so it may not count a row the list would not show.
 */

export interface InboxItemDto {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: string;
  readAt: string | null;
  matchId: string | null;
  announcementId: string | null;
}

export interface InboxEventDto {
  id: string;
  title: string;
  status: string;
  venueName: string;
  venueAddress: string;
  startsAt: string;
  endsAt: string;
  timeZone: string;
}

export interface InboxMediaDto {
  kind: "image" | "video";
  url: string;
  posterUrl?: string;
}

export interface InboxAnnouncementDto {
  body: string;
  suggestedQuestions: string[];
  media?: InboxMediaDto;
  event?: InboxEventDto;
}

export interface InboxItemDetailDto {
  item: InboxItemDto;
  announcement?: InboxAnnouncementDto;
}

type InboxRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  createdAt: Date;
  readAt: Date | null;
  matchId: string | null;
  announcementId: string | null;
};

export function serializeInboxItem(row: InboxRow): InboxItemDto {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    matchId: row.matchId,
    announcementId: row.announcementId,
  };
}

/** Whether a push of this type also belongs in the inbox (decision F5). */
export function isInboxPushType(type: unknown): type is string {
  return typeof type === "string" && INBOX_PUSH_TYPES.has(type);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Write the inbox row for one transactional push. Returns the row id, which
 * rides the push as `inboxItemId` so a tap can mark exactly that row read.
 *
 * `pushedAt` is stamped at write: the push rail owns delivery for these rows,
 * and the column only exists so the announcement fan-out can resume.
 */
export async function recordTransactionalInboxItem(input: {
  userId: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown> | undefined;
}): Promise<string> {
  const rawMatchId = input.data?.matchId;
  const matchId = typeof rawMatchId === "string" && UUID_RE.test(rawMatchId) ? rawMatchId : null;
  const row = await prisma.inboxItem.create({
    data: {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      matchId,
      pushedAt: new Date(),
    },
    select: { id: true },
  });
  return row.id;
}

export function inboxUnreadCount(userId: string): Promise<number> {
  return prisma.inboxItem.count({ where: { userId, readAt: null } });
}

export type InboxPageResult =
  | { ok: true; items: InboxItemDto[]; unreadCount: number; hasMore: boolean }
  | { ok: false; error: "unknown_cursor" };

/**
 * Newest first. `before` is a row id, not a timestamp, for the reason
 * `/v1/chat/history` gives: fan-out rows share a `createdAt` to the
 * millisecond, and a timestamp cursor would skip or repeat them.
 */
export async function listInbox(
  userId: string,
  options: { limit?: number; before?: string | null } = {},
): Promise<InboxPageResult> {
  const limit = clampLimit(options.limit);
  const before = options.before ?? null;
  if (before) {
    if (!UUID_RE.test(before)) return { ok: false, error: "unknown_cursor" };
    const owner = await prisma.inboxItem.findUnique({
      where: { id: before },
      select: { userId: true },
    });
    if (!owner || owner.userId !== userId) return { ok: false, error: "unknown_cursor" };
  }

  const [rows, unreadCount] = await Promise.all([
    prisma.inboxItem.findMany({
      where: { userId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit + 1,
      ...(before ? { cursor: { id: before }, skip: 1 } : {}),
      select: INBOX_SELECT,
    }),
    inboxUnreadCount(userId),
  ]);
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  return { ok: true, items: page.map(serializeInboxItem), unreadCount, hasMore };
}

function clampLimit(raw: number | undefined): number {
  if (raw === undefined || !Number.isFinite(raw)) return INBOX_PAGE_DEFAULT;
  return Math.min(Math.max(Math.trunc(raw), 1), INBOX_PAGE_MAX);
}

const INBOX_SELECT = {
  id: true,
  type: true,
  title: true,
  body: true,
  createdAt: true,
  readAt: true,
  matchId: true,
  announcementId: true,
} as const;

export type MarkReadResult =
  | { ok: true; unreadCount: number }
  | { ok: false; error: "invalid_ids" };

/**
 * Mark rows read. Idempotent, and scoped to the caller in the WHERE clause
 * itself: another person's id is not an error, it simply matches nothing — a
 * 404 per foreign id would tell a prober which ids exist.
 */
export async function markInboxRead(userId: string, ids: unknown): Promise<MarkReadResult> {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > INBOX_READ_BATCH_MAX) {
    return { ok: false, error: "invalid_ids" };
  }
  if (!ids.every((id): id is string => typeof id === "string" && UUID_RE.test(id))) {
    return { ok: false, error: "invalid_ids" };
  }
  await prisma.inboxItem.updateMany({
    where: { userId, id: { in: ids }, readAt: null },
    data: { readAt: new Date() },
  });
  return { ok: true, unreadCount: await inboxUnreadCount(userId) };
}

/**
 * One row with everything the detail sheet draws. Media URLs are signed for a
 * day; a signing failure drops the media rather than the sheet — the words are
 * the announcement, the picture is its dressing.
 */
export async function getInboxItemDetail(
  userId: string,
  id: string,
): Promise<InboxItemDetailDto | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await prisma.inboxItem.findFirst({
    where: { id, userId },
    select: {
      ...INBOX_SELECT,
      announcement: {
        select: {
          body: true,
          suggestedQuestions: true,
          mediaKind: true,
          mediaPath: true,
          posterPath: true,
          event: {
            select: {
              id: true,
              title: true,
              status: true,
              venueName: true,
              venueAddress: true,
              startsAt: true,
              endsAt: true,
              timeZone: true,
            },
          },
        },
      },
    },
  });
  if (!row) return null;

  const item = serializeInboxItem(row);
  const announcement = row.announcement;
  if (!announcement) return { item };

  const dto: InboxAnnouncementDto = {
    body: announcement.body,
    suggestedQuestions: announcement.suggestedQuestions,
  };
  const media = await signMedia(announcement);
  if (media) dto.media = media;
  if (announcement.event) {
    const e = announcement.event;
    dto.event = {
      id: e.id,
      title: e.title,
      status: e.status,
      venueName: e.venueName,
      venueAddress: e.venueAddress,
      startsAt: e.startsAt.toISOString(),
      endsAt: e.endsAt.toISOString(),
      timeZone: e.timeZone,
    };
  }
  return { item, announcement: dto };
}

async function signMedia(a: {
  mediaKind: string | null;
  mediaPath: string | null;
  posterPath: string | null;
}): Promise<InboxMediaDto | null> {
  if ((a.mediaKind !== "image" && a.mediaKind !== "video") || !a.mediaPath) return null;
  const ttl = ANNOUNCEMENT_MEDIA.signedUrlTtlSeconds;
  const [url, posterUrl] = await Promise.all([
    createAnnouncementAssetSignedUrl(a.mediaPath, ttl),
    a.posterPath ? createAnnouncementAssetSignedUrl(a.posterPath, ttl) : Promise.resolve(null),
  ]);
  if (!url) return null;
  // A video without its poster is refused at write time; if the poster's
  // signature alone failed, the video still plays — it just starts on black.
  return { kind: a.mediaKind, url, ...(posterUrl ? { posterUrl } : {}) };
}
