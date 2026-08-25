// MUST be the first import: triggers .env.local → .env load BEFORE
// `@gennety/db` evaluates `new PrismaClient()`. Prisma's own dotenv loader
// would otherwise read .env first, set DATABASE_URL to the prod URL in
// process.env, and silently shadow .env.local (dotenv defaults to non-
// override). Reordering this line breaks local dev — bot then hits prod.
import "./config.js";

import cron from "node-cron";
import { ensureMatchPairIndex } from "@gennety/db";
import { CADENCE } from "@gennety/shared";
import { assertIdentityTrustConfiguration, env } from "./config.js";
import {
  DEMO_MODE_ENABLED,
  assertDemoIsolation,
  logDemoBanner,
} from "./demo/config.js";
import { demoDriverTick } from "./demo/driver.js";
import { createBot } from "./bot.js";
import { setMainBotApi } from "./services/main-bot-api.js";
import {
  notifyFounderStatusTimerHealth,
  notifyFounderWeeklyMatches,
} from "./services/founder-notify.js";
import { autoUnsuspendElapsed, runDropBatch } from "./services/match-engine.js";
import { dispatchMatches } from "./services/dispatch-queue.js";
import { sendNoMatchNotices } from "./services/no-match-notifier.js";
import { autoResumeStarvedUsers } from "./services/pool-exhaustion.js";
import { expireStaleMatches } from "./services/match-expiry.js";
import { sendExpiryNotifications } from "./services/expiry-notify.js";
import { runDateLifecycleTick } from "./services/date-lifecycle.js";
import { runPreDateSafetyTick } from "./services/pre-date-safety.js";
import { runCoordinationTick } from "./services/coordination.js";
import { startAdminServer } from "./admin/server.js";
import { startPublicServer } from "./public/server.js";
import {
  CRON_TIMEZONE,
  MATCH_CRON_SCHEDULE,
} from "./services/next-batch.js";
import { reEngagementTick } from "./workers/re-engagement.js";
import { profilerTick } from "./workers/profiler.js";
import { matchNudgeTick } from "./workers/match-nudge.js";
import { proposalCountdownTick } from "./workers/proposal-countdown.js";
import { peerWaitShimmerTick } from "./workers/peer-wait-shimmer.js";
import { statusTimerTick } from "./workers/status-timer.js";
import { createStatusTimerRunner } from "./workers/status-timer-runner.js";
import { embeddingRefreshTick } from "./workers/embedding-refresh.js";
import { ticketExpiryTick } from "./workers/ticket-expiry.js";
import { premiumExpiryReminderTick } from "./workers/premium-expiry-reminder.js";
import { syntheticPartnerTick } from "./workers/synthetic-partner.js";
import { campusDropTick } from "./workers/campus-drop.js";
import { sweepRematchRefunds } from "./services/rematch-refund.js";
import { sweepVenueChangeRefunds } from "./services/venue-change-refund.js";
import { runSelfieRetention } from "./services/selfie-retention.js";
import { retentionTick } from "./workers/retention.js";
import { venueConcentrationAlertTick } from "./workers/venue-concentration-alert.js";
import { venueRevalidationTick } from "./services/venue-revalidation.js";
import { retryDueVenueSelections } from "./services/venue-intent-v2.js";
import { guardedTick } from "./utils/guarded-tick.js";

/* ── Process-level crash guard ─────────────────────────────── */
process.on("uncaughtException", (err) => {
  console.error("[FATAL] uncaughtException:", err);
  process.exit(1);
});
// Non-fatal by design: this is a single process serving every user, plus the
// public/admin Express servers and all crons. A stray rejection from a
// fire-and-forget path (a `void foo().catch()` whose catch itself threw, an
// unawaited side effect) must NOT take the whole bot down for everyone and
// trigger a PM2 crash-loop that re-delivers the same Telegram update on restart.
// grammY handler errors are already contained by `bot.catch`, and every cron
// tick is wrapped in try/catch, so a surviving unhandledRejection is logged
// loudly and we keep serving. `uncaughtException` (above) stays fatal — a
// synchronous throw that escaped every frame is a genuinely unknown state.
process.on("unhandledRejection", (reason) => {
  console.error("[bot] unhandledRejection (non-fatal, continuing):", reason);
});

// Demo mode is a runtime, not a feature (DEMO_MODE.md). It is checked FIRST
// and on purpose: `identityTrustConfigurationErrors` treats a demo process as
// non-production and therefore stops enforcing the identity gate, so the flag
// must not be self-certifying. `assertDemoIsolation` refuses to start a
// demo-flagged process that still carries production's own settings — which is
// what makes DEMO_MODE_ENABLED=true in the production .env a loud boot failure
// rather than a silent disabling of verification for real users.
if (DEMO_MODE_ENABLED) {
  assertDemoIsolation();
}
assertIdentityTrustConfiguration();

const bot = createBot(env.BOT_TOKEN);
// Publish the main bot Api so context-less services (founder-notify) can act
// as @gennetybot — e.g. download a user's own profile-photo bytes.
setMainBotApi(bot.api);
const runStatusTimer = createStatusTimerRunner({
  tick: () => statusTimerTick(bot.api),
  notifyHealth: notifyFounderStatusTimerHealth,
});

const DEFAULT_DATE_LIFECYCLE_TICK_MS = 2 * 60 * 1000;
/**
 * Parse the date-lifecycle interval defensively (audit M2). A non-numeric
 * override (e.g. `DATE_LIFECYCLE_TICK_MS=2m` — an easy mistake since every other
 * schedule in this file is a cron string) would otherwise become `NaN`, and
 * `NaN > 0` is false — silently disabling the ENTIRE date lifecycle
 * (ice-breakers, emergency window, T-1.5h safety brief, feedback, coordination,
 * venue-change expiry) with no signal. Fall back to the default and warn loudly
 * instead. An explicit `0` still disables it (kept as the intentional off switch).
 */
function resolveDateLifecycleTickMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_DATE_LIFECYCLE_TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[config] DATE_LIFECYCLE_TICK_MS="${raw}" is not a non-negative number — ` +
        `falling back to ${DEFAULT_DATE_LIFECYCLE_TICK_MS}ms so the date lifecycle ` +
        `still runs. Use a millisecond integer (or 0 to disable).`,
    );
    return DEFAULT_DATE_LIFECYCLE_TICK_MS;
  }
  return parsed;
}
const DATE_LIFECYCLE_TICK_MS = resolveDateLifecycleTickMs(process.env.DATE_LIFECYCLE_TICK_MS);

/**
 * Peer-wait shimmer interval (PRODUCT_SPEC §3.6b). A `<tg-thinking>` draft dies
 * ~30s after it is issued, so this MUST stay comfortably under that or the
 * shimmer will visibly blink out between ticks. It is an interval rather than a
 * cron because node-cron's finest granularity is one minute — already too slow.
 * `0` disables the whole feature (every waiting user simply sees nothing), which
 * is the kill switch: no redeploy, just `pm2 restart --update-env`.
 */
const DEFAULT_PEER_WAIT_TICK_MS = 20 * 1000;
function resolvePeerWaitTickMs(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_PEER_WAIT_TICK_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[config] PEER_WAIT_TICK_MS="${raw}" is not a non-negative number — ` +
        `falling back to ${DEFAULT_PEER_WAIT_TICK_MS}ms. Use a millisecond ` +
        `integer (or 0 to disable the peer-wait shimmer).`,
    );
    return DEFAULT_PEER_WAIT_TICK_MS;
  }
  return parsed;
}
const PEER_WAIT_TICK_MS = resolvePeerWaitTickMs(process.env.PEER_WAIT_TICK_MS);

/**
 * Expiry cron schedule. Runs every 15 minutes to expire proposals
 * that have been dispatched but not mutually accepted within 24 hours.
 */
const EXPIRY_CRON_SCHEDULE = process.env.EXPIRY_CRON_SCHEDULE ?? "*/15 * * * *";

/**
 * "No match" empathetic DM. Default: `CADENCE.noMatchNoticeCron` (Thursday
 * 18:15 Kyiv under `weekly` — 15 minutes after the matching batch so
 * dispatched users get a moment with their pitch before unmatched users
 * receive the consolation note; daily under `daily`, though the actual send
 * frequency per user is throttled well below daily by
 * `CADENCE.famineNoticeIntervalMs` inside `sendNoMatchNotices` — see that
 * function's header for why the cron firing daily doesn't mean daily DMs).
 * Re-runs are safe (`@@unique([userId, dropDate])` on `NoMatchNotice`).
 */
const NO_MATCH_NOTICE_CRON_SCHEDULE =
  process.env.NO_MATCH_NOTICE_CRON_SCHEDULE ?? CADENCE.noMatchNoticeCron;

/**
 * Proposal-countdown cron: every minute (2026-07-25; was every five). The button
 * label is minute-granular (`⏳ Time left to reply: 23h 47m`), so a per-minute tick makes
 * it move on every pass — the countdown reads as genuinely live instead of
 * freezing for five minutes at a time. Same cadence as the pinned status
 * banner, and for the same reason: `editMessageReplyMarkup` sends no
 * notification, so the cost is API calls, not user noise.
 *
 * Load: one edit per undecided side of each open proposal per minute, only
 * during the 24h window. The worker paces itself at 25 edits/s and
 * `guardedTick` is single-flight, so a batch large enough to overrun a minute
 * degrades to "skip a tick" rather than piling up concurrent sweeps.
 */
const PROPOSAL_COUNTDOWN_CRON_SCHEDULE =
  process.env.PROPOSAL_COUNTDOWN_CRON_SCHEDULE ?? "* * * * *";

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
 * Pinned status banner (live discrete timer). Runs every minute so the
 * "Xd Yh" / "Xh Ym" / "Xm" text visibly ticks down between user glances.
 * The worker de-dups via an in-memory render cache, so unchanged banners
 * don't hit Telegram at all — only real transitions consume API quota.
 */
const STATUS_TIMER_CRON_SCHEDULE = process.env.STATUS_TIMER_CRON_SCHEDULE ?? "* * * * *";

/** Dispatch delay between pitch sends (ms). Default: 2s = ~30/min. */
const DISPATCH_DELAY_MS = Number(process.env.DISPATCH_DELAY_MS ?? 2000);
/** Gap between first-match gift pre-roll and the match card reveal. */
const MATCH_PREROLL_DELAY_MS = Number(process.env.MATCH_PREROLL_DELAY_MS ?? 2 * 60 * 1000);

/**
 * M-6: hourly auto-unsuspend. The expiration check used to live ONLY inside
 * `runDropBatch` (née `runWeeklyBatch`), which meant a 14-day suspension that
 * expired on a Friday morning sat for another 6 days until the next Thursday
 * batch. Running it hourly keeps the lag below an hour without thrashing the
 * DB, independent of however often the batch itself now runs.
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
 * General data retention (audit DATA-1): expired OTP challenges, dead refresh
 * sessions, and aged proxy-chat messages. Daily at 03:45 Europe/Kyiv — just
 * after the selfie scrub, still off-peak. Batched, so a large backlog drains
 * over several days rather than in one long-running tick.
 */
const RETENTION_CRON_SCHEDULE =
  process.env.RETENTION_CRON_SCHEDULE ?? "45 3 * * *";
/// Weekly, Friday 10:00 Kyiv — the morning after Thursday's batch, so the
/// window it reports on always contains a full drop cycle.
const VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE =
  process.env.VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE ?? "0 10 * * 5";

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
/// Gennety Premium expiry reminders (§3.8). Hourly: the buckets are 24h and 48h
/// wide, so an hourly sweep cannot miss one, and a finer cadence would only
/// re-ask the same question of the same rows.
const PREMIUM_REMINDER_CRON_SCHEDULE =
  process.env.PREMIUM_REMINDER_CRON_SCHEDULE ?? "0 * * * *";

/**
 * Rematch refund retry (REMATCH_PRODUCT_SPEC.md, D1). Hourly: retries refunds
 * whose provider call failed, and refunds purchases abandoned mid-run (the
 * process died between "Stars moved" and the terminal write). This is what makes
 * "we never keep money without delivering a match" durable rather than
 * best-effort. Registered only when REMATCH_FEATURE_ENABLED.
 */
const REMATCH_REFUND_CRON_SCHEDULE =
  process.env.REMATCH_REFUND_CRON_SCHEDULE ?? "0 * * * *";

/**
 * Venue-change refund retry (PRODUCT_SPEC §3.7b). Hourly twin of the rematch
 * sweep: retries refunds whose provider call failed, and refunds purchases
 * abandoned mid-settle. Registered only when VENUE_CHANGE_FEATURE_ENABLED.
 */
const VENUE_CHANGE_REFUND_CRON_SCHEDULE =
  process.env.VENUE_CHANGE_REFUND_CRON_SCHEDULE ?? "0 * * * *";

/**
 * Profiler scheduler (Phase 1b). Every 15 min: lazy-seed never-armed users and
 * dispatch due Profiler batches (morning/evening windows in the user's local
 * time). Cheap when idle.
 */
const PROFILER_CRON_SCHEDULE =
  process.env.PROFILER_CRON_SCHEDULE ?? "*/15 * * * *";

/**
 * Drop batch: run the global greedy matching algorithm, then dispatch
 * all pitches via the rate-limited queue. Cadence (weekly/daily) is
 * whatever MATCH_CRON_SCHEDULE resolves to — see next-batch.ts / cadence.ts.
 */
async function dropMatchingJob(): Promise<void> {
  try {
    console.log("[cron] Drop matching batch started");
    const result = await runDropBatch();
    console.log(
      `[cron] Batch complete: eligible=${result.eligible} pairs=${result.pairs}` +
        // Reported separately, never folded into `pairs`: a fill pairing is a
        // real user meeting a stand-in, and a batch that looks healthy only
        // because scaffolding covered the gap is the one thing this number
        // must not be able to hide (PRODUCT_SPEC §3.1c).
        (result.syntheticPairs > 0 ? ` syntheticFill=${result.syntheticPairs}` : ""),
    );

    // Notify sides of any proposal the batch's own expiry preflight expired
    // (see runDropBatch's header comment — this is what makes the ordering
    // between the standalone expiry sweep and the batch deterministic under
    // a daily cadence). The standalone `*/15 * * * *` expiryJob below still
    // runs independently as a safety net between batches; the atomic CAS in
    // expireStaleMatches makes catching the same row from both places a safe
    // no-op for whichever runs second.
    if (result.expiredMatches.length > 0) {
      console.log(`[cron] Batch expiry-preflight expired ${result.expiredMatches.length} stale match(es)`);
      const notify = await sendExpiryNotifications(bot.api, result.expiredMatches);
      console.log(
        `[cron] Batch expiry notify: notified=${notify.notified} skipped=${notify.skipped} failed=${notify.failed}`,
      );
    }

    if (result.matchIds.length > 0) {
      console.log(`[cron] Dispatching ${result.matchIds.length} pitches...`);
      const dispatch = await dispatchMatches(
        bot.api,
        result.matchIds,
        DISPATCH_DELAY_MS,
        3,
        MATCH_PREROLL_DELAY_MS,
      );
      console.log(
        `[cron] Dispatch complete: sent=${dispatch.dispatched} failed=${dispatch.failed}`,
      );

      // Founder ops feed: snapshot the week's pairs and DM the founder a
      // tokenized report link (no-op unless FOUNDER_NOTIFY_ENABLED). Best-effort.
      await notifyFounderWeeklyMatches(result.matchIds).catch((err) => {
        console.warn("[cron] founder weekly-matches notify failed:", err);
      });
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
    const [lifecycle, safety, coordination, venueRetries] = await Promise.all([
      runDateLifecycleTick(bot.api),
      runPreDateSafetyTick(bot.api),
      runCoordinationTick(bot.api),
      retryDueVenueSelections(),
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
    if (venueRetries > 0) console.log(`[venue-intent-v2] retried=${venueRetries}`);
  } catch (err) {
    console.error("date lifecycle tick failed:", err);
  }
}

bot.start({
  onStart: async (info) => {
    console.log(`Bot @${info.username} started`);

    if (DEMO_MODE_ENABLED) {
      // The two things no automated check can verify — which bot and which
      // database — printed where they cannot be missed.
      logDemoBanner(info.username);
      if (env.DEMO_TICK_MS > 0) {
        setInterval(
          guardedTick("demo-driver", () =>
            demoDriverTick(bot.api).then((r) => {
              if (r.acted > 0 || r.errors > 0) {
                console.log(`[demo] scanned=${r.scanned} acted=${r.acted} errors=${r.errors}`);
              }
            }),
          ),
          env.DEMO_TICK_MS,
        );
        console.log(`[worker] Demo driver every ${env.DEMO_TICK_MS}ms`);
      } else {
        console.log("[worker] Demo driver disabled (DEMO_TICK_MS=0)");
      }
    }

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
      // Demo mode's escape hatch. Listed here or it is undiscoverable: a
      // visitor who wants to see the flow again as the other gender has no
      // other way to know it exists (DEMO_MODE.md → Recovery).
      ...(DEMO_MODE_ENABLED
        ? [{ command: "restart", description: "Start the demo over from scratch" }]
        : []),
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
    // Demo mode owns match creation itself (`demo/driver.ts`). The global
    // matchmaker must NOT run there: every demo visitor is an active, verified
    // Kyiv account, so the real engine would cheerfully pair two investors with
    // each other. Code-owned rather than an env schedule, because "the demo
    // must never pair two visitors" is an invariant, not a setting.
    if (DEMO_MODE_ENABLED) {
      console.log("[cron] Drop matching NOT scheduled (demo mode owns matching)");
    } else {
      cron.schedule(MATCH_CRON_SCHEDULE, guardedTick("drop-matching", dropMatchingJob), {
        timezone: CRON_TIMEZONE,
      });
      console.log(`[cron] Drop matching scheduled: "${MATCH_CRON_SCHEDULE}" (${CRON_TIMEZONE})`);
    }

    // 24h TTL expiry cron.
    cron.schedule(EXPIRY_CRON_SCHEDULE, guardedTick("match-expiry", expiryJob));
    console.log(`[cron] Match expiry scheduled: "${EXPIRY_CRON_SCHEDULE}"`);

    // Empathetic "no match" DM, plus the D10 pool-exhaustion auto-resume
    // sweep in the same tick (mirrors autoUnsuspendElapsed's shape: a
    // periodic scan reversing a status this same subsystem set — no
    // dedicated cron registration needed).
    // Skipped in demo for the same reason: a visitor who is about to be handed
    // a match must never receive "we couldn't find anyone this week", and the
    // pool-exhaustion sweep would eventually pause their account mid-demo.
    if (DEMO_MODE_ENABLED) {
      console.log("[cron] No-match notice NOT scheduled (demo mode)");
    } else {
    cron.schedule(
      NO_MATCH_NOTICE_CRON_SCHEDULE,
      guardedTick("no-match-notice", async () => {
        const r = await sendNoMatchNotices(bot.api, new Date(), DISPATCH_DELAY_MS);
        if (r.notified > 0 || r.failed > 0) {
          console.log(
            `[no-match-notice] notified=${r.notified} tier1=${r.tier1} tier2=${r.tier2} tier3plus=${r.tier3plus} paused=${r.paused} skipped=${r.skipped} failed=${r.failed}`,
          );
        }
        await autoResumeStarvedUsers(bot.api);
      }),
      { timezone: CRON_TIMEZONE },
    );
    console.log(
      `[cron] No-match notice scheduled: "${NO_MATCH_NOTICE_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
    );
    }

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

    // "Waiting on your partner" shimmer — re-issues the ephemeral rich draft so
    // it survives the whole wait. setInterval, not cron: the draft's ~30s TTL is
    // shorter than cron's one-minute floor.
    if (PEER_WAIT_TICK_MS > 0) {
      setInterval(
        guardedTick("peer-wait", () =>
          peerWaitShimmerTick(bot.api).then((r) => {
            if (r.fallbackSent > 0 || r.clearedFallback > 0 || r.errors > 0) {
              console.log(
                `[peer-wait] scanned=${r.scanned} refreshed=${r.refreshed} ` +
                  `fallbackSent=${r.fallbackSent} fallbackEdited=${r.fallbackEdited} ` +
                  `cleared=${r.clearedFallback} errors=${r.errors}`,
              );
            }
          }),
        ),
        PEER_WAIT_TICK_MS,
      );
      console.log(`[worker] Peer-wait shimmer every ${PEER_WAIT_TICK_MS}ms`);
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
          if (r.seeded > 0 || r.dispatched > 0 || r.deferred > 0 || r.blocked > 0 || r.expired > 0) {
            console.log(
              `[profiler] seeded=${r.seeded} dispatched=${r.dispatched} deferred=${r.deferred} blocked=${r.blocked} expired=${r.expired}`,
            );
          }
        }),
      ),
    );
    console.log(`[cron] Profiler scheduled: "${PROFILER_CRON_SCHEDULE}"`);

    // Match nudge: proposal (3h/10h), scheduling and venue (6h/12h) reminders,
    // plus the planning-stage stall chain — "still in?" at 24h, cancellation at
    // 48h (PRODUCT_SPEC §3.5c).
    cron.schedule(
      MATCH_NUDGE_CRON_SCHEDULE,
      guardedTick("match-nudge", () =>
        matchNudgeTick(bot.api).then((r) => {
          const total =
            r.proposalNudges +
            r.schedNudges +
            r.deadlineNudges +
            r.venueNudges +
            r.stallCheckIns +
            r.stallTimeouts;
          if (total > 0) {
            console.log(
              `[match-nudge] proposal=${r.proposalNudges} sched=${r.schedNudges} ` +
                `deadline=${r.deadlineNudges} venue=${r.venueNudges} ` +
                `stallCheckIns=${r.stallCheckIns} stallTimeouts=${r.stallTimeouts}`,
            );
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

    // Premium expiry reminders (§3.8): 3 days and 24 hours before a NON-renewing
    // paid period ends. Gated on the same flag as the purchase surfaces — this
    // message exists to sell the next period, so with sales paused there is
    // nowhere to send anyone. An entitlement already paid for is unaffected
    // either way; it simply runs out as it does today.
    if (env.PREMIUM_FEATURE_ENABLED) {
      cron.schedule(
        PREMIUM_REMINDER_CRON_SCHEDULE,
        guardedTick("premium-reminder", () =>
          premiumExpiryReminderTick(bot.api).then((r) => {
            if (r.sent3d + r.sent1d + r.failed > 0) {
              console.log(
                `[premium-reminder] 3d=${r.sent3d} 1d=${r.sent1d} failed=${r.failed}`,
              );
            }
          }),
        ),
      );
      console.log(
        `[cron] Premium expiry reminder scheduled: "${PREMIUM_REMINDER_CRON_SCHEDULE}"`,
      );
    }

    // Rematch refunds: retry failed refunds + reverse abandoned purchases.
    if (env.REMATCH_FEATURE_ENABLED) {
      cron.schedule(
        REMATCH_REFUND_CRON_SCHEDULE,
        guardedTick("rematch-refund", () =>
          sweepRematchRefunds(bot.api).then(() => undefined),
        ),
      );
      console.log(`[cron] Rematch refund retry scheduled: "${REMATCH_REFUND_CRON_SCHEDULE}"`);
    }

    // Venue-change refunds: retry failed refunds + reverse purchases abandoned
    // mid-settle. Same discipline as the rematch sweep above — this is what
    // makes "a venue-change payment either changes the venue or comes back"
    // durable rather than best-effort.
    if (env.VENUE_CHANGE_FEATURE_ENABLED) {
      cron.schedule(
        VENUE_CHANGE_REFUND_CRON_SCHEDULE,
        guardedTick("venue-change-refund", () =>
          sweepVenueChangeRefunds(bot.api).then(() => undefined),
        ),
      );
      console.log(
        `[cron] Venue-change refund retry scheduled: "${VENUE_CHANGE_REFUND_CRON_SCHEDULE}"`,
      );
    }

    // Synthetic test partners (PRODUCT_SPEC §3.1c): decline once the human
    // has committed. Registered only when SYNTHETIC_FILL_ENABLED, so a
    // production without the flag schedules nothing at all — and the tick
    // itself re-reads the flag, so flipping it off mid-run stops the sweep
    // rather than leaving a scheduled no-op with teeth.
    if (env.SYNTHETIC_FILL_ENABLED) {
      cron.schedule(
        env.SYNTHETIC_PARTNER_CRON_SCHEDULE,
        guardedTick("synthetic-partner", () =>
          syntheticPartnerTick().then(() => undefined),
        ),
      );
      console.log(
        `[cron] Synthetic test partner scheduled: "${env.SYNTHETIC_PARTNER_CRON_SCHEDULE}"`,
      );
    }

    // Bonus Campus Drop (PRODUCT_SPEC §Campus Radar): an out-of-cycle drop for
    // a university whose verified cohort just grew. Registered only when
    // CAMPUS_DROP_ENABLED — it is a SECOND entry point into the allocator, and
    // the reason Rematch carries a pre-batch blackout is that a single-cohort
    // run can take a candidate the globally-optimal Thursday batch needed.
    //
    // Not scheduled in demo mode, for the same reason drop matching is not:
    // the demo must never pair two visitors with each other, and a campus drop
    // is matching.
    if (env.CAMPUS_DROP_ENABLED && !DEMO_MODE_ENABLED) {
      cron.schedule(
        env.CAMPUS_DROP_CRON_SCHEDULE,
        guardedTick("campus-drop", () => campusDropTick()),
      );
      console.log(`[cron] Campus drop scheduled: "${env.CAMPUS_DROP_CRON_SCHEDULE}"`);
    } else if (env.CAMPUS_DROP_ENABLED) {
      console.log("[cron] Campus drop NOT scheduled (demo mode owns matching)");
    }

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
      guardedTick("status-timer", runStatusTimer),
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

    // General data retention: expired OTP challenges (including phone numbers
    // of people who never finished signing up, which no user cascade reaches),
    // dead refresh sessions, and aged proxy-chat messages.
    cron.schedule(
      RETENTION_CRON_SCHEDULE,
      guardedTick("retention", () => retentionTick().then(() => undefined)),
      { timezone: CRON_TIMEZONE },
    );
    console.log(
      `[cron] Data retention scheduled: "${RETENTION_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
    );

    // Weekly venue-concentration alarm. Registered only when the alert is on:
    // the engine's failure mode is silent (dates keep being scheduled), so
    // without this nobody learns that one venue took the city until a human
    // queries the database by hand.
    if (env.VENUE_CONCENTRATION_ALERT_ENABLED) {
      cron.schedule(
        VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE,
        guardedTick("venue-concentration-alert", () =>
          venueConcentrationAlertTick().then((r) => {
            if (!r.skipped) {
              console.log(
                `[venue-concentration] cities=${r.citiesScanned} alerts=${r.alerts}`,
              );
            }
          }),
        ),
        { timezone: CRON_TIMEZONE },
      );
      console.log(
        `[cron] Venue concentration alert scheduled: "${VENUE_CONCENTRATION_ALERT_CRON_SCHEDULE}" (${CRON_TIMEZONE})`,
      );
    }

    // Curated venue re-validation — deactivate closed/degraded venues and
    // refresh opening hours against Google Places.
    //
    // Third demo-only cron suppression, alongside drop matching and the
    // no-match notice above, and the reasoning is cost rather than correctness:
    // the demo carries its own full catalog (~1200 active rows) and was paying a
    // second, identical Google bill every night to keep it fresh — for a
    // deployment that has had one match in its entire life, already completed,
    // and no date traffic at all. Code-owned rather than an env schedule so it
    // cannot be silently re-inherited: the demo `.env` is generated as
    // production's plus `.env.demo`, and anything that file does not name comes
    // across on its own, which is exactly how this was running unnoticed.
    // Accepted tradeoff (founder decision 2026-08-23, DECISIONS.md): the demo
    // catalog slowly rots and may show a venue that has since closed — invisible
    // in a walkthrough, and cheaper than the bill.
    if (DEMO_MODE_ENABLED) {
      console.log("[cron] Venue re-validation NOT scheduled (demo mode)");
    } else {
      cron.schedule(
        VENUE_REVALIDATION_CRON_SCHEDULE,
        guardedTick("venue-revalidation", () =>
          venueRevalidationTick().then((r) => {
            if (r.scanned > 0) {
              // `scanned` counts distinct PLACES (= Places requests), not rows:
              // one request settles all ~5 per-domain copies of a venue.
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
    }
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
