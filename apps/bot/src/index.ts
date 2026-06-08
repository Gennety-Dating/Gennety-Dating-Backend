// MUST be the first import: triggers .env.local → .env load BEFORE
// `@gennety/db` evaluates `new PrismaClient()`. Prisma's own dotenv loader
// would otherwise read .env first, set DATABASE_URL to the prod URL in
// process.env, and silently shadow .env.local (dotenv defaults to non-
// override). Reordering this line breaks local dev — bot then hits prod.
import "./config.js";

import cron from "node-cron";
import { ensureMatchPairIndex } from "@gennety/db";
import { env } from "./config.js";
import { createBot } from "./bot.js";
import { autoUnsuspendElapsed, runWeeklyBatch } from "./services/match-engine.js";
import { dispatchMatches } from "./services/dispatch-queue.js";
import { sendNoMatchNotices } from "./services/no-match-notifier.js";
import { expireStaleMatches } from "./services/match-expiry.js";
import { sendExpiryNotifications } from "./services/expiry-notify.js";
import { runDateLifecycleTick } from "./services/date-lifecycle.js";
import { runPreDateSafetyTick } from "./services/pre-date-safety.js";
import { runCoordinationTick } from "./services/coordination.js";
import { startAdminServer } from "./admin/server.js";
import { startPublicServer } from "./public/server.js";
import { reEngagementTick } from "./workers/re-engagement.js";
import { profilerTick } from "./workers/profiler.js";
import { matchNudgeTick } from "./workers/match-nudge.js";
import { proposalCountdownTick } from "./workers/proposal-countdown.js";
import { preMatchAnnounceTick } from "./workers/pre-match-announce.js";
import { statusTimerTick } from "./workers/status-timer.js";
import { embeddingRefreshTick } from "./workers/embedding-refresh.js";
import { ticketExpiryTick } from "./workers/ticket-expiry.js";
import { runSelfieRetention } from "./services/selfie-retention.js";
import { venueRevalidationTick } from "./services/venue-revalidation.js";
import { guardedTick } from "./utils/guarded-tick.js";

/* ── Process-level crash guard ─────────────────────────────── */
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[FATAL] unhandledRejection:", reason);
});

const bot = createBot(env.BOT_TOKEN);

const DATE_LIFECYCLE_TICK_MS = Number(process.env.DATE_LIFECYCLE_TICK_MS ?? 2 * 60 * 1000);

/**
 * Weekly matching cron schedule. Default: Thursday at 18:00 Europe/Kyiv.
 * Override via MATCH_CRON_SCHEDULE env var for testing.
 */
const MATCH_CRON_SCHEDULE = process.env.MATCH_CRON_SCHEDULE ?? "0 18 * * 4";

/** Timezone all weekly cron jobs are anchored to. */
const CRON_TIMEZONE = process.env.CRON_TIMEZONE ?? "Europe/Kyiv";

/**
 * Expiry cron schedule. Runs every 15 minutes to expire proposals
 * that have been dispatched but not mutually accepted within 24 hours.
 */
const EXPIRY_CRON_SCHEDULE = process.env.EXPIRY_CRON_SCHEDULE ?? "*/15 * * * *";

/**
 * "No match this week" empathetic DM. Default: Thursday 18:15 Kyiv —
 * 15 minutes after the matching batch so dispatched users get a moment
 * with their pitch before unmatched users receive the consolation note.
 * Re-runs are safe (`@@unique([userId, dropDate])` on `NoMatchNotice`).
 */
const NO_MATCH_NOTICE_CRON_SCHEDULE =
  process.env.NO_MATCH_NOTICE_CRON_SCHEDULE ?? "15 18 * * 4";

/**
 * Proposal-countdown cron: every 5 minutes. The renderer's ceil-hours /
 * raw-minutes split (in `countdown-plate.ts`) converts this into 1 edit
 * per match-side per hour during the first 23 hours, then 1 edit every
 * 5 minutes during the final hour — matching the product cadence.
 */
const PROPOSAL_COUNTDOWN_CRON_SCHEDULE =
  process.env.PROPOSAL_COUNTDOWN_CRON_SCHEDULE ?? "*/5 * * * *";

/**
 * Re-engagement cron: every 5 minutes. The worker picks users whose
 * precomputed `reEngagementNextAt` has passed, so frequent ticks are cheap
 * (a single indexed query) and let us honour the +15 min first touch with
 * ±5 min granularity. Quiet hours 23:00–09:00 Kyiv are enforced inside
 * `computeNextTouch()`, not here.
 */
const RE_ENGAGEMENT_CRON_SCHEDULE = process.env.RE_ENGAGEMENT_CRON_SCHEDULE ?? "*/5 * * * *";

/**
 * Match nudge cron: every hour.
 * Fires proposal nudges (3h / 10h) and scheduling nudges (6h / 12h).
 * Quiet hours enforced inside the worker.
 */
const MATCH_NUDGE_CRON_SCHEDULE = process.env.MATCH_NUDGE_CRON_SCHEDULE ?? "0 * * * *";

/**
 * Pre-match announce: Wednesday 18:00 Europe/Kyiv (24h before Thursday batch).
 * Sends a warm teaser to all active users who haven't been announced to this week.
 */
const PRE_MATCH_ANNOUNCE_CRON_SCHEDULE = process.env.PRE_MATCH_ANNOUNCE_CRON_SCHEDULE ?? "0 18 * * 3";

/**
 * Pinned status banner (live discrete timer). Runs every minute so the
 * "Xd Yh" / "Xh Ym" / "Xm" text visibly ticks down between user glances.
 * The worker de-dups via an in-memory render cache, so unchanged banners
 * don't hit Telegram at all — only real transitions consume API quota.
 */
const STATUS_TIMER_CRON_SCHEDULE = process.env.STATUS_TIMER_CRON_SCHEDULE ?? "* * * * *";

/** Dispatch delay between pitch sends (ms). Default: 2s = ~30/min. */
const DISPATCH_DELAY_MS = Number(process.env.DISPATCH_DELAY_MS ?? 2000);

/**
 * M-6: hourly auto-unsuspend. The expiration check used to live ONLY inside
 * `runWeeklyBatch`, which meant a 14-day suspension that expired on a Friday
 * morning sat for another 6 days until the next Thursday batch. Running it
 * hourly keeps the lag below an hour without thrashing the DB.
 */
const AUTO_UNSUSPEND_CRON_SCHEDULE =
  process.env.AUTO_UNSUSPEND_CRON_SCHEDULE ?? "0 * * * *";

/**
 * M-2: embedding-refresh. Scans dirty profiles every 5 minutes and rebuilds
 * their pgvector embedding via the OpenAI embeddings API. Pre-M-2 the
 * embedding silently went stale on every profile edit, slowly degrading
 * match quality. Capped at 20 rows/tick to bound cost on a busy edit hour.
 */
const EMBEDDING_REFRESH_CRON_SCHEDULE =
  process.env.EMBEDDING_REFRESH_CRON_SCHEDULE ?? "*/5 * * * *";

/**
 * Verified-selfie retention: GDPR Article 9 requires biometric data is
 * stored "no longer than necessary". We scrub stored selfies (the
 * Persona-captured image used as face-match reference) 90 days after
 * `verifiedAt`. Daily at 03:30 Europe/Kyiv — off-peak, doesn't share
 * the hour with the weekly matching cron.
 */
const SELFIE_RETENTION_CRON_SCHEDULE =
  process.env.SELFIE_RETENTION_CRON_SCHEDULE ?? "30 3 * * *";

/**
 * Curated-venue re-validation: re-check the oldest-verified active venues
 * against Google Places, deactivating closures / rating drops and refreshing
 * opening hours. Daily at 04:00 Europe/Kyiv — off-peak, after selfie-retention.
 */
const VENUE_REVALIDATION_CRON_SCHEDULE =
  process.env.VENUE_REVALIDATION_CRON_SCHEDULE ?? "0 4 * * *";

/**
 * Date Ticket expiry sweep. Refunds stalled `partial` ticket payments and
 * opens the Calendar for free so an accepted match is never wedged behind a
 * paywall. Hourly. No-op when TICKET_FEATURE_ENABLED is off (no ticket rows
 * are ever in pending/partial).
 */
const TICKET_EXPIRY_CRON_SCHEDULE =
  process.env.TICKET_EXPIRY_CRON_SCHEDULE ?? "0 * * * *";

/**
 * Profiler scheduler (Phase 1b). Every 15 min: lazy-seed never-armed users and
 * dispatch due Profiler batches (morning/evening windows in the user's local
 * time). Cheap when idle.
 */
const PROFILER_CRON_SCHEDULE =
  process.env.PROFILER_CRON_SCHEDULE ?? "*/15 * * * *";

/**
 * Weekly batch: run the global greedy matching algorithm, then dispatch
 * all pitches via the rate-limited queue.
 */
async function weeklyMatchingJob(): Promise<void> {
  try {
    console.log("[cron] Weekly matching batch started");
    const result = await runWeeklyBatch();
    console.log(
      `[cron] Batch complete: eligible=${result.eligible} pairs=${result.pairs}`,
    );

    if (result.matchIds.length > 0) {
      console.log(`[cron] Dispatching ${result.matchIds.length} pitches...`);
      const dispatch = await dispatchMatches(bot.api, result.matchIds, DISPATCH_DELAY_MS);
      console.log(
        `[cron] Dispatch complete: sent=${dispatch.dispatched} failed=${dispatch.failed}`,
      );
    }

    if (result.missedUserIds.length > 0) {
      // The empathetic "no match this week" DM goes out via the
      // `NO_MATCH_NOTICE_CRON_SCHEDULE` cron (default 18:15 Kyiv) — kept
      // separate so users get a brief breather between the dispatch
      // wave and the consolation message instead of both at once.
      console.log(
        `[cron] ${result.missedUserIds.length} user(s) unmatched — handled by no-match-notice cron`,
      );
    }
  } catch (err) {
    console.error("[cron] Weekly matching job failed:", err);
  }
}

/**
 * Expiry job: mark stale proposed matches as expired after 24h TTL,
 * then DM both sides — the silent user gets a warning (or penalty
 * confirmation on repeat offense) and the responder is told their match
 * ignored them.
 */
async function expiryJob(): Promise<void> {
  try {
    const result = await expireStaleMatches();
    if (result.expired > 0) {
      console.log(`[cron] Expired ${result.expired} stale matches`);
      const notify = await sendExpiryNotifications(bot.api, result.matches);
      console.log(
        `[cron] Expiry notify: notified=${notify.notified} skipped=${notify.skipped} failed=${notify.failed}`,
      );
    }
  } catch (err) {
    console.error("[cron] Expiry job failed:", err);
  }
}

async function dateLifecycleTick(): Promise<void> {
  try {
    const [lifecycle, safety, coordination] = await Promise.all([
      runDateLifecycleTick(bot.api),
      runPreDateSafetyTick(bot.api),
      runCoordinationTick(bot.api),
    ]);
    if (
      lifecycle.icebreakers > 0 ||
      lifecycle.emergencies > 0 ||
      lifecycle.feedbacks > 0 ||
      safety.sent > 0
    ) {
      console.log(
        `[date-lifecycle] icebreakers=${lifecycle.icebreakers} emergencies=${lifecycle.emergencies} feedbacks=${lifecycle.feedbacks} safety=${safety.sent}`,
      );
    }
    if (coordination.offers > 0 || coordination.opened > 0 || coordination.closed > 0) {
      console.log(
        `[coordination] offers=${coordination.offers} proxyOpened=${coordination.opened} proxyClosed=${coordination.closed}`,
      );
    }
  } catch (err) {
    console.error("date lifecycle tick failed:", err);
  }
}

bot.start({
  onStart: async (info) => {
    console.log(`Bot @${info.username} started`);

    if (env.DEV_OTP_BYPASS_TELEGRAM_IDS.size > 0) {
      const ids = [...env.DEV_OTP_BYPASS_TELEGRAM_IDS].map((id) => id.toString()).join(", ");
      console.warn(
        `[dev-bypass] DEV_OTP_BYPASS_TELEGRAM_IDS active for: ${ids}. ` +
          `These accounts skip corporate-email verification at /start. ` +
          `MUST be empty in production .env.`,
      );
    }

    // Idempotent DB indexes that Prisma's `db push` workflow can't express
    // (functional index on canonical pair ordering for the lifetime-ban
    // anti-join in `buildCandidateSql`).
    try {
      await ensureMatchPairIndex();
    } catch (err) {
      console.error("[startup] ensureMatchPairIndex failed:", err);
    }

    // Register native menu commands (Telegram Menu Button).
    await bot.api.setMyCommands([
      { command: "start", description: "Start / restart the bot" },
      { command: "menu", description: "Open main menu" },
      { command: "edit", description: "Edit your profile" },
      { command: "profile", description: "View your profile" },
      { command: "settings", description: "Settings" },
    ]);
    if (env.ADMIN_API_KEY) {
      startAdminServer(bot.api);
    }
    startPublicServer(bot.api);

    // Weekly matching cron (global greedy + automated dispatch).
    // Every scheduled job below is wrapped in `guardedTick` (single-flight):
    // node-cron / setInterval fire on a fixed cadence and do NOT wait for the
    // previous run, so a tick that runs longer than its interval would
    // otherwise overlap the next one and re-process the same rows (duplicate
    // DMs / pushes — audit H2/M4). `guardedTick` skips a tick while the prior
    // run is still in flight and centralises error logging.
    cron.schedule(MATCH_CRON_SCHEDULE, guardedTick("weekly-matching", weeklyMatchingJob), {
      timezone: CRON_TIMEZONE,
    });
    console.log(`[cron] Weekly matching scheduled: "${MATCH_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);

    // 24h TTL expiry cron.
    cron.schedule(EXPIRY_CRON_SCHEDULE, guardedTick("match-expiry", expiryJob));
    console.log(`[cron] Match expiry scheduled: "${EXPIRY_CRON_SCHEDULE}"`);

    // Empathetic "no match this week" DM, 15 min after the Thursday batch.
    cron.schedule(
      NO_MATCH_NOTICE_CRON_SCHEDULE,
      guardedTick("no-match-notice", () =>
        sendNoMatchNotices(bot.api, new Date(), DISPATCH_DELAY_MS).then((r) => {
          if (r.notified > 0 || r.failed > 0) {
            console.log(
              `[no-match-notice] notified=${r.notified} tier1=${r.tier1} tier2=${r.tier2} tier3plus=${r.tier3plus} skipped=${r.skipped} failed=${r.failed}`,
            );
          }
        }),
      ),
      { timezone: CRON_TIMEZONE },
    );
    console.log(
      `[cron] No-match notice scheduled: "${NO_MATCH_NOTICE_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
    );

    // Live "⏳ Xh left" countdown plate on proposal pitches.
    cron.schedule(
      PROPOSAL_COUNTDOWN_CRON_SCHEDULE,
      guardedTick("proposal-countdown", () =>
        proposalCountdownTick(bot.api).then((r) => {
          if (r.edited > 0 || r.cleared > 0 || r.errors > 0) {
            console.log(
              `[proposal-countdown] scanned=${r.scanned} edited=${r.edited} skipped=${r.skippedSameText} cleared=${r.cleared} errors=${r.errors}`,
            );
          }
        }),
      ),
    );
    console.log(`[cron] Proposal countdown scheduled: "${PROPOSAL_COUNTDOWN_CRON_SCHEDULE}"`);

    // Date lifecycle (icebreakers, emergencies, feedback) — kept on setInterval.
    if (DATE_LIFECYCLE_TICK_MS > 0) {
      setInterval(guardedTick("date-lifecycle", dateLifecycleTick), DATE_LIFECYCLE_TICK_MS);
    }

    // Re-engagement: remind users who dropped off onboarding (all steps).
    cron.schedule(
      RE_ENGAGEMENT_CRON_SCHEDULE,
      guardedTick("re-engagement", () =>
        reEngagementTick(bot.api).then((n) => {
          if (n > 0) console.log(`[re-engagement] ${n} user(s) re-engaged`);
        }),
      ),
    );
    console.log(`[cron] Re-engagement scheduled: "${RE_ENGAGEMENT_CRON_SCHEDULE}"`);

    // Profiler: post-onboarding Q&A batches that fuel icebreakers + hints.
    cron.schedule(
      PROFILER_CRON_SCHEDULE,
      guardedTick("profiler", () =>
        profilerTick(bot.api).then((r) => {
          if (r.seeded > 0 || r.dispatched > 0 || r.deferred > 0) {
            console.log(
              `[profiler] seeded=${r.seeded} dispatched=${r.dispatched} deferred=${r.deferred}`,
            );
          }
        }),
      ),
    );
    console.log(`[cron] Profiler scheduled: "${PROFILER_CRON_SCHEDULE}"`);

    // Match nudge: proposal (3h/10h) and scheduling (6h/12h) reminders.
    cron.schedule(
      MATCH_NUDGE_CRON_SCHEDULE,
      guardedTick("match-nudge", () =>
        matchNudgeTick(bot.api).then((r) => {
          if (r.proposalNudges > 0 || r.schedNudges > 0) {
            console.log(`[match-nudge] proposal=${r.proposalNudges} sched=${r.schedNudges}`);
          }
        }),
      ),
    );
    console.log(`[cron] Match nudge scheduled: "${MATCH_NUDGE_CRON_SCHEDULE}"`);

    // Date Ticket expiry: refund stalled partial payments, open Calendar free.
    if (env.TICKET_FEATURE_ENABLED) {
      cron.schedule(
        TICKET_EXPIRY_CRON_SCHEDULE,
        guardedTick("ticket-expiry", () =>
          ticketExpiryTick(bot.api).then((r) => {
            if (r.swept > 0) console.log(`[ticket-expiry] swept ${r.swept} stalled ticket gate(s)`);
          }),
        ),
      );
      console.log(`[cron] Ticket expiry scheduled: "${TICKET_EXPIRY_CRON_SCHEDULE}"`);
    }

    // Pre-match announce: Wednesday teaser before Thursday batch.
    cron.schedule(
      PRE_MATCH_ANNOUNCE_CRON_SCHEDULE,
      guardedTick("pre-match-announce", () =>
        preMatchAnnounceTick(bot.api).then((r) => {
          if (r.announced > 0) console.log(`[pre-match-announce] ${r.announced} user(s) notified`);
        }),
      ),
      { timezone: CRON_TIMEZONE },
    );
    console.log(`[cron] Pre-match announce scheduled: "${PRE_MATCH_ANNOUNCE_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);

    // M-6: hourly auto-unsuspend. Lifts Tier 2 suspensions whose
    // `suspendedUntil` has elapsed without waiting for the weekly batch.
    cron.schedule(
      AUTO_UNSUSPEND_CRON_SCHEDULE,
      guardedTick("auto-unsuspend", () =>
        autoUnsuspendElapsed().then((n) => {
          if (n > 0) console.log(`[auto-unsuspend] reactivated ${n} user(s)`);
        }),
      ),
    );
    console.log(`[cron] Auto-unsuspend scheduled: "${AUTO_UNSUSPEND_CRON_SCHEDULE}"`);

    // M-2: embedding refresh — picks up dirty profiles and recomputes.
    cron.schedule(
      EMBEDDING_REFRESH_CRON_SCHEDULE,
      guardedTick("embedding-refresh", () =>
        embeddingRefreshTick().then((r) => {
          if (r.scanned > 0) {
            console.log(
              `[embedding-refresh] scanned=${r.scanned} refreshed=${r.refreshed} failed=${r.failed}`,
            );
          }
        }),
      ),
    );
    console.log(`[cron] Embedding refresh scheduled: "${EMBEDDING_REFRESH_CRON_SCHEDULE}"`);

    // Pinned status banner — discrete countdown to next match dispatch.
    cron.schedule(
      STATUS_TIMER_CRON_SCHEDULE,
      guardedTick("status-timer", () =>
        statusTimerTick(bot.api).then((r) => {
          if (r.edited > 0 || r.cleared > 0 || r.errors > 0) {
            console.log(
              `[status-timer] scanned=${r.scanned} edited=${r.edited} skipped=${r.skippedSameText} cleared=${r.cleared} errors=${r.errors}`,
            );
          }
        }),
      ),
    );
    console.log(`[cron] Status timer scheduled: "${STATUS_TIMER_CRON_SCHEDULE}"`);

    // GDPR Article 9: scrub Persona-captured selfies once they pass the
    // 90-day retention window. The user stays `verified`; only the stored
    // reference image is deleted.
    cron.schedule(
      SELFIE_RETENTION_CRON_SCHEDULE,
      guardedTick("selfie-retention", () =>
        runSelfieRetention().then((r) => {
          if (r.scanned > 0 || r.errors > 0) {
            console.log(
              `[selfie-retention] scanned=${r.scanned} storage=${r.deletedFromStorage} db=${r.deletedFromDb} errors=${r.errors}`,
            );
          }
        }),
      ),
      { timezone: CRON_TIMEZONE },
    );
    console.log(
      `[cron] Selfie retention scheduled: "${SELFIE_RETENTION_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
    );

    // Curated venue re-validation — deactivate closed/degraded venues and
    // refresh opening hours against Google Places.
    cron.schedule(
      VENUE_REVALIDATION_CRON_SCHEDULE,
      guardedTick("venue-revalidation", () =>
        venueRevalidationTick().then((r) => {
          if (r.scanned > 0) {
            console.log(
              `[venue-revalidation] scanned=${r.scanned} deactivated=${r.deactivated} refreshed=${r.refreshed} failed=${r.failed}`,
            );
          }
        }),
      ),
      { timezone: CRON_TIMEZONE },
    );
    console.log(
      `[cron] Venue re-validation scheduled: "${VENUE_REVALIDATION_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
    );
  },
});

/* ── Graceful shutdown ─────────────────────────────────────── */
function shutdown(signal: string): void {
  console.log(`[shutdown] ${signal} received, stopping bot…`);
  bot.stop();
  cron.getTasks().forEach((task) => task.stop());
  // Give grammY time to close the polling connection
  setTimeout(() => process.exit(0), 1500);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
