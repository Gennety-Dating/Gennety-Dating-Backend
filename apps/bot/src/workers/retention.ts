import { prisma } from "@gennety/db";
import {
  FREQUENT_PLACE_WINDOW_DAYS,
  INBOX_RETENTION_DAYS,
  SAFETY_TOMBSTONE_RETENTION_MONTHS,
} from "@gennety/shared";
import { deleteStaleRhythms } from "../services/rhythm/store.js";

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

/**
 * Frequently-visited-places days (`user_place_visits`, 2026-09-11).
 *
 * Not a policy of its own: the ranking never looks past its window, so a day
 * older than that can no longer change anything a person or their match sees,
 * and keeping it would be holding where someone was for no reader at all. Tied
 * to the shared window constant so the two cannot drift apart.
 */
export const PLACE_VISIT_RETENTION_DAYS = FREQUENT_PLACE_WINDOW_DAYS;

/**
 * Safety tombstones (`safety_tombstones`, A13-H14) and the records that exist
 * only because of them.
 *
 * A tombstone lets a deleted account's ban, strikes, and the reports and blocks
 * filed against it follow the same person back if they re-register. The
 * privacy policy promises it for `SAFETY_TOMBSTONE_RETENTION_MONTHS`, counted
 * from the deletion. When the last tombstone of a former account goes, the
 * report and block rows that were waiting to be relinked to it can never be
 * relinked — and they carry another person's account of that account — so they
 * go in the same sweep. A report or block whose subject was removed without a
 * tombstone at all (a path that bypassed `deleteUserAccount`) is the same dead
 * end and is cleared the same way.
 */
export function safetyTombstoneCutoff(now: Date): Date {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - SAFETY_TOMBSTONE_RETENTION_MONTHS);
  return cutoff;
}

/** Rows removed per query. Small enough that one `IN (…)` delete stays cheap. */
const BATCH_LIMIT = 1_000;

/**
 * Batches one table may take in a single sweep, before the sweep gives up and
 * says so.
 *
 * The sweep used to take exactly ONE batch per table per day. That is not a
 * retention policy, it is a rounding error: `chat_events` alone is written on
 * every inbound and outbound message, so any real traffic outruns 1000 rows a
 * day and the table then grows forever — with the retention promise unkept, the
 * GDPR erasure window quietly missed, and the same table later read whole by
 * the admin dashboards.
 *
 * So the sweep now runs until the table is clean. The cap exists only so a
 * pathological backlog cannot pin the droplet's single core for hours: at
 * 1000 rows a batch it clears half a million rows per table per night, which is
 * several times the projected write rate, and hitting it is logged as the
 * warning it is rather than passing silently.
 */
const MAX_BATCHES_PER_TABLE = 500;

export interface RetentionSweepResult {
  emailOtps: number;
  phoneOtps: number;
  sessions: number;
  proxyMessages: number;
  chatEvents: number;
  clientEvents: number;
  eventFeedback: number;
  placeVisits: number;
  /** Life-rhythm profiles not synced for 35 days (Tempo Sync). */
  rhythmProfiles: number;
  inboxItems: number;
  orphanBotSessions: number;
  safetyTombstones: number;
  orphanReports: number;
  orphanBlocks: number;
}

/**
 * Delete every row matching `where`, oldest first, in batches of `BATCH_LIMIT`.
 *
 * Prisma's `deleteMany` takes no `take`, so each batch is selected first and
 * deleted by id. That also keeps the delete off any index-less predicate.
 *
 * A short batch means the table is clean and the loop stops; the batch count is
 * capped so one enormous backlog cannot occupy the whole night (see
 * `MAX_BATCHES_PER_TABLE`).
 */
async function deleteOldest(
  label: string,
  findIds: (take: number) => Promise<Array<{ id: string }>>,
  deleteByIds: (ids: string[]) => Promise<{ count: number }>,
): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const rows = await findIds(BATCH_LIMIT);
    if (rows.length === 0) return removed;
    const { count } = await deleteByIds(rows.map((r) => r.id));
    removed += count;
    // A batch that came back short exhausted the cutoff — nothing older is
    // left. Stop before spending another query proving it.
    if (rows.length < BATCH_LIMIT) return removed;
  }
  console.warn(
    `[retention] ${label}: stopped at the ${MAX_BATCHES_PER_TABLE}-batch cap after ${removed} rows — ` +
      "rows older than the cutoff remain and the next sweep will continue",
  );
  return removed;
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
    "email_otps",
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
    "phone_otps",
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
    "user_sessions",
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
    "proxy_messages",
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
    "chat_events",
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
    "client_events",
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
    "event_feedback",
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

  // `visit_day` is a calendar DATE, so the cutoff is a UTC midnight: a row is
  // swept the night its day passes the window, give or take the timezone hour.
  const placeVisitCutoff = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) -
      PLACE_VISIT_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const placeVisits = await deleteOldest(
    "user_place_visits",
    (take) =>
      prisma.userPlaceVisit.findMany({
        where: { visitDay: { lt: placeVisitCutoff } },
        select: { id: true },
        orderBy: { visitDay: "asc" },
        take,
      }),
    (ids) => prisma.userPlaceVisit.deleteMany({ where: { id: { in: ids } } }),
  );

  // The bell's inbox (decision journal 2026-09-13). Ninety days is longer than
  // anything on it stays relevant — a proposal expires in a day, a party is
  // over in a week — and the chip in a chat transcript keeps its own title
  // snapshot, so sweeping the row never blanks a conversation.
  // Tempo Sync life rhythm: invisible to every reader after 35 days without a
  // sync, so it is deleted too — health-derived data kept for nothing is the
  // worst kind to keep (decision journal 2026-09-24).
  const rhythmProfiles = await deleteStaleRhythms(now);

  const inboxCutoff = new Date(now.getTime() - INBOX_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const inboxItems = await deleteOldest(
    "inbox_items",
    (take) =>
      prisma.inboxItem.findMany({
        where: { createdAt: { lt: inboxCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.inboxItem.deleteMany({ where: { id: { in: ids } } }),
  );

  // Raw, because there is no relation to traverse: the join is
  // `users.telegram_id::text = bot_sessions.key`, which is exactly the coupling
  // the schema does not express. Anti-join rather than "load all keys and diff
  // in Node" so the work stays in Postgres and the batch limit is real.
  const orphanCutoff = new Date(now.getTime() - ORPHAN_SESSION_RETENTION_MS);
  // Batched to exhaustion like every other table above: one batch a night left
  // orphans accumulating whenever more than `BATCH_LIMIT` of them appeared in a
  // day, and this is the one sweep no other code path ever repeats.
  let orphanBotSessions = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const removed = await prisma.$executeRaw`
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
    orphanBotSessions += removed;
    if (removed < BATCH_LIMIT) break;
    if (batch === MAX_BATCHES_PER_TABLE - 1) {
      console.warn(
        `[retention] bot_sessions: stopped at the ${MAX_BATCHES_PER_TABLE}-batch cap after ` +
          `${orphanBotSessions} rows — orphans remain and the next sweep will continue`,
      );
    }
  }

  const tombstoneCutoff = safetyTombstoneCutoff(now);
  const safetyTombstones = await deleteOldest(
    "safety_tombstones",
    (take) =>
      prisma.safetyTombstone.findMany({
        where: { createdAt: { lt: tombstoneCutoff } },
        select: { id: true },
        orderBy: { createdAt: "asc" },
        take,
      }),
    (ids) => prisma.safetyTombstone.deleteMany({ where: { id: { in: ids } } }),
  );

  // Raw for the anti-join: "no tombstone left for this former id" is not a
  // relation Prisma can express. After the tombstone sweep above, so a former
  // account whose last tombstone just expired is cleared in the same night.
  const orphanReports = await deleteInRawBatches("reports", () =>
    prisma.$executeRaw`
      DELETE FROM reports
      WHERE id IN (
        SELECT r.id
        FROM reports r
        WHERE r.reported_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM safety_tombstones t WHERE t.former_user_id = r.reported_former_id
          )
        LIMIT ${BATCH_LIMIT}
      )
    `,
  );
  const orphanBlocks = await deleteInRawBatches("user_blocks", () =>
    prisma.$executeRaw`
      DELETE FROM user_blocks
      WHERE id IN (
        SELECT b.id
        FROM user_blocks b
        WHERE b.blocked_id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM safety_tombstones t WHERE t.former_user_id = b.blocked_former_id
          )
        LIMIT ${BATCH_LIMIT}
      )
    `,
  );

  const total =
    emailOtps +
    phoneOtps +
    sessions +
    proxyMessages +
    chatEvents +
    clientEvents +
    eventFeedback +
    placeVisits +
    rhythmProfiles +
    inboxItems +
    orphanBotSessions +
    safetyTombstones +
    orphanReports +
    orphanBlocks;
  if (total > 0) {
    console.log(
      `[retention] emailOtps=${emailOtps} phoneOtps=${phoneOtps} ` +
        `sessions=${sessions} proxyMessages=${proxyMessages} chatEvents=${chatEvents} ` +
        `clientEvents=${clientEvents} eventFeedback=${eventFeedback} ` +
        `placeVisits=${placeVisits} rhythmProfiles=${rhythmProfiles} inboxItems=${inboxItems} ` +
        `orphanBotSessions=${orphanBotSessions} ` +
        `safetyTombstones=${safetyTombstones} orphanReports=${orphanReports} orphanBlocks=${orphanBlocks}`,
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
    placeVisits,
    rhythmProfiles,
    inboxItems,
    orphanBotSessions,
    safetyTombstones,
    orphanReports,
    orphanBlocks,
  };
}

/**
 * Run a raw `DELETE … WHERE id IN (SELECT … LIMIT BATCH_LIMIT)` until a batch
 * comes back short, capped like `deleteOldest`.
 */
async function deleteInRawBatches(
  label: string,
  deleteBatch: () => Promise<number>,
): Promise<number> {
  let removed = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch += 1) {
    const count = await deleteBatch();
    removed += count;
    if (count < BATCH_LIMIT) return removed;
  }
  console.warn(
    `[retention] ${label}: stopped at the ${MAX_BATCHES_PER_TABLE}-batch cap after ${removed} rows — ` +
      "orphans remain and the next sweep will continue",
  );
  return removed;
}
