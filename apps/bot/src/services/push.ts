import { prisma } from "@gennety/db";
import {
  apnsConfigured,
  buildAlertPayload,
  buildLiveActivityPayload,
  buildLiveActivityStartPayload,
  sendApnsNotification,
  type LiveActivityStartInput,
  type LiveActivityUpdateInput,
} from "./apns.js";
import { isInboxPushType, recordTransactionalInboxItem } from "./inbox.js";
import { pushReachable } from "./telegram-reach.js";

/**
 * Push dispatcher for native mobile users (`User.platform === "mobile"`).
 * Bot-side notifications stay Telegram DMs; callers pass an internal
 * `userId` and we look up the `pushToken` registered via
 * POST /v1/me/push-token (`pushPlatform: "apns"`).
 *
 * Transport is direct APNs (`services/apns.ts`) — the Expo SDK rail was
 * retired 2026-07-18 (IOS_APP_ROADMAP task 0.2; no Expo client ever
 * shipped). Legacy `ExponentPushToken[...]` rows fail APNs validation as
 * `BadDeviceToken` and are purged by the same dead-token sweep.
 *
 * Dead tokens (`Unregistered`, `BadDeviceToken`, …, or HTTP 410) are cleared
 * automatically so we never keep spamming devices that uninstalled the app.
 */

export interface PushPayload {
  title: string;
  body: string;
  /**
   * Custom JSON forwarded to the client alongside `aps` — deep-link data.
   *
   * Two keys are read by the payload builder rather than by the client:
   * `type` becomes the APNs category (the client's action buttons), and
   * `image` turns on `mutable-content` so the Notification Service Extension
   * runs and blurs it (§5.3).
   */
  data?: Record<string, unknown>;
  /** Replaces an earlier notification with the same id — see `ApnsSendOptions`. */
  collapseId?: string;
}

export interface SendPushOptions {
  /**
   * Write the inbox row for an allowlisted type (default). The announcement
   * fan-out passes `false`: it wrote its rows in bulk before pushing, and a
   * second row per person would double every unread count.
   */
  recordInbox?: boolean;
}

const DEAD_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "Unregistered",
  "DeviceTokenNotForTopic",
  "ExpiredToken",
]);

function tokenIsDead(result: { ok: boolean; status?: number; reason?: string | null }): boolean {
  if (result.ok) return false;
  if (result.status === 410) return true;
  return DEAD_TOKEN_REASONS.has(result.reason ?? "");
}

/**
 * Send a push to a single mobile user. Resolves `true` when APNs accepted
 * the notification; `false` (never throws) when the user has no token,
 * APNs isn't configured, or delivery failed.
 *
 * **Quiet hours are the CALLER's business, and deliberately so** (audit
 * 2026-09-06, «дублирование тихих часов»). This rail carries two different
 * kinds of message and only one of them may be delayed:
 *
 *  - Proactive — nudges, re-engagement, announcements. Every one of those
 *    already asks `isQuietHours` before it gets here, exactly as the Telegram
 *    side does (`matchNudgeTick` returns early on it). That is the same rule
 *    applied at the same place on both rails.
 *  - Transactional — a match decision, a paid ticket settling, a date about to
 *    start. Holding one of those until nine in the morning would not be
 *    politeness; it would be the product failing to answer something the person
 *    is waiting on right now.
 *
 * A blanket check here could not tell them apart, and would silence the second
 * kind to be polite about the first.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  options: SendPushOptions = {},
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushToken: true, platform: true },
  });
  if (!user) return false;

  // The inbox row is written BEFORE the token check (decision 2026-09-13): a
  // person who declined notifications still opens the app and still deserves
  // to find what was sent to them behind the bell. Only app users get one —
  // a Telegram-only account has no bell to put it behind.
  let outgoing = payload;
  const type = payload.data?.type;
  if (options.recordInbox !== false && pushReachable(user) && isInboxPushType(type)) {
    try {
      const inboxItemId = await recordTransactionalInboxItem({
        userId,
        type,
        title: payload.title,
        body: payload.body,
        data: payload.data,
      });
      outgoing = { ...payload, data: { ...payload.data, inboxItemId } };
    } catch (err) {
      // The inbox is a record of the push, never a gate on it.
      console.warn(`[push] inbox row failed for ${userId}:`, err);
    }
  }

  if (!user.pushToken) return false;
  if (!apnsConfigured()) {
    console.warn("[push] APNs not configured — dropping push for", userId);
    return false;
  }

  const result = await sendApnsNotification(user.pushToken, buildAlertPayload(outgoing), {
    pushType: "alert",
    ...(payload.collapseId ? { collapseId: payload.collapseId } : {}),
  });
  if (tokenIsDead(result)) {
    await prisma.user
      .update({ where: { id: userId }, data: { pushToken: null } })
      .catch(() => undefined);
    return false;
  }
  if (!result.ok) {
    console.warn(`[push] send failed for ${userId}: ${result.status} ${result.reason}`);
  }
  return result.ok;
}

/**
 * Fan-out helper — call `sendPushToUser` for every provided userId. Runs
 * them in parallel but swallows individual failures so one dead token
 * doesn't prevent the others from going out.
 */
export async function sendPushToUsers(
  userIds: string[],
  payload: PushPayload,
): Promise<void> {
  await Promise.all(
    userIds.map((id) => sendPushToUser(id, payload).catch(() => false)),
  );
}

export type LiveActivityType = "match_decision" | "date_day" | "venue_change";

/**
 * Which registered update token may receive a push — for an activity type that
 * can be started more than once while one token row per (user, type) exists.
 */
export interface LiveActivityTokenScope {
  /**
   * The token must belong to this match. A row registered with another
   * `matchId` drives some other match's card and is skipped. A row with no
   * `matchId` is accepted — older builds did not send one.
   */
  matchId?: string;
  /**
   * The token must have been (re-)registered at or after this instant. The
   * client registers a card's update token only once the card is on screen, so
   * a row older than the push-start that created the current card belongs to
   * a card that came before it — pushing into it would report success while the
   * card on the lock screen never changed.
   */
  registeredSince?: Date;
}

/**
 * Push a remote update (or end) into the user's running Live Activity of the
 * given type, using the update token the iOS client registered via
 * POST /v1/me/live-activity-token. Resolves `false` when no token is
 * registered or delivery failed; a dead token deletes its row so the next
 * activity re-registers cleanly.
 */
export async function sendLiveActivityUpdateToUser(
  userId: string,
  activityType: LiveActivityType,
  update: LiveActivityUpdateInput,
  scope?: LiveActivityTokenScope,
): Promise<boolean> {
  if (!apnsConfigured()) return false;
  const row = await prisma.liveActivityToken.findUnique({
    where: {
      userId_activityType_kind: { userId, activityType, kind: "update" },
    },
    select: scope
      ? { id: true, token: true, matchId: true, updatedAt: true }
      : { id: true, token: true },
  });
  if (!row) return false;
  if (scope) {
    const scoped = row as { matchId?: string | null; updatedAt?: Date };
    if (scope.matchId && scoped.matchId && scoped.matchId !== scope.matchId) return false;
    if (
      scope.registeredSince &&
      scoped.updatedAt &&
      scoped.updatedAt.getTime() < scope.registeredSince.getTime()
    ) {
      return false;
    }
  }

  const result = await sendApnsNotification(row.token, buildLiveActivityPayload(update), {
    pushType: "liveactivity",
  });
  if (tokenIsDead(result)) {
    await prisma.liveActivityToken.delete({ where: { id: row.id } }).catch(() => undefined);
    return false;
  }
  if (!result.ok) {
    console.warn(
      `[push] live-activity ${activityType} update failed for ${userId}: ${result.status} ${result.reason}`,
    );
  }
  return result.ok;
}

/**
 * Start a Live Activity remotely (push-to-start), using the per-TYPE `start`
 * token the client registers once — not the per-activity `update` token, which
 * cannot exist yet because there is no activity.
 *
 * Same dead-token sweep as above; resolves `false` (never throws) when the user
 * has no start token, which is the ordinary state for a Telegram-only user.
 */
export async function sendLiveActivityStartToUser(
  userId: string,
  activityType: LiveActivityType,
  start: LiveActivityStartInput,
): Promise<boolean> {
  if (!apnsConfigured()) return false;
  const row = await prisma.liveActivityToken.findUnique({
    where: {
      userId_activityType_kind: { userId, activityType, kind: "start" },
    },
    select: { id: true, token: true },
  });
  if (!row) return false;

  const result = await sendApnsNotification(row.token, buildLiveActivityStartPayload(start), {
    pushType: "liveactivity",
  });
  if (tokenIsDead(result)) {
    await prisma.liveActivityToken.delete({ where: { id: row.id } }).catch(() => undefined);
    return false;
  }
  if (!result.ok) {
    console.warn(
      `[push] live-activity ${activityType} start failed for ${userId}: ${result.status} ${result.reason}`,
    );
  }
  return result.ok;
}
