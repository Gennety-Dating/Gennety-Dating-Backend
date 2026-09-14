import { prisma } from "@gennety/db";
import { revokeAllSessions, revokeRefreshSession } from "../public/jwt.js";

/**
 * Push credentials belong to a DEVICE, not to an account (audit A13-L12).
 *
 * APNs hands one install one device token, and an ActivityKit push-to-start
 * token is per install too. When a second account signs in on the same phone,
 * that phone registers the same token for the new account — and the old row
 * kept it: the previous owner's matches, date reminders and verification
 * verdicts went on landing on a lock screen that now belongs to somebody else.
 * And there was no sign-out at all that could have let go of it.
 *
 * So registration moves the token rather than copying it, and signing out
 * releases everything this device was receiving along with the session.
 */

/**
 * Register `token` for `userId` and take it away from any other account still
 * holding it. One transaction, so there is no moment at which two accounts
 * both receive pushes on the device.
 */
export async function registerPushToken(
  userId: string,
  token: string,
  platform: string,
): Promise<void> {
  await prisma.$transaction([
    prisma.user.updateMany({
      where: { pushToken: token, id: { not: userId } },
      data: { pushToken: null, pushPlatform: null },
    }),
    prisma.user.update({
      where: { id: userId },
      data: { pushToken: token, pushPlatform: platform },
    }),
  ]);
}

/**
 * Drop `token` from every other account's Live Activity registrations. Called
 * before the caller's own upsert: a Live Activity is a lock-screen surface, and
 * the previous account's "date day" must not keep updating on this phone.
 */
export async function releaseLiveActivityTokenFromOtherUsers(
  userId: string,
  token: string,
): Promise<void> {
  await prisma.liveActivityToken.deleteMany({
    where: { token, userId: { not: userId } },
  });
}

/**
 * Sign this device out of `userId`: stop every push it was receiving for the
 * account, and end the refresh session it presents — or every session, when it
 * presents none, since a client that cannot name its own session is asking to
 * be signed out everywhere.
 *
 * The access token it already holds is stateless and lives out its short TTL;
 * without a refresh session it cannot be renewed.
 */
export async function signOutDevice(
  userId: string,
  refreshToken: string | null,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    // `updateMany`, not `update`: signing out an account that was deleted a
    // moment ago is a no-op, not an error.
    await tx.user.updateMany({
      where: { id: userId },
      data: { pushToken: null, pushPlatform: null },
    });
    await tx.liveActivityToken.deleteMany({ where: { userId } });
    if (refreshToken) {
      await revokeRefreshSession(userId, refreshToken, tx);
    } else {
      await revokeAllSessions(userId, tx);
    }
  });
}
