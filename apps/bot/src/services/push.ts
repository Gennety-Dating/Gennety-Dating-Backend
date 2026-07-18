import { prisma } from "@gennety/db";
import {
  apnsConfigured,
  buildAlertPayload,
  buildLiveActivityPayload,
  sendApnsNotification,
  type LiveActivityUpdateInput,
} from "./apns.js";

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
  /** Custom JSON forwarded to the client alongside `aps` — deep-link data. */
  data?: Record<string, unknown>;
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
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushToken: true },
  });
  if (!user?.pushToken) return false;
  if (!apnsConfigured()) {
    console.warn("[push] APNs not configured — dropping push for", userId);
    return false;
  }

  const result = await sendApnsNotification(user.pushToken, buildAlertPayload(payload), {
    pushType: "alert",
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

export type LiveActivityType = "match_decision" | "date_day";

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
): Promise<boolean> {
  if (!apnsConfigured()) return false;
  const row = await prisma.liveActivityToken.findUnique({
    where: {
      userId_activityType_kind: { userId, activityType, kind: "update" },
    },
    select: { id: true, token: true },
  });
  if (!row) return false;

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
