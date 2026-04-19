import { Expo, type ExpoPushMessage, type ExpoPushTicket } from "expo-server-sdk";
import { prisma } from "@gennety/db";
import { env } from "../config.js";

/**
 * Expo Push dispatcher.
 *
 * The bot-side notification layer still uses Telegram DMs; this module is
 * used only for mobile (`User.platform === "mobile"`) users. Callers pass
 * an internal `userId` and we look up their cached `pushToken` on the
 * `User` row (registered via POST /v1/me/push-token).
 *
 * Invalid / stale tokens get cleared automatically so we don't keep
 * spamming dead devices — Expo returns `DeviceNotRegistered` tickets for
 * those.
 */

let client: Expo | null = null;

function getClient(): Expo {
  if (!client) {
    client = new Expo({
      ...(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {}),
    });
  }
  return client;
}

export interface PushPayload {
  title: string;
  body: string;
  /** Custom JSON blob forwarded to the Expo client — e.g. deep-link data. */
  data?: Record<string, unknown>;
}

/**
 * Send a push to a single mobile user. Resolves to `true` if Expo accepted
 * the ticket. No-op (resolves `false`) when the user has no token, isn't
 * on mobile, or the token is malformed.
 */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<boolean> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { pushToken: true, platform: true },
  });
  if (!user?.pushToken) return false;
  if (!Expo.isExpoPushToken(user.pushToken)) {
    // Silent purge of malformed tokens.
    await prisma.user.update({ where: { id: userId }, data: { pushToken: null } });
    return false;
  }

  const message: ExpoPushMessage = {
    to: user.pushToken,
    sound: "default",
    title: payload.title,
    body: payload.body,
    ...(payload.data ? { data: payload.data } : {}),
  };

  try {
    const chunks = getClient().chunkPushNotifications([message]);
    for (const chunk of chunks) {
      const tickets = await getClient().sendPushNotificationsAsync(chunk);
      await handleTickets(userId, tickets);
    }
    return true;
  } catch (err) {
    console.warn("[push] sendPushToUser failed:", err);
    return false;
  }
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

/**
 * Clear tokens that Expo told us are dead. We only check `status === "error"`
 * + common `DeviceNotRegistered` details; other errors (rate-limit, payload
 * too big) are transient and should not wipe the token.
 */
async function handleTickets(
  userId: string,
  tickets: ExpoPushTicket[],
): Promise<void> {
  for (const ticket of tickets) {
    if (ticket.status !== "error") continue;
    const errCode = ticket.details?.error;
    if (errCode === "DeviceNotRegistered") {
      await prisma.user
        .update({ where: { id: userId }, data: { pushToken: null } })
        .catch(() => undefined);
      return;
    }
    console.warn(`[push] ticket error for user ${userId}: ${ticket.message}`);
  }
}
