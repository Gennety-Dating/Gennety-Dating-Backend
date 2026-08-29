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
 * A fifth target was added 2026-08-08: `bot_sessions` rows whose account is
 * gone. That table has no relation to `users` at all, so nothing cascades into
 * it and no window applies to it — see `ORPHAN_SESSION_RETENTION_MS` below.
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

/**
 * Chat-timeline events (`ChatEvent`).
 *
 * The timeline exists so the concierge agent can answer a follow-up against
 * the message right above it — a question of minutes, occasionally days. It is
 * not an archive, and it holds message text, so the window is the shortest of
 * the four: a month is already far beyond anything the agent reads (12 events
 * per turn) while still covering a date planned a couple of weeks out.
 */
export const CHAT_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Клиентская воронка нативного приложения (`client_events`, iOS 6.2).
 *
 * 90 дней — не техническая величина, а обещание: столько заявлено в privacy
 * manifest приложения и в анкете App Privacy, и срок здесь существует затем,
 * чтобы это заявление было правдой. Воронка читается когортами по неделям, то
 * есть квартал перекрывает любой осмысленный вопрос к ней с запасом.
 *
 * Строки авторизованных людей уходят и раньше — каскадом при удалении
 * аккаунта. Этот срок закрывает то, до чего каскаду не дотянуться: события,
 * снятые до того, как аккаунт вообще появился.
 */
export const CLIENT_EVENT_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/**
 * Chat sessions whose account no longer exists.
 *
 * `bot_sessions` is keyed by Telegram CHAT id with no relation to `users`, so
 * it is the one store a Prisma cascade cannot reach. `deleteUserAccount` erases
 * it directly (2026-08-08), but that is forward-only: production still carried
 * five orphans from before it, and any future path that removes a user without
 * going through that service would make more.
 *
 * Worth sweeping rather than leaving, on both counts the direct fix was made
 * for: the row holds `pendingPhotos` (Telegram file_ids of an erased profile),
 * a buffered AI-memory paste and `activeMatchId` — so leaving it is incomplete
 * erasure — and the NEXT account in that chat inherits the state, which is how
 * a stale `expectingPhoto: true` once dropped a brand-new user into the photo
 * stage several questions early.
 *
 * The age floor is not decoration. `sessionMiddleware` runs before the handler
 * that creates the `User` row, so a chat mid-`/start` legitimately has a session
 * and no user for a moment; without a floor this sweep would race registration
 * and delete a live session. A week is far past that and far short of mattering
 * for cleanup.
 */
export const ORPHAN_SESSION_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Post-event feedback (`event_feedback`, LAUNCH_EVENTS §11).
 *
 * It holds a person's free-text account of an evening, which is the same class
 * of content as a relayed proxy message and gets the same 90 days.
 *
 * **`unsafe` is exempt, and that is the load-bearing half.** The row IS the
 * moderation queue entry for a safety flag (§10), so sweeping it on a timer
 * would silently close an open case — and this product already keeps `reports`
 * indefinitely for exactly that reason. An unreviewed safety report piling up
 * forever is the correct failure direction; a quietly-expiring one is not.
 */
export const EVENT_FEEDBACK_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Rows removed per table per tick. */
const BATCH_LIMIT = 1_000;

export interface RetentionSweepResult {
  emailOtps: number;
  phoneOtps: number;
  sessions: number;
  proxyMessages: number;
  chatEvents: number;
  clientEvents: number;
  eventFeedback: number;
  orphanBotSessions: number;
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
  const chatEventCutoff = new Date(now.getTime() - CHAT_EVENT_RETENTION_MS);
  const clientEventCutoff = new Date(now.getTime() - CLIENT_EVENT_RETENTION_MS);
  const eventFeedbackCutoff = new Date(now.getTime() - EVENT_FEEDBACK_RETENTION_MS);

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

  const chatEvents = await deleteOldest(
    (take) =>
      prisma.chatEvent.findMany({
        where: { createdAt: { lt: chatEventCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.chatEvent.deleteMany({ where: { id: { in: ids } } }),
  );

  // Считается по `receivedAt`, а не по `occurredAt`: вторая — часы устройства,
  // и телефон со сбитой датой иначе либо пережил бы ретеншен, либо был бы
  // стёрт в день приёма.
  const clientEvents = await deleteOldest(
    (take) =>
      prisma.clientEvent.findMany({
        where: { receivedAt: { lt: clientEventCutoff } },
        select: { id: true },
        orderBy: { receivedAt: "asc" },
        take,
      }),
    (ids) => prisma.clientEvent.deleteMany({ where: { id: { in: ids } } }),
  );

  const eventFeedback = await deleteOldest(
    (take) =>
      prisma.eventFeedback.findMany({
        // `safety: "unsafe"` never ages out — see EVENT_FEEDBACK_RETENTION_MS.
        // Written as "not unsafe OR null" rather than `not: "unsafe"` because
        // in SQL a NULL comparison is neither, and most rows carry no safety
        // answer at all: `NOT (safety = 'unsafe')` would silently retain every
        // one of them forever.
        where: {
          createdAt: { lt: eventFeedbackCutoff },
          OR: [{ safety: null }, { safety: { not: "unsafe" } }],
        },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.eventFeedback.deleteMany({ where: { id: { in: ids } } }),
  );

  // Raw, because there is no relation to traverse: the join is
  // `users.telegram_id::text = bot_sessions.key`, which is exactly the coupling
  // the schema does not express. Anti-join rather than "load all keys and diff
  // in Node" so the work stays in Postgres and the batch limit is real.
  const orphanCutoff = new Date(now.getTime() - ORPHAN_SESSION_RETENTION_MS);
  const orphanBotSessions = await prisma.$executeRaw`
    DELETE FROM bot_sessions
    WHERE key IN (
      SELECT b.key
      FROM bot_sessions b
      LEFT JOIN users u ON u.telegram_id::text = b.key
      WHERE u.id IS NULL
        AND b.updated_at < ${orphanCutoff}
      ORDER BY b.updated_at ASC
      LIMIT ${BATCH_LIMIT}
    )
  `;

  const total =
    emailOtps +
    phoneOtps +
    sessions +
    proxyMessages +
    chatEvents +
    clientEvents +
    eventFeedback +
    orphanBotSessions;
  if (total > 0) {
    console.log(
      `[retention] emailOtps=${emailOtps} phoneOtps=${phoneOtps} ` +
        `sessions=${sessions} proxyMessages=${proxyMessages} chatEvents=${chatEvents} ` +
        `clientEvents=${clientEvents} eventFeedback=${eventFeedback} ` +
        `orphanBotSessions=${orphanBotSessions}`,
    );
  }
  return {
    emailOtps,
    phoneOtps,
    sessions,
    proxyMessages,
    chatEvents,
    clientEvents,
    eventFeedback,
    orphanBotSessions,
  };
}
