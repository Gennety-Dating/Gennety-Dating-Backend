import { Router, type Request, type Response } from "express";
import { prisma } from "@gennety/db";
import { isUuid } from "../utils/uuid.js";

// ---------------------------------------------------------------------------
// GET /admin/dialogs          — paginated list of dialogs (one per user)
// GET /admin/dialogs/:id      — one dialog with its message transcript
// ---------------------------------------------------------------------------
// A "dialog" in Gennety is a user↔bot conversation. There is deliberately no
// user↔user chat in the product (PRODUCT_SPEC "NO IN-APP CHAT"), so a dialog
// has exactly one human participant plus the bot; `direction` on each message
// says who spoke. The one relayed user↔user surface — the feature-flagged
// pre-date proxy chat (`proxy_messages`) — is deliberately NOT exposed here:
// it is match-scoped moderation evidence, not a dialog, and reading it should
// stay a separate deliberate act.
//
// Three stores are merged, because the conversation is genuinely spread across
// them (see ARCHITECTURE.md):
//   • `User.messageHistory` — Telegram onboarding/menu agent turns. Array
//     order only, no timestamps, no images.
//   • `Message` rows        — Aether mobile concierge. Real timestamps + an
//     optional image ref.
//   • `ChatEvent` rows      — the chat timeline: every durable message the bot
//     SENT and every action the user TOOK (tap, Mini App submit, payment).
//     The only store that sees the non-agent send sites.
//
// `ChatEvent` is a newer table, so every read of it is guarded: a database
// that predates it degrades to the other two stores with
// `sources.timeline = false` rather than 500ing the whole endpoint.
// ---------------------------------------------------------------------------

export const dialogsRouter: Router = Router();

/** Cap on how much of a message body is echoed into a list preview. */
const PREVIEW_MAX_CHARS = 200;

type UnifiedMessage = {
  id: string;
  /** Which store the row came from. */
  source: "agent" | "aether" | "timeline";
  /** `in` = the human, `out` = the bot. */
  direction: "in" | "out";
  role: string;
  text: string | null;
  createdAt: string | null;
  /** System/tool plumbing rather than something a human said or read. */
  technical: boolean;
  kind?: string;
  surface?: string;
  actions?: unknown;
  matchId?: string;
  toolCalls?: Array<{ name: string; arguments: string }>;
  image?: { type: "chat"; ref: string };
};

type RawHistoryEntry = {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
};

type AetherRow = {
  id: string;
  role: string;
  content: string;
  imageUrl: string | null;
  createdAt: Date;
};

type TimelineRow = {
  id: string;
  direction: string;
  kind: string;
  surface: string | null;
  summary: string;
  actions: unknown;
  matchId: string | null;
  createdAt: Date;
};

type GroupedCount = {
  userId: string;
  _count: { _all: number };
  _max: { createdAt: Date | null };
};

const AETHER_SELECT = {
  id: true,
  role: true,
  content: true,
  imageUrl: true,
  createdAt: true,
} as const;

const TIMELINE_SELECT = {
  id: true,
  direction: true,
  kind: true,
  surface: true,
  summary: true,
  actions: true,
  matchId: true,
  createdAt: true,
} as const;

const USER_STATUSES = new Set([
  "onboarding",
  "active",
  "paused",
  "frozen",
  "suspended",
  "pending_investigation",
  "banned",
]);
const PLATFORMS = new Set(["telegram", "mobile", "both"]);

const PARTICIPANT_SELECT = {
  id: true,
  telegramId: true,
  telegramUsername: true,
  firstName: true,
  surname: true,
  age: true,
  gender: true,
  language: true,
  platform: true,
  status: true,
  onboardingStep: true,
  verificationStatus: true,
  registrationTrack: true,
  createdAt: true,
  lastMessageAt: true,
} as const;

type ParticipantRow = {
  id: string;
  telegramId: bigint;
  telegramUsername: string | null;
  firstName: string | null;
  surname: string | null;
  age: number | null;
  gender: string | null;
  language: string | null;
  platform: string;
  status: string;
  onboardingStep: string;
  verificationStatus: string;
  registrationTrack: string | null;
  createdAt: Date;
  lastMessageAt: Date | null;
  profile?: { homeCity: string | null; homeCityKey: string | null } | null;
};

function serializeParticipant(user: ParticipantRow) {
  const nameParts = [user.firstName, user.surname].filter(Boolean);
  return {
    userId: user.id,
    // A mobile-only account carries a synthetic NEGATIVE telegramId — it is
    // not a real Telegram account and no t.me link exists for it.
    telegramId: user.telegramId.toString(),
    telegramUsername: user.telegramUsername,
    displayName: nameParts.length > 0 ? nameParts.join(" ") : null,
    age: user.age,
    gender: user.gender,
    language: user.language,
    platform: user.platform,
    status: user.status,
    onboardingStep: user.onboardingStep,
    verificationStatus: user.verificationStatus,
    registrationTrack: user.registrationTrack,
    city: user.profile?.homeCity ?? null,
    cityKey: user.profile?.homeCityKey ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

function parseIntParam(raw: unknown, fallback: number, min: number, max: number): number | null {
  const n = Number(raw ?? fallback);
  if (!Number.isFinite(n)) return null;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function preview(text: string | null): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  if (!flat) return null;
  return flat.length > PREVIEW_MAX_CHARS ? `${flat.slice(0, PREVIEW_MAX_CHARS)}…` : flat;
}

/**
 * Normalize `User.messageHistory` (the Telegram agent store) into unified
 * messages. These rows carry NO timestamps — array order is the only ordering
 * signal we have, so they are emitted as a block ahead of the timestamped
 * stores rather than interleaved on a fabricated clock.
 */
function normalizeAgentHistory(history: unknown): UnifiedMessage[] {
  if (!Array.isArray(history)) return [];
  return (history as RawHistoryEntry[]).map((entry, idx) => {
    const role = typeof entry?.role === "string" ? entry.role : "unknown";
    const text = typeof entry?.content === "string" ? entry.content : null;
    const toolCalls = Array.isArray(entry?.tool_calls)
      ? entry.tool_calls
          .map((tc) => ({
            name: tc?.function?.name ?? "",
            arguments: tc?.function?.arguments ?? "",
          }))
          .filter((tc) => tc.name || tc.arguments)
      : undefined;
    return {
      id: `agent-${idx}`,
      source: "agent" as const,
      direction: role === "user" ? ("in" as const) : ("out" as const),
      role,
      text,
      createdAt: null,
      technical: role === "system" || role === "tool" || text === null,
      ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    };
  });
}

function normalizeAether(row: AetherRow): UnifiedMessage {
  return {
    id: row.id,
    source: "aether",
    direction: row.role === "user" ? "in" : "out",
    role: row.role,
    text: row.content,
    createdAt: row.createdAt.toISOString(),
    technical: row.role === "system",
    ...(row.imageUrl ? { image: { type: "chat" as const, ref: row.imageUrl } } : {}),
  };
}

function normalizeTimeline(row: TimelineRow): UnifiedMessage {
  return {
    id: row.id,
    source: "timeline",
    direction: row.direction === "in" ? "in" : "out",
    role: row.direction === "in" ? "user" : "assistant",
    text: row.summary,
    createdAt: row.createdAt.toISOString(),
    technical: false,
    kind: row.kind,
    ...(row.surface ? { surface: row.surface } : {}),
    ...(row.actions ? { actions: row.actions } : {}),
    ...(row.matchId ? { matchId: row.matchId } : {}),
  };
}

/**
 * A missing chat timeline is a steady state, not an incident, so it is
 * announced at most once an hour. Without this the endpoint wrote several
 * stack traces into the PM2 error log per request — the same log the deploy
 * checklist reads to decide whether a release is healthy.
 */
let timelineWarnedAt = 0;
const TIMELINE_WARN_INTERVAL_MS = 60 * 60 * 1000;

/**
 * `ChatEvent` is newer than the rest of the admin surface, so a database (or a
 * generated Prisma client) that predates it must degrade rather than fail. Any
 * error here means "no timeline available" — the two older stores still answer,
 * and the response says so via `sources.timeline`.
 */
async function readTimeline<T>(run: () => Promise<T>, fallback: T): Promise<{ value: T; ok: boolean }> {
  try {
    return { value: await run(), ok: true };
  } catch (err) {
    const now = Date.now();
    if (now - timelineWarnedAt > TIMELINE_WARN_INTERVAL_MS) {
      timelineWarnedAt = now;
      const reason = err instanceof Error ? err.message : String(err);
      console.warn(
        `[admin] dialogs: chat timeline unavailable, serving agent+aether only (${reason})`,
      );
    }
    return { value: fallback, ok: false };
  }
}

/** Newest-first, with untimestamped agent rows sorted last. */
function byNewest(a: UnifiedMessage, b: UnifiedMessage): number {
  if (!a.createdAt && !b.createdAt) return 0;
  if (!a.createdAt) return 1;
  if (!b.createdAt) return -1;
  return b.createdAt.localeCompare(a.createdAt);
}

function groupByUser<T extends { userId: string }>(rows: T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const bucket = out.get(row.userId);
    if (bucket) bucket.push(row);
    else out.set(row.userId, [row]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// GET /admin/dialogs
// ---------------------------------------------------------------------------
// `/admin/conversations` is an alias, not a second implementation: the same
// handler is registered on both paths so the two can never drift. It exists
// because "conversations" is the name external callers reach for first, and a
// 404 there is indistinguishable from "the feature does not exist".
dialogsRouter.get(["/admin/dialogs", "/admin/conversations"], async (req: Request, res: Response) => {
  try {
    const limit = parseIntParam(req.query.limit, 20, 1, 100);
    const offset = parseIntParam(req.query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const messageLimit = parseIntParam(req.query.messageLimit, 20, 1, 200);
    if (limit === null || offset === null || messageLimit === null) {
      res.status(400).json({ error: "limit, offset and messageLimit must be integers" });
      return;
    }
    const includeMessages = req.query.includeMessages === "true";

    const statusRaw = String(req.query.status ?? "");
    if (statusRaw && !USER_STATUSES.has(statusRaw)) {
      res.status(400).json({ error: "Unknown status" });
      return;
    }
    const platformRaw = String(req.query.platform ?? "");
    if (platformRaw && !PLATFORMS.has(platformRaw)) {
      res.status(400).json({ error: "Unknown platform" });
      return;
    }

    const activeSinceRaw = String(req.query.activeSince ?? "");
    let activeSince: Date | null = null;
    if (activeSinceRaw) {
      const parsed = new Date(activeSinceRaw);
      if (Number.isNaN(parsed.getTime())) {
        res.status(400).json({ error: "activeSince must be an ISO date" });
        return;
      }
      activeSince = parsed;
    }

    const search = String(req.query.search ?? "").trim();

    const where: Record<string, unknown> = {};
    if (statusRaw) where.status = statusRaw;
    if (platformRaw) where.platform = platformRaw;
    if (activeSince) where.lastMessageAt = { gte: activeSince };
    if (search) {
      const or: Record<string, unknown>[] = [
        { firstName: { contains: search, mode: "insensitive" } },
        { surname: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
        { telegramUsername: { contains: search, mode: "insensitive" } },
      ];
      // A bare number is almost certainly a Telegram id, not a name.
      if (/^-?\d+$/.test(search)) {
        try {
          or.push({ telegramId: BigInt(search) });
        } catch {
          // Out of BigInt range — fall through to the text matches.
        }
      }
      where.OR = or;
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        take: limit,
        skip: offset,
        // Most recently active dialogs first; a user who never spoke sorts by
        // signup instead of vanishing into an unstable ordering.
        orderBy: [{ lastMessageAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
        select: {
          ...PARTICIPANT_SELECT,
          messageHistory: true,
          profile: { select: { homeCity: true, homeCityKey: true } },
        },
      }),
      prisma.user.count({ where }),
    ]);

    const ids = users.map((u) => u.id);

    const emptyCounts: GroupedCount[] = [];
    const [aetherCounts, timelineCounts] = await Promise.all([
      ids.length
        ? (prisma.message.groupBy({
            by: ["userId"],
            where: { userId: { in: ids } },
            _count: { _all: true },
            _max: { createdAt: true },
          }) as unknown as Promise<GroupedCount[]>)
        : Promise.resolve(emptyCounts),
      readTimeline(
        async () =>
          ids.length
            ? ((await prisma.chatEvent.groupBy({
                by: ["userId"],
                where: { userId: { in: ids } },
                _count: { _all: true },
                _max: { createdAt: true },
              })) as unknown as GroupedCount[])
            : emptyCounts,
        emptyCounts,
      ),
    ]);

    const aetherByUser = new Map(aetherCounts.map((row) => [row.userId, row]));
    const timelineByUser = new Map(timelineCounts.value.map((row) => [row.userId, row]));

    // Newest row per store, for the preview line. Exact rather than
    // approximate: the groupBy above already told us each user's max
    // timestamp, so we ask for precisely those rows.
    const aetherKeys = aetherCounts
      .filter((r): r is GroupedCount & { _max: { createdAt: Date } } => r._max.createdAt !== null)
      .map((r) => ({ userId: r.userId, createdAt: r._max.createdAt }));
    const timelineKeys = timelineCounts.value
      .filter((r): r is GroupedCount & { _max: { createdAt: Date } } => r._max.createdAt !== null)
      .map((r) => ({ userId: r.userId, createdAt: r._max.createdAt }));

    const [aetherNewest, timelineNewest] = await Promise.all([
      aetherKeys.length
        ? prisma.message.findMany({
            where: { OR: aetherKeys },
            select: { ...AETHER_SELECT, userId: true },
          })
        : Promise.resolve([] as Array<AetherRow & { userId: string }>),
      timelineKeys.length
        ? readTimeline(
            async () =>
              await prisma.chatEvent.findMany({
                where: { OR: timelineKeys },
                select: { ...TIMELINE_SELECT, userId: true },
              }),
            [] as Array<TimelineRow & { userId: string }>,
          ).then((r) => r.value)
        : Promise.resolve([] as Array<TimelineRow & { userId: string }>),
    ]);

    const newestByUser = new Map<string, UnifiedMessage>();
    const remember = (userId: string, msg: UnifiedMessage): void => {
      const current = newestByUser.get(userId);
      if (!current || byNewest(msg, current) < 0) newestByUser.set(userId, msg);
    };
    for (const row of aetherNewest) remember(row.userId, normalizeAether(row));
    for (const row of timelineNewest) remember(row.userId, normalizeTimeline(row));

    // When messages are requested inline we need the actual rows, not just the
    // newest one — fetch the tail of each timestamped store across the page.
    let inlineAether = new Map<string, Array<AetherRow & { userId: string }>>();
    let inlineTimeline = new Map<string, Array<TimelineRow & { userId: string }>>();
    if (includeMessages && ids.length) {
      const [a, t] = await Promise.all([
        prisma.message.findMany({
          where: { userId: { in: ids } },
          orderBy: { createdAt: "desc" },
          take: ids.length * messageLimit,
          select: { ...AETHER_SELECT, userId: true },
        }),
        readTimeline(
          async () =>
            await prisma.chatEvent.findMany({
              where: { userId: { in: ids } },
              orderBy: { createdAt: "desc" },
              take: ids.length * messageLimit,
              select: { ...TIMELINE_SELECT, userId: true },
            }),
          [] as Array<TimelineRow & { userId: string }>,
        ).then((r) => r.value),
      ]);
      inlineAether = groupByUser(a);
      inlineTimeline = groupByUser(t);
    }

    const data = users.map((user) => {
      const agent = normalizeAgentHistory(user.messageHistory);
      const aether = aetherByUser.get(user.id);
      const tl = timelineByUser.get(user.id);

      const agentCount = agent.length;
      const aetherCount = aether?._count._all ?? 0;
      const timelineCount = tl?._count._all ?? 0;

      const lastTimestamped = newestByUser.get(user.id) ?? null;
      const lastAgent = [...agent].reverse().find((m) => !m.technical) ?? null;
      const last = lastTimestamped ?? lastAgent;

      const timestamps = [aether?._max.createdAt, tl?._max.createdAt, user.lastMessageAt]
        .filter((d): d is Date => d instanceof Date)
        .map((d) => d.getTime());
      const lastMessageAt = timestamps.length
        ? new Date(Math.max(...timestamps)).toISOString()
        : null;

      let messages: UnifiedMessage[] | undefined;
      if (includeMessages) {
        const timestamped = [
          ...(inlineAether.get(user.id) ?? []).map(normalizeAether),
          ...(inlineTimeline.get(user.id) ?? []).map(normalizeTimeline),
        ]
          .sort(byNewest)
          .slice(0, messageLimit)
          .reverse();
        // Agent turns have no clock, so they lead the block (see above).
        messages = [...agent, ...timestamped].slice(-messageLimit);
      }

      return {
        id: user.id,
        participant: serializeParticipant(user),
        counts: {
          total: agentCount + aetherCount + timelineCount,
          agent: agentCount,
          aether: aetherCount,
          timeline: timelineCount,
        },
        lastMessageAt,
        lastMessage: last
          ? {
              source: last.source,
              direction: last.direction,
              text: preview(last.text),
              createdAt: last.createdAt,
            }
          : null,
        ...(messages ? { messages } : {}),
      };
    });

    res.json({
      data,
      total,
      limit,
      offset,
      sources: { agent: true, aether: true, timeline: timelineCounts.ok },
    });
  } catch (err) {
    console.error("[admin] dialogs list error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ---------------------------------------------------------------------------
// GET /admin/dialogs/:id — transcript for one dialog (id == user id)
// ---------------------------------------------------------------------------
dialogsRouter.get(["/admin/dialogs/:id", "/admin/conversations/:id"], async (req: Request, res: Response) => {
  try {
    const id = req.params["id"] as string;
    // A non-UUID id makes Prisma throw P2023, which would surface as a 500.
    // Answer the caller's actual mistake instead.
    if (!isUuid(id)) {
      res.status(400).json({ error: "id must be a UUID" });
      return;
    }

    const limit = parseIntParam(req.query.limit, 200, 1, 1000);
    if (limit === null) {
      res.status(400).json({ error: "limit must be an integer" });
      return;
    }
    const orderRaw = String(req.query.order ?? "asc");
    if (orderRaw !== "asc" && orderRaw !== "desc") {
      res.status(400).json({ error: "order must be asc or desc" });
      return;
    }
    const includeTechnical = req.query.includeTechnical === "true";

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        ...PARTICIPANT_SELECT,
        messageHistory: true,
        profile: { select: { homeCity: true, homeCityKey: true, photos: true } },
      },
    });
    if (!user) {
      res.status(404).json({ error: "Dialog not found" });
      return;
    }

    const [aetherRows, timeline] = await Promise.all([
      prisma.message.findMany({
        where: { userId: id },
        orderBy: { createdAt: "desc" },
        take: limit,
        select: AETHER_SELECT,
      }),
      readTimeline(
        async () =>
          await prisma.chatEvent.findMany({
            where: { userId: id },
            orderBy: { createdAt: "desc" },
            take: limit,
            select: TIMELINE_SELECT,
          }),
        [] as TimelineRow[],
      ),
    ]);

    const agent = normalizeAgentHistory(user.messageHistory);
    const timestamped = [
      ...aetherRows.map(normalizeAether),
      ...timeline.value.map(normalizeTimeline),
    ]
      .sort(byNewest)
      .slice(0, limit)
      .reverse();

    // Chronological = the untimestamped agent block first, then the merged
    // timestamped stores. `order=desc` mirrors the whole thing.
    let messages = [...agent, ...timestamped];
    if (!includeTechnical) messages = messages.filter((m) => !m.technical);
    messages = messages.slice(-limit);
    if (orderRaw === "desc") messages = [...messages].reverse();

    const photos = (user.profile?.photos ?? []).map((ref) => ({
      type: "photo" as const,
      ref,
    }));

    res.json({
      id: user.id,
      participant: serializeParticipant(user),
      counts: {
        total: agent.length + aetherRows.length + timeline.value.length,
        agent: agent.length,
        aether: aetherRows.length,
        timeline: timeline.value.length,
      },
      sources: { agent: true, aether: true, timeline: timeline.ok },
      messages,
      photos,
    });
  } catch (err) {
    console.error("[admin] dialog detail error:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});
