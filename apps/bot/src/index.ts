import cron from "node-cron";
import { ensureMatchPairIndex } from "@gennety/db";
import { env } from "./config.js";
import { createBot } from "./bot.js";
import { runWeeklyBatch } from "./services/match-engine.js";
import { dispatchMatches } from "./services/dispatch-queue.js";
import { notifyStarved } from "./services/starvation-notify.js";
import { expireStaleMatches } from "./services/match-expiry.js";
import { runDateLifecycleTick } from "./services/date-lifecycle.js";
import { runPreDateSafetyTick } from "./services/pre-date-safety.js";
import { startAdminServer } from "./admin/server.js";
import { startPublicServer } from "./public/server.js";
import { reEngagementTick } from "./workers/re-engagement.js";
import { matchNudgeTick } from "./workers/match-nudge.js";
import { preMatchAnnounceTick } from "./workers/pre-match-announce.js";
import { statusTimerTick } from "./workers/status-timer.js";

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
      console.log(`[cron] Notifying ${result.missedUserIds.length} starved users...`);
      const notify = await notifyStarved(bot.api, result.missedUserIds, DISPATCH_DELAY_MS);
      console.log(
        `[cron] Starvation notify complete: sent=${notify.notified} skipped=${notify.skipped} failed=${notify.failed}`,
      );
    }
  } catch (err) {
    console.error("[cron] Weekly matching job failed:", err);
  }
}

/**
 * Expiry job: mark stale proposed matches as expired after 24h TTL.
 */
async function expiryJob(): Promise<void> {
  try {
    const result = await expireStaleMatches();
    if (result.expired > 0) {
      console.log(`[cron] Expired ${result.expired} stale matches`);
    }
  } catch (err) {
    console.error("[cron] Expiry job failed:", err);
  }
}

async function dateLifecycleTick(): Promise<void> {
  try {
    const [lifecycle, safety] = await Promise.all([
      runDateLifecycleTick(bot.api),
      runPreDateSafetyTick(bot.api),
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
  } catch (err) {
    console.error("date lifecycle tick failed:", err);
  }
}

bot.start({
  onStart: async (info) => {
    console.log(`Bot @${info.username} started`);

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
      startAdminServer();
    }
    startPublicServer();

    // Weekly matching cron (global greedy + automated dispatch).
    cron.schedule(MATCH_CRON_SCHEDULE, () => {
      void weeklyMatchingJob();
    }, { timezone: CRON_TIMEZONE });
    console.log(`[cron] Weekly matching scheduled: "${MATCH_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);

    // 24h TTL expiry cron.
    cron.schedule(EXPIRY_CRON_SCHEDULE, () => {
      void expiryJob();
    });
    console.log(`[cron] Match expiry scheduled: "${EXPIRY_CRON_SCHEDULE}"`);

    // Date lifecycle (icebreakers, emergencies, feedback) — kept on setInterval.
    if (DATE_LIFECYCLE_TICK_MS > 0) {
      setInterval(() => {
        void dateLifecycleTick();
      }, DATE_LIFECYCLE_TICK_MS);
    }

    // Re-engagement: remind users who dropped off onboarding (all steps).
    cron.schedule(RE_ENGAGEMENT_CRON_SCHEDULE, () => {
      void reEngagementTick(bot.api).then((n) => {
        if (n > 0) console.log(`[re-engagement] ${n} user(s) re-engaged`);
      }).catch((err) => console.error("[re-engagement] tick failed:", err));
    });
    console.log(`[cron] Re-engagement scheduled: "${RE_ENGAGEMENT_CRON_SCHEDULE}"`);

    // Match nudge: proposal (3h/10h) and scheduling (6h/12h) reminders.
    cron.schedule(MATCH_NUDGE_CRON_SCHEDULE, () => {
      void matchNudgeTick(bot.api).then((r) => {
        if (r.proposalNudges > 0 || r.schedNudges > 0) {
          console.log(`[match-nudge] proposal=${r.proposalNudges} sched=${r.schedNudges}`);
        }
      }).catch((err) => console.error("[match-nudge] tick failed:", err));
    });
    console.log(`[cron] Match nudge scheduled: "${MATCH_NUDGE_CRON_SCHEDULE}"`);

    // Pre-match announce: Wednesday teaser before Thursday batch.
    cron.schedule(PRE_MATCH_ANNOUNCE_CRON_SCHEDULE, () => {
      void preMatchAnnounceTick(bot.api).then((r) => {
        if (r.announced > 0) console.log(`[pre-match-announce] ${r.announced} user(s) notified`);
      }).catch((err) => console.error("[pre-match-announce] tick failed:", err));
    }, { timezone: CRON_TIMEZONE });
    console.log(`[cron] Pre-match announce scheduled: "${PRE_MATCH_ANNOUNCE_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);

    // Pinned status banner — discrete countdown to next match dispatch.
    cron.schedule(STATUS_TIMER_CRON_SCHEDULE, () => {
      void statusTimerTick(bot.api).then((r) => {
        if (r.edited > 0 || r.cleared > 0 || r.errors > 0) {
          console.log(
            `[status-timer] scanned=${r.scanned} edited=${r.edited} skipped=${r.skippedSameText} cleared=${r.cleared} errors=${r.errors}`,
          );
        }
      }).catch((err) => console.error("[status-timer] tick failed:", err));
    });
    console.log(`[cron] Status timer scheduled: "${STATUS_TIMER_CRON_SCHEDULE}"`);
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
