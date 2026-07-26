import { prisma } from "@gennety/db";

/**
 * Data-retention sweep (audit DATA-1).
 *
 * Four tables accumulated rows forever: nothing in the codebase deleted from
 * `email_otps`, `phone_otps`, `user_sessions`, or `proxy_messages`, and no cron
 * touched them. `selfie-retention` was the only retention job and it covers the
 * reference selfie alone.
 *
 * The growth is the smaller half of the problem. The privacy half is
 * `phone_otps`: it stores E.164 phone numbers keyed by NUMBER, not by user,
 * because the funnel starts before a `User` row exists. Numbers belonging to
 * people who never finished signing up therefore have no row for the GDPR
 * deletion cascade to reach, and were retained indefinitely.
 *
 * Deletion is batched per tick so one run can never take a long table lock or
 * blow up a transaction; the sweep simply catches up over subsequent hours.
 */

/**
 * OTP challenges. The codes themselves live 10 minutes, the resend cooldown is
 * under a minute, and the durable per-phone daily cap only looks back 24 hours,
 * so a week is already far past anything the flow reads.
 */
export const OTP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Refresh sessions, counted from the moment the row stopped being usable
 * (revoked or expired).
 *
 * **Chosen deliberately to preserve refresh-token reuse detection.**
 * `rotateRefreshToken` detects a stolen token by finding an already-REVOKED
 * session by its hash and then revoking the user's whole session family
 * (RFC 6749 §10.4). Delete revoked rows too eagerly and that defence silently
 * degrades to "token not found" — the attacker is refused, but the legitimate
 * user is never logged out and never learns anything happened. 30 days matches
 * `JWT_REFRESH_TTL` (30d), so a token is retained for detection across its
 * entire plausible lifetime. If `JWT_REFRESH_TTL` is ever raised, raise this
 * with it.
 */
export const SESSION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Relayed pre-date proxy-chat messages.
 *
 * PRODUCT_SPEC names this log as the justification for the narrow carve-out to
 * the NO-IN-APP-CHAT invariant ("every message logged, in-line Report button"),
 * so the window is a moderation-policy choice, not a technical one. 90 days
 * matches the GDPR window already used for reference selfies and comfortably
 * outlives the report/strike flow that would need to read it.
 */
export const PROXY_MESSAGE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows removed per table per tick. */
const BATCH_LIMIT = 1_000;

export interface RetentionSweepResult {
  emailOtps: number;
  phoneOtps: number;
  sessions: number;
  proxyMessages: number;
}

/**
 * Delete at most `BATCH_LIMIT` rows matching `where`, oldest first.
 *
 * Prisma's `deleteMany` takes no `take`, so the batch is selected first and
 * deleted by id. That also keeps the delete off any index-less predicate.
 */
async function deleteOldest(
  findIds: (take: number) => Promise<Array<{ id: string }>>,
  deleteByIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  const rows = await findIds(BATCH_LIMIT);
  if (rows.length === 0) return 0;
  const { count } = await deleteByIds(rows.map((r) => r.id));
  return count;
}

export async function retentionTick(
  now: Date = new Date(),
): Promise<RetentionSweepResult> {
  const otpCutoff = new Date(now.getTime() - OTP_RETENTION_MS);
  const sessionCutoff = new Date(now.getTime() - SESSION_RETENTION_MS);
  const proxyCutoff = new Date(now.getTime() - PROXY_MESSAGE_RETENTION_MS);

  const emailOtps = await deleteOldest(
    (take) =>
      prisma.emailOtp.findMany({
        where: { createdAt: { lt: otpCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.emailOtp.deleteMany({ where: { id: { in: ids } } }),
  );

  const phoneOtps = await deleteOldest(
    (take) =>
      prisma.phoneOtp.findMany({
        where: { createdAt: { lt: otpCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.phoneOtp.deleteMany({ where: { id: { in: ids } } }),
  );

  const sessions = await deleteOldest(
    (take) =>
      prisma.userSession.findMany({
        // A row is only removable once it is BOTH unusable and past the
        // detection window: a live session must never be swept, and a revoked
        // one is still evidence for reuse detection until the window closes.
        where: {
          expiresAt: { lt: sessionCutoff },
          OR: [{ revokedAt: null }, { revokedAt: { lt: sessionCutoff } }],
        },
        select: { id: true },
        orderBy: { expiresAt: "asc" },
        take,
      }),
    (ids) => prisma.userSession.deleteMany({ where: { id: { in: ids } } }),
  );

  const proxyMessages = await deleteOldest(
    (take) =>
      prisma.proxyMessage.findMany({
        where: { createdAt: { lt: proxyCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.proxyMessage.deleteMany({ where: { id: { in: ids } } }),
  );

  const total = emailOtps + phoneOtps + sessions + proxyMessages;
  if (total > 0) {
    console.log(
      `[retention] emailOtps=${emailOtps} phoneOtps=${phoneOtps} ` +
        `sessions=${sessions} proxyMessages=${proxyMessages}`,
    );
  }
  return { emailOtps, phoneOtps, sessions, proxyMessages };
}
