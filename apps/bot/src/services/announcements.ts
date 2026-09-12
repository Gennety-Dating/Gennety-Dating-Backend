import { prisma, type Language, type Prisma } from "@gennety/db";
import {
  ANNOUNCEMENT_INBOX_BATCH,
  ANNOUNCEMENT_LIMITS,
  ANNOUNCEMENT_MEDIA,
  ANNOUNCEMENT_PUSH_INTERVAL_MS,
  ANNOUNCEMENT_PUSH_TYPE,
} from "@gennety/shared";
import { isQuietHours } from "../workers/quiet-hours.js";
import { sendPushToUser } from "./push.js";
import { pushReachable } from "./telegram-reach.js";
import {
  createAnnouncementAssetSignedUrl,
  uploadAnnouncementAsset,
  type AnnouncementAssetRole,
} from "./storage.js";
import { sniffImageMime } from "../utils/image-sniff.js";
import { probeMp4 } from "../utils/mp4-probe.js";

/**
 * Admin announcements (decision journal 2026-09-13): the founder writes one in
 * the dashboard, previews it on their own phone, schedules it, and the
 * `announcement-fanout` worker lands it in every matching app user's inbox and
 * pushes it at ~10/s, holding the pushes — never the inbox rows — through
 * quiet hours.
 *
 * Lifecycle, every step a CAS on `status`:
 *
 *   draft ──schedule──▶ scheduled ──(worker claims)──▶ sending ──▶ sent
 *     ▲                    │
 *     └────unschedule──────┘            draft | sent ──archive──▶ archived
 *
 * Only a draft is editable. Once the worker has claimed a row, what people are
 * reading is what was scheduled; an edit after that would make two people's
 * inboxes disagree about the same announcement.
 */

const LOG = "[announcements]";

export interface AnnouncementAudience {
  cityKeys?: string[];
  languages?: string[];
}

const LANGUAGES = new Set(["en", "ru", "uk", "de", "pl"]);
const CITY_KEY_RE = /^[a-z0-9_-]{2,64}$/;

/** Statuses whose people get announcements: the ones who can open the app. */
const RECEIVING_STATUSES = ["active", "paused"] as const;

export function parseAnnouncementAudience(raw: unknown): AnnouncementAudience | null {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) return null;
  const { cityKeys, languages } = raw as Record<string, unknown>;
  const out: AnnouncementAudience = {};
  if (cityKeys !== undefined) {
    if (!Array.isArray(cityKeys) || cityKeys.length > 50) return null;
    if (!cityKeys.every((k): k is string => typeof k === "string" && CITY_KEY_RE.test(k))) return null;
    if (cityKeys.length > 0) out.cityKeys = [...new Set(cityKeys)];
  }
  if (languages !== undefined) {
    if (!Array.isArray(languages)) return null;
    if (!languages.every((l): l is string => typeof l === "string" && LANGUAGES.has(l))) return null;
    if (languages.length > 0) out.languages = [...new Set(languages)];
  }
  return out;
}

/**
 * Who an audience reaches: app users (`pushReachable`) in a receiving status,
 * narrowed by city and language when given. A person without a push token is
 * IN — the inbox is theirs whether or not the phone rings.
 */
export function audienceWhere(audience: AnnouncementAudience): Prisma.UserWhereInput {
  return {
    platform: { in: ["mobile", "both"] },
    status: { in: [...RECEIVING_STATUSES] },
    ...(audience.languages ? { language: { in: audience.languages as Language[] } } : {}),
    ...(audience.cityKeys ? { profile: { homeCityKey: { in: audience.cityKeys } } } : {}),
  };
}

export function countAudience(audience: AnnouncementAudience): Promise<number> {
  return prisma.user.count({ where: audienceWhere(audience) });
}

// ── Input validation ────────────────────────────────────────────────────────

export interface AnnouncementFields {
  title: string;
  teaser: string;
  body: string;
  agentBrief: string | null;
  suggestedQuestions: string[];
  eventId: string | null;
  audience: AnnouncementAudience;
  sendPush: boolean;
}

export type FieldsResult =
  | { ok: true; value: Partial<AnnouncementFields> }
  | { ok: false; error: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(raw: unknown, max: number, field: string, required: boolean): string | null | Error {
  if (raw === undefined) return required ? new Error(`${field}_required`) : null;
  if (typeof raw !== "string") return new Error(`${field}_invalid`);
  const value = raw.trim();
  if (required && !value) return new Error(`${field}_required`);
  if (value.length > max) return new Error(`${field}_too_long`);
  return value;
}

/**
 * Validate a create (`partial: false`) or a draft edit (`partial: true`).
 * Unknown keys are ignored; a present key that is wrong is an error naming it,
 * so the dashboard can put the message under the right field.
 */
export function parseAnnouncementFields(body: unknown, partial: boolean): FieldsResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, error: "body_invalid" };
  const b = body as Record<string, unknown>;
  const value: Partial<AnnouncementFields> = {};
  const L = ANNOUNCEMENT_LIMITS;

  for (const [field, max] of [
    ["title", L.title],
    ["teaser", L.teaser],
    ["body", L.body],
  ] as const) {
    const parsed = text(b[field], max, field, !partial);
    if (parsed instanceof Error) return { ok: false, error: parsed.message };
    if (parsed !== null) {
      if (!parsed) return { ok: false, error: `${field}_required` };
      value[field] = parsed;
    }
  }

  if (b.agentBrief !== undefined) {
    if (b.agentBrief === null) value.agentBrief = null;
    else {
      const parsed = text(b.agentBrief, L.agentBrief, "agentBrief", false);
      if (parsed instanceof Error) return { ok: false, error: parsed.message };
      value.agentBrief = parsed || null;
    }
  } else if (!partial) value.agentBrief = null;

  if (b.suggestedQuestions !== undefined) {
    const q = b.suggestedQuestions;
    if (!Array.isArray(q) || q.length > L.suggestedQuestions) {
      return { ok: false, error: "suggestedQuestions_invalid" };
    }
    const cleaned: string[] = [];
    for (const item of q) {
      if (typeof item !== "string") return { ok: false, error: "suggestedQuestions_invalid" };
      const trimmed = item.trim();
      if (trimmed.length > L.suggestedQuestion) return { ok: false, error: "suggestedQuestions_too_long" };
      if (trimmed) cleaned.push(trimmed);
    }
    value.suggestedQuestions = cleaned;
  } else if (!partial) value.suggestedQuestions = [];

  if (b.eventId !== undefined) {
    if (b.eventId === null) value.eventId = null;
    else if (typeof b.eventId === "string" && UUID_RE.test(b.eventId)) value.eventId = b.eventId;
    else return { ok: false, error: "eventId_invalid" };
  } else if (!partial) value.eventId = null;

  if (b.audience !== undefined || !partial) {
    const audience = parseAnnouncementAudience(b.audience);
    if (!audience) return { ok: false, error: "audience_invalid" };
    value.audience = audience;
  }

  if (b.sendPush !== undefined) {
    if (typeof b.sendPush !== "boolean") return { ok: false, error: "sendPush_invalid" };
    value.sendPush = b.sendPush;
  } else if (!partial) value.sendPush = true;

  return { ok: true, value };
}

// ── Reads ───────────────────────────────────────────────────────────────────

const ADMIN_SELECT = {
  id: true,
  status: true,
  title: true,
  teaser: true,
  body: true,
  agentBrief: true,
  suggestedQuestions: true,
  eventId: true,
  mediaKind: true,
  mediaPath: true,
  posterPath: true,
  audience: true,
  sendPush: true,
  scheduledAt: true,
  sentAt: true,
  recipientCount: true,
  createdAt: true,
  updatedAt: true,
} as const;

type AdminRow = Prisma.AnnouncementGetPayload<{ select: typeof ADMIN_SELECT }>;

export interface AdminAnnouncementDto {
  id: string;
  status: string;
  title: string;
  teaser: string;
  body: string;
  agentBrief: string | null;
  suggestedQuestions: string[];
  eventId: string | null;
  mediaKind: string | null;
  mediaUrl: string | null;
  posterUrl: string | null;
  audience: AnnouncementAudience;
  sendPush: boolean;
  scheduledAt: string | null;
  sentAt: string | null;
  recipientCount: number | null;
  readCount: number;
  pendingPushCount: number;
  createdAt: string;
  updatedAt: string;
}

async function toAdminDto(row: AdminRow, withMedia: boolean): Promise<AdminAnnouncementDto> {
  const [readCount, pendingPushCount, mediaUrl, posterUrl] = await Promise.all([
    prisma.inboxItem.count({ where: { announcementId: row.id, readAt: { not: null } } }),
    prisma.inboxItem.count({ where: { announcementId: row.id, pushedAt: null } }),
    withMedia && row.mediaPath ? createAnnouncementAssetSignedUrl(row.mediaPath, 3600) : null,
    withMedia && row.posterPath ? createAnnouncementAssetSignedUrl(row.posterPath, 3600) : null,
  ]);
  return {
    id: row.id,
    status: row.status,
    title: row.title,
    teaser: row.teaser,
    body: row.body,
    agentBrief: row.agentBrief,
    suggestedQuestions: row.suggestedQuestions,
    eventId: row.eventId,
    mediaKind: row.mediaKind,
    mediaUrl,
    posterUrl,
    audience: parseAnnouncementAudience(row.audience) ?? {},
    sendPush: row.sendPush,
    scheduledAt: row.scheduledAt?.toISOString() ?? null,
    sentAt: row.sentAt?.toISOString() ?? null,
    recipientCount: row.recipientCount,
    readCount,
    pendingPushCount,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function listAnnouncements(): Promise<AdminAnnouncementDto[]> {
  const rows = await prisma.announcement.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: ADMIN_SELECT,
  });
  return Promise.all(rows.map((r) => toAdminDto(r, false)));
}

export async function getAnnouncement(id: string): Promise<AdminAnnouncementDto | null> {
  if (!UUID_RE.test(id)) return null;
  const row = await prisma.announcement.findUnique({ where: { id }, select: ADMIN_SELECT });
  return row ? toAdminDto(row, true) : null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export type WriteResult =
  | { ok: true; announcement: AdminAnnouncementDto }
  | { ok: false; error: string; status: number };

async function eventExists(eventId: string | null | undefined): Promise<boolean> {
  if (!eventId) return true;
  return (await prisma.event.count({ where: { id: eventId } })) > 0;
}

export async function createAnnouncement(body: unknown): Promise<WriteResult> {
  const parsed = parseAnnouncementFields(body, false);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  const v = parsed.value as AnnouncementFields;
  if (!(await eventExists(v.eventId))) return { ok: false, error: "event_not_found", status: 422 };
  const row = await prisma.announcement.create({
    data: {
      title: v.title,
      teaser: v.teaser,
      body: v.body,
      agentBrief: v.agentBrief,
      suggestedQuestions: v.suggestedQuestions,
      eventId: v.eventId,
      audience: v.audience as Prisma.InputJsonObject,
      sendPush: v.sendPush,
    },
    select: ADMIN_SELECT,
  });
  console.log(`${LOG} created draft ${row.id}`);
  return { ok: true, announcement: await toAdminDto(row, true) };
}

export async function updateAnnouncementDraft(id: string, body: unknown): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  const parsed = parseAnnouncementFields(body, true);
  if (!parsed.ok) return { ok: false, error: parsed.error, status: 400 };
  const v = parsed.value;
  if (!(await eventExists(v.eventId))) return { ok: false, error: "event_not_found", status: 422 };

  const { count } = await prisma.announcement.updateMany({
    where: { id, status: "draft" },
    data: {
      ...(v.title !== undefined ? { title: v.title } : {}),
      ...(v.teaser !== undefined ? { teaser: v.teaser } : {}),
      ...(v.body !== undefined ? { body: v.body } : {}),
      ...(v.agentBrief !== undefined ? { agentBrief: v.agentBrief } : {}),
      ...(v.suggestedQuestions !== undefined ? { suggestedQuestions: v.suggestedQuestions } : {}),
      ...(v.eventId !== undefined ? { eventId: v.eventId } : {}),
      ...(v.audience !== undefined ? { audience: v.audience as Prisma.InputJsonObject } : {}),
      ...(v.sendPush !== undefined ? { sendPush: v.sendPush } : {}),
    },
  });
  return afterCas(id, count, "not_a_draft");
}

async function afterCas(id: string, count: number, conflict: string): Promise<WriteResult> {
  const row = await prisma.announcement.findUnique({ where: { id }, select: ADMIN_SELECT });
  if (!row) return { ok: false, error: "not_found", status: 404 };
  if (count === 0) return { ok: false, error: conflict, status: 409 };
  return { ok: true, announcement: await toAdminDto(row, true) };
}

export interface MediaUpload {
  role: AnnouncementAssetRole;
  buffer: Buffer;
}

/**
 * Attach the image/video or the poster to a draft. The type is decided by the
 * bytes, never by the upload's Content-Type; a video is checked for length
 * from its own container header (F3: short, played once).
 */
export async function attachAnnouncementMedia(id: string, upload: MediaUpload): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  const current = await prisma.announcement.findUnique({ where: { id }, select: { status: true } });
  if (!current) return { ok: false, error: "not_found", status: 404 };
  if (current.status !== "draft") return { ok: false, error: "not_a_draft", status: 409 };

  const image = sniffImageMime(upload.buffer);
  const imageMime = image === "image/jpeg" || image === "image/png" || image === "image/webp" ? image : null;
  let mime: string;
  let kind: "image" | "video";
  if (imageMime) {
    if (upload.buffer.length > ANNOUNCEMENT_MEDIA.imageMaxBytes) {
      return { ok: false, error: "image_too_large", status: 413 };
    }
    mime = imageMime;
    kind = "image";
  } else {
    const probe = probeMp4(upload.buffer);
    if (!probe) return { ok: false, error: "unsupported_media", status: 415 };
    if (upload.role === "poster") return { ok: false, error: "poster_must_be_image", status: 415 };
    if (upload.buffer.length > ANNOUNCEMENT_MEDIA.videoMaxBytes) {
      return { ok: false, error: "video_too_large", status: 413 };
    }
    if (probe.durationSeconds > ANNOUNCEMENT_MEDIA.videoMaxSeconds + 0.05) {
      return { ok: false, error: "video_too_long", status: 422 };
    }
    mime = "video/mp4";
    kind = "video";
  }

  let path: string;
  try {
    ({ path } = await uploadAnnouncementAsset(id, upload.role, upload.buffer, mime));
  } catch (err) {
    console.warn(`${LOG} media upload failed for ${id}:`, err);
    return { ok: false, error: "storage_unavailable", status: 502 };
  }

  const data: Prisma.AnnouncementUpdateManyMutationInput =
    upload.role === "poster"
      ? { posterPath: path }
      : // Replacing a video with an image drops the now-meaningless poster.
        { mediaPath: path, mediaKind: kind, ...(kind === "image" ? { posterPath: null } : {}) };
  const { count } = await prisma.announcement.updateMany({ where: { id, status: "draft" }, data });
  return afterCas(id, count, "not_a_draft");
}

export async function clearAnnouncementMedia(id: string): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  const { count } = await prisma.announcement.updateMany({
    where: { id, status: "draft" },
    data: { mediaKind: null, mediaPath: null, posterPath: null },
  });
  return afterCas(id, count, "not_a_draft");
}

/**
 * Schedule a draft. `at` defaults to now; the worker picks it up within a
 * minute. The checks here are the ones a half-finished draft would otherwise
 * fail in front of thousands of people.
 */
export async function scheduleAnnouncement(id: string, rawAt: unknown, now = new Date()): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  let at = now;
  if (rawAt !== undefined && rawAt !== null) {
    if (typeof rawAt !== "string" || Number.isNaN(new Date(rawAt).getTime())) {
      return { ok: false, error: "scheduledAt_invalid", status: 400 };
    }
    at = new Date(rawAt);
    if (at.getTime() < now.getTime()) at = now;
  }
  const row = await prisma.announcement.findUnique({
    where: { id },
    select: { status: true, mediaKind: true, posterPath: true },
  });
  if (!row) return { ok: false, error: "not_found", status: 404 };
  if (row.mediaKind === "video" && !row.posterPath) {
    return { ok: false, error: "video_needs_poster", status: 422 };
  }
  const { count } = await prisma.announcement.updateMany({
    where: { id, status: "draft" },
    data: { status: "scheduled", scheduledAt: at },
  });
  if (count === 1) console.log(`${LOG} scheduled ${id} for ${at.toISOString()}`);
  return afterCas(id, count, "not_a_draft");
}

export async function unscheduleAnnouncement(id: string): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  const { count } = await prisma.announcement.updateMany({
    where: { id, status: "scheduled" },
    data: { status: "draft", scheduledAt: null },
  });
  return afterCas(id, count, "not_scheduled");
}

/**
 * Archive hides an announcement from the dashboard's active list. It does not
 * reach into anyone's inbox: what a person was sent stays what they were sent.
 */
export async function archiveAnnouncement(id: string): Promise<WriteResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  const { count } = await prisma.announcement.updateMany({
    where: { id, status: { in: ["draft", "sent"] } },
    data: { status: "archived" },
  });
  return afterCas(id, count, "cannot_archive");
}

// ── Delivery ────────────────────────────────────────────────────────────────

interface Deliverable {
  id: string;
  title: string;
  teaser: string;
  posterPath: string | null;
  mediaKind: string | null;
  mediaPath: string | null;
}

/**
 * The push for one inbox row. `poster` (not `image`) carries the cover: the
 * Notification Service Extension blurs every `image`, and a party poster has
 * no face to protect. An image announcement uses the image itself.
 */
function pushPayload(a: Deliverable, inboxItemId: string, posterUrl: string | null) {
  return {
    title: a.title,
    body: a.teaser,
    data: {
      type: ANNOUNCEMENT_PUSH_TYPE,
      inboxItemId,
      announcementId: a.id,
      ...(posterUrl ? { poster: posterUrl } : {}),
    },
    collapseId: `announcement-${a.id}`,
  };
}

async function coverUrl(a: Deliverable): Promise<string | null> {
  const path = a.posterPath ?? (a.mediaKind === "image" ? a.mediaPath : null);
  return path ? createAnnouncementAssetSignedUrl(path, ANNOUNCEMENT_MEDIA.signedUrlTtlSeconds) : null;
}

export type PreviewResult =
  | { ok: true; inboxItemId: string; pushed: boolean }
  | { ok: false; error: string; status: number };

/**
 * Send one announcement to one account — the founder's own phone, before
 * everyone else's. Works in any status but `archived`. The row it writes is
 * the same row the fan-out would write, so the preview account is not sent a
 * second copy later; the fan-out refreshes its words to the scheduled version.
 */
export async function previewAnnouncement(id: string, rawUserId: unknown): Promise<PreviewResult> {
  if (!UUID_RE.test(id)) return { ok: false, error: "not_found", status: 404 };
  if (typeof rawUserId !== "string" || !UUID_RE.test(rawUserId)) {
    return { ok: false, error: "userId_invalid", status: 400 };
  }
  const [announcement, user] = await Promise.all([
    prisma.announcement.findUnique({
      where: { id },
      select: { id: true, status: true, title: true, teaser: true, posterPath: true, mediaKind: true, mediaPath: true },
    }),
    prisma.user.findUnique({ where: { id: rawUserId }, select: { id: true, platform: true } }),
  ]);
  if (!announcement || announcement.status === "archived") return { ok: false, error: "not_found", status: 404 };
  if (!user || !pushReachable(user)) return { ok: false, error: "user_not_on_app", status: 422 };

  const row = await prisma.inboxItem.upsert({
    where: { userId_announcementId: { userId: user.id, announcementId: id } },
    create: {
      userId: user.id,
      announcementId: id,
      type: ANNOUNCEMENT_PUSH_TYPE,
      title: announcement.title,
      body: announcement.teaser,
      pushedAt: new Date(),
    },
    update: { title: announcement.title, body: announcement.teaser, readAt: null, pushedAt: new Date() },
    select: { id: true },
  });
  const pushed = await sendPushToUser(
    user.id,
    pushPayload(announcement, row.id, await coverUrl(announcement)),
    { recordInbox: false },
  ).catch(() => false);
  return { ok: true, inboxItemId: row.id, pushed };
}

export interface FanoutDeps {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  quietHours?: (at: Date) => boolean;
  send?: typeof sendPushToUser;
}

export interface FanoutResult {
  claimed: number;
  inboxRows: number;
  pushed: number;
  heldForQuietHours: boolean;
  completed: number;
}

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One worker tick. Safe to run every minute and safe to kill mid-way: claiming
 * is a CAS, inbox rows are `skipDuplicates` against the per-person unique key,
 * and pushes resume from `pushedAt IS NULL`.
 */
export async function announcementFanoutTick(deps: FanoutDeps = {}): Promise<FanoutResult> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? sleepMs;
  const quiet = deps.quietHours ?? isQuietHours;
  const send = deps.send ?? sendPushToUser;
  const result: FanoutResult = { claimed: 0, inboxRows: 0, pushed: 0, heldForQuietHours: false, completed: 0 };

  const due = await prisma.announcement.findMany({
    where: { status: "scheduled", scheduledAt: { lte: now() } },
    select: { id: true },
    orderBy: { scheduledAt: "asc" },
  });
  for (const { id } of due) {
    const { count } = await prisma.announcement.updateMany({
      where: { id, status: "scheduled" },
      data: { status: "sending" },
    });
    result.claimed += count;
  }

  const sending = await prisma.announcement.findMany({
    where: { status: "sending" },
    select: {
      id: true,
      title: true,
      teaser: true,
      posterPath: true,
      mediaKind: true,
      mediaPath: true,
      audience: true,
      sendPush: true,
    },
    orderBy: { scheduledAt: "asc" },
  });

  for (const a of sending) {
    result.inboxRows += await writeInboxRows(a);

    if (!a.sendPush) {
      await prisma.inboxItem.updateMany({
        where: { announcementId: a.id, pushedAt: null },
        data: { pushedAt: now() },
      });
    } else {
      const outcome = await pushPending(a, { now, sleep, quiet, send });
      result.pushed += outcome.pushed;
      if (outcome.held) {
        result.heldForQuietHours = true;
        continue;
      }
    }

    const [pending, recipients] = await Promise.all([
      prisma.inboxItem.count({ where: { announcementId: a.id, pushedAt: null } }),
      prisma.inboxItem.count({ where: { announcementId: a.id } }),
    ]);
    if (pending === 0) {
      const { count } = await prisma.announcement.updateMany({
        where: { id: a.id, status: "sending" },
        data: { status: "sent", sentAt: now(), recipientCount: recipients },
      });
      result.completed += count;
      if (count === 1) console.log(`${LOG} sent ${a.id} to ${recipients} inboxes`);
    }
  }
  return result;
}

/**
 * Write every inbox row for an announcement, paging the audience by id. Rows
 * the preview already wrote are refreshed to the scheduled wording first, so a
 * preview of an earlier draft does not outlive the edit.
 */
async function writeInboxRows(a: Deliverable & { audience: Prisma.JsonValue }): Promise<number> {
  await prisma.inboxItem.updateMany({
    where: { announcementId: a.id, OR: [{ title: { not: a.title } }, { body: { not: a.teaser } }] },
    data: { title: a.title, body: a.teaser },
  });

  const audience = parseAnnouncementAudience(a.audience) ?? {};
  const where = audienceWhere(audience);
  let cursor: string | null = null;
  let written = 0;
  for (;;) {
    const users: Array<{ id: string }> = await prisma.user.findMany({
      where,
      select: { id: true },
      orderBy: { id: "asc" },
      take: ANNOUNCEMENT_INBOX_BATCH,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    if (users.length === 0) break;
    const { count } = await prisma.inboxItem.createMany({
      data: users.map((u) => ({
        userId: u.id,
        announcementId: a.id,
        type: ANNOUNCEMENT_PUSH_TYPE,
        title: a.title,
        body: a.teaser,
      })),
      skipDuplicates: true,
    });
    written += count;
    cursor = users[users.length - 1]!.id;
    if (users.length < ANNOUNCEMENT_INBOX_BATCH) break;
  }
  return written;
}

interface PushDeps {
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
  quiet: (at: Date) => boolean;
  send: typeof sendPushToUser;
}

async function pushPending(a: Deliverable, deps: PushDeps): Promise<{ pushed: number; held: boolean }> {
  const cover = await coverUrl(a);
  let pushed = 0;
  for (;;) {
    if (deps.quiet(deps.now())) return { pushed, held: true };
    const rows = await prisma.inboxItem.findMany({
      where: { announcementId: a.id, pushedAt: null },
      select: { id: true, userId: true, readAt: true },
      orderBy: { id: "asc" },
      take: 200,
    });
    if (rows.length === 0) return { pushed, held: false };
    for (const row of rows) {
      if (deps.quiet(deps.now())) return { pushed, held: true };
      // Someone who already opened it in the app (it was in their inbox
      // through the night) does not need the phone to ring about it at nine.
      if (!row.readAt) {
        const ok = await deps
          .send(row.userId, pushPayload(a, row.id, cover), { recordInbox: false })
          .catch(() => false);
        if (ok) pushed++;
      }
      await prisma.inboxItem.update({ where: { id: row.id }, data: { pushedAt: deps.now() } });
      if (!row.readAt) await deps.sleep(ANNOUNCEMENT_PUSH_INTERVAL_MS);
    }
  }
}
