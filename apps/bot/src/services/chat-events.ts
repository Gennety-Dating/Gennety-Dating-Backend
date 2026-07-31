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

/**
 * One displayable attachment on a timeline event.
 *
 * `ref` is always a Telegram `file_id` — resolved from the API RESULT rather
 * than the request payload, because half the product's media is sent as raw
 * bytes (a rendered date card, a bundled voice note) and carries no id going
 * out. Telegram assigns one on the way back, and that is what the admin media
 * proxy can re-download later.
 *
 * A video, a video note and an animation store their POSTER frame, because the
 * proxy streams images: a moving format would otherwise have to be represented
 * by a label alone.
 */
export interface ChatEventMedia {
  /** `photo` | `video` | `video_note` | `voice` | `document` | `animation`. */
  kind: string;
  /** Telegram file_id of the image to display, when one exists. */
  ref?: string;
}

export interface RecordChatEventInput {
  userId: string;
  direction: ChatEventDirection;
  kind: string;
  summary: string;
  surface?: string | null;
  actions?: ChatEventAction[] | null;
  media?: ChatEventMedia[] | null;
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
        media:
          input.media && input.media.length > 0
            ? (input.media as unknown as Prisma.InputJsonValue)
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
 * `null` userId means "no such user" — the only reason a chat is not
 * recordable. Cached so the recorder does not hit the DB on every single
 * outgoing message.
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
/**
 * A MISS is cached for seconds, not minutes.
 *
 * The first `/start` reaches the inbound recorder before the handler that
 * creates the `User` row, so it resolves to "no such user". Caching that for
 * the full 5 minutes would silently discard the next five minutes of that
 * chat — which, now that onboarding is recorded, is most of registration.
 * A short window still absorbs a flood from a chat that genuinely has no user.
 */
const TARGET_CACHE_MISS_TTL_MS = 10 * 1000;
/** Bound the map so a long-running process can't grow it without limit. */
const TARGET_CACHE_MAX_ENTRIES = 5_000;

/** Test seam — drop everything cached. */
export function clearChatTargetCache(): void {
  targetCache.clear();
}

/**
 * Forget one chat's cached target.
 *
 * Kept as a seam for any flow that changes what a chat resolves to — the
 * phone-based account adoption in `services/account-linking.ts` re-points a
 * `telegramId` at a different row, which is exactly the case a stale cache
 * entry would get wrong.
 */
export function invalidateChatTarget(telegramId: bigint | number): void {
  targetCache.delete(String(telegramId));
}

/**
 * Resolve a Telegram chat id to the user whose timeline it belongs to.
 *
 * **Every real Telegram chat is recorded, from `/start` onward (founder
 * decision 2026-07-31).** This used to be scoped to `onboardingStep =
 * 'completed'`, which kept onboarding-era content — the typed OTP code, a
 * pasted AI-memory export — out of the table by construction. The cost was
 * that registration, the single most important funnel to be able to read, was
 * the one stretch of the conversation the admin dialog reader could not see:
 * no photos, no buttons, no Mini App steps, nothing but the onboarding agent's
 * own turns. The founder owns that data and reads it in a single-operator
 * dashboard, so the tradeoff was taken deliberately.
 *
 * What that means concretely, since it is not free:
 *   - a typed OTP code lands in `summary` (already expired by the time anyone
 *     reads it, and swept after 30 days by `workers/retention.ts`);
 *   - a pasted AI-memory export lands as a ≤300-char excerpt via
 *     `truncateSummary`, never in full — PRODUCT_SPEC §1.3's "the raw pasted
 *     response is transient" now means "except for that excerpt";
 *   - the phone number itself still never lands here: the contact share is
 *     recorded as the event, not the digits.
 *
 * The rows also reach the menu agent's prompt, where they are already fenced
 * as untrusted data — so onboarding text is subject to the same handling as
 * everything else in the timeline.
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
      select: { id: true },
    });
    // A row existing is the whole test now: there is no step at which the
    // conversation stops being worth recording.
    if (user) resolved = { userId: user.id, recordable: true };
  } catch (err) {
    console.warn("[chat-events] target lookup failed:", err);
    // Don't cache a lookup that failed for infrastructure reasons.
    return { userId: null, recordable: false };
  }

  if (targetCache.size >= TARGET_CACHE_MAX_ENTRIES) targetCache.clear();
  targetCache.set(key, {
    ...resolved,
    expiresAt: now + (resolved.userId ? TARGET_CACHE_TTL_MS : TARGET_CACHE_MISS_TTL_MS),
  });
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
  // Now that onboarding is in scope this also covers the registration Mini App
  // — the city pick, the theme pick, the sign-up fork — which happens entirely
  // off-chat and was previously invisible on both counts.
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
