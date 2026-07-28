import { prisma, Prisma } from "@gennety/db";

/**
 * Chat timeline (see `ChatEvent` in the Prisma schema).
 *
 * One append-only row per durable thing that happened in a user's Telegram
 * chat — a message the bot sent, a button the user tapped, a Mini App action,
 * a settled payment. `services/prompt-builder.ts` reads the last few back as
 * the menu agent's "Recent chat timeline", which is what lets it answer a bare
 * "why?" against the message directly above it instead of against conversation
 * from days ago.
 *
 * Every write here is best-effort and swallows its own errors: the recorder
 * sits in the path of literally every outgoing Telegram call, so a timeline
 * hiccup must never fail a send or a handler.
 */

/** Longest stored `summary`. A timeline entry is a reminder, not a transcript. */
export const MAX_SUMMARY_LENGTH = 300;

/** Default number of events handed to the agent. */
export const DEFAULT_TIMELINE_LIMIT = 12;

export type ChatEventDirection = "out" | "in";

export interface ChatEventAction {
  /** The button's own visible label — what the user would say they tapped. */
  label: string;
  /** `callback_data`, when it is a callback button. */
  data?: string;
  /** Set for `web_app` buttons: the Mini App page (e.g. "venue-change"). */
  webApp?: string;
}

export interface RecordChatEventInput {
  userId: string;
  direction: ChatEventDirection;
  kind: string;
  summary: string;
  surface?: string | null;
  actions?: ChatEventAction[] | null;
  telegramMessageId?: number | null;
  matchId?: string | null;
}

export interface ChatEventView {
  id: string;
  direction: string;
  kind: string;
  surface: string | null;
  summary: string;
  actions: ChatEventAction[] | null;
  telegramMessageId: number | null;
  createdAt: Date;
}

/** Collapse whitespace and clip to `MAX_SUMMARY_LENGTH`. */
export function truncateSummary(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_SUMMARY_LENGTH) return flat;
  return `${flat.slice(0, MAX_SUMMARY_LENGTH - 1)}…`;
}

/**
 * Append one timeline row. Never throws, never blocks the caller's own work —
 * call sites are expected to fire-and-forget it.
 */
export async function recordChatEvent(input: RecordChatEventInput): Promise<void> {
  const summary = truncateSummary(input.summary);
  if (!summary) return;
  try {
    await prisma.chatEvent.create({
      data: {
        userId: input.userId,
        direction: input.direction,
        kind: input.kind,
        surface: input.surface ?? null,
        summary,
        actions:
          input.actions && input.actions.length > 0
            ? (input.actions as unknown as Prisma.InputJsonValue)
            : Prisma.DbNull,
        telegramMessageId: input.telegramMessageId ?? null,
        matchId: input.matchId ?? null,
      },
    });
  } catch (err) {
    console.warn("[chat-events] record failed:", err);
  }
}

/** Read the most recent events, oldest first (chronological reading order). */
export async function getRecentChatEvents(
  userId: string,
  limit: number = DEFAULT_TIMELINE_LIMIT,
): Promise<ChatEventView[]> {
  try {
    const rows = await prisma.chatEvent.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: limit,
      select: {
        id: true,
        direction: true,
        kind: true,
        surface: true,
        summary: true,
        actions: true,
        telegramMessageId: true,
        createdAt: true,
      },
    });
    return rows.reverse().map((row) => ({
      ...row,
      actions: Array.isArray(row.actions)
        ? (row.actions as unknown as ChatEventAction[])
        : null,
    }));
  } catch (err) {
    console.warn("[chat-events] read failed:", err);
    return [];
  }
}

/**
 * Drop the row created for a message that was then deleted.
 *
 * The ephemeral "agent is thinking" shimmers send an ordinary `sendMessage`
 * and delete it seconds later. The known ones are tagged explicitly
 * (`withEphemeralSends`), but this reconciliation means a path we forget to
 * tag self-heals instead of leaving a phantom "the bot said …" in the
 * timeline.
 */
export async function forgetChatEventForMessage(
  userId: string,
  telegramMessageId: number,
): Promise<void> {
  try {
    await prisma.chatEvent.deleteMany({
      where: { userId, telegramMessageId, direction: "out" },
    });
  } catch (err) {
    console.warn("[chat-events] delete-reconcile failed:", err);
  }
}

// ---------------------------------------------------------------------------
// Chat → user resolution (cached)
// ---------------------------------------------------------------------------

/**
 * Resolved recording target for a Telegram chat.
 *
 * `null` userId means "no such user"; `recordable: false` means the user
 * exists but is still onboarding. Both are cached so the recorder does not hit
 * the DB on every single outgoing message.
 */
export interface ChatTarget {
  userId: string | null;
  recordable: boolean;
}

interface CachedTarget extends ChatTarget {
  expiresAt: number;
}

/** In-memory, single-process (same assumption as `services/usage-limiter.ts`). */
const targetCache = new Map<string, CachedTarget>();
const TARGET_CACHE_TTL_MS = 5 * 60 * 1000;
/** Bound the map so a long-running process can't grow it without limit. */
const TARGET_CACHE_MAX_ENTRIES = 5_000;

/** Test seam — drop everything cached. */
export function clearChatTargetCache(): void {
  targetCache.clear();
}

/**
 * Forget one chat's cached target.
 *
 * Called when a user finishes onboarding, so their very next message is
 * recorded instead of waiting out the TTL — the first minutes after
 * activation are exactly when the menu agent takes over.
 */
export function invalidateChatTarget(telegramId: bigint | number): void {
  targetCache.delete(String(telegramId));
}

/**
 * Resolve a Telegram chat id to the user whose timeline it belongs to.
 *
 * Only post-onboarding users are recordable. That is the menu agent's own
 * scope, and it keeps onboarding-era content (OTP codes, the phone number, a
 * pasted AI-memory export) out of the table by construction rather than by
 * filtering.
 */
export async function resolveChatTarget(
  telegramId: bigint | number,
): Promise<ChatTarget> {
  const id = typeof telegramId === "bigint" ? telegramId : BigInt(telegramId);
  // Mobile-only users carry a synthetic negative id and have no Telegram chat.
  if (id <= 0n) return { userId: null, recordable: false };

  const key = String(id);
  const now = Date.now();
  const cached = targetCache.get(key);
  if (cached && cached.expiresAt > now) {
    return { userId: cached.userId, recordable: cached.recordable };
  }

  let resolved: ChatTarget = { userId: null, recordable: false };
  try {
    const user = await prisma.user.findUnique({
      where: { telegramId: id },
      select: { id: true, onboardingStep: true },
    });
    if (user) {
      resolved = {
        userId: user.id,
        recordable: user.onboardingStep === "completed",
      };
    }
  } catch (err) {
    console.warn("[chat-events] target lookup failed:", err);
    // Don't cache a lookup that failed for infrastructure reasons.
    return { userId: null, recordable: false };
  }

  if (targetCache.size >= TARGET_CACHE_MAX_ENTRIES) targetCache.clear();
  targetCache.set(key, { ...resolved, expiresAt: now + TARGET_CACHE_TTL_MS });
  return resolved;
}

/**
 * Record something the user did inside a Mini App.
 *
 * This is the half of "what did they just do" the transformer and the inbound
 * middleware cannot see: the Mini Apps talk to the initData-authed `/v1/*`
 * routes, never through the chat. Without it the timeline shows the bot's
 * reaction ("you're keeping Aroma Kava") with no trace of the tap that caused
 * it — which is exactly the case that made the agent answer a "why?" about
 * something else entirely. Fire-and-forget; call it only once the action has
 * actually succeeded.
 */
export function recordMiniAppAction(
  telegramId: bigint | number,
  summary: string,
  options: { surface?: string | null; matchId?: string | null } = {},
): void {
  void recordChatEventForChat(telegramId, {
    direction: "in",
    kind: "mini_app_action",
    summary,
    surface: options.surface ?? null,
    matchId: options.matchId ?? null,
  });
}

/**
 * Record an event addressed by Telegram chat id, resolving (and caching) the
 * owning user first. No-ops for unknown or still-onboarding chats.
 */
export async function recordChatEventForChat(
  telegramId: bigint | number,
  input: Omit<RecordChatEventInput, "userId">,
): Promise<void> {
  const target = await resolveChatTarget(telegramId);
  if (!target.userId || !target.recordable) return;
  await recordChatEvent({ ...input, userId: target.userId });
}
