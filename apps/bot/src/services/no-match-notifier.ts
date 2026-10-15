import type { Api, RawApi } from "grammy";
import type { MessageEntity } from "grammy/types";
import { prisma, type Prisma } from "@gennety/db";
import { calibrationOverWhere } from "./first-drop-calibration.js";
import {
  CADENCE,
  FAMINE_PAUSE_AFTER_DAYS,
  WAITING_NOTICE_MILESTONE_DAYS,
  t,
  type Language,
  type TranslationKey,
} from "@gennety/shared";
import { env } from "../config.js";
import { streamDraftsToChat } from "./ai-stream.js";

import { AI_EMOJI } from "./ai-emoji.js";
import { grantFamineDiscountIfEligible } from "./ticket-discount.js";
import { isUniqueViolation } from "./ticket-wallet.js";
import { sendRematchOfferIfEligible } from "../handlers/matching/rematch.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import { sendPushToUser } from "./push.js";
import { pushReachable, telegramReachable } from "./telegram-reach.js";
import { ACTIVE_MATCH_STATUSES } from "./active-match-priority.js";
import { getPreviousBatchDate } from "./next-batch.js";
import { isQuietHours } from "../workers/quiet-hours.js";
import {
  buildCitySwitchKeyboard,
  isMarketPending,
} from "../handlers/menu/city-switch.js";

/**
 * The notices open with a `*bold*` heading line (copy audit 2026-10-01), but
 * they go out WITHOUT `parse_mode` — the city name is user data and the stream
 * path has no Markdown. So the leading `*…*` is lifted into a `bold` entity on
 * plain text instead. Offsets are UTF-16 code units, which is what JS string
 * lengths already count.
 */
export function leadBoldEntity(text: string): { text: string; entities?: MessageEntity[] } {
  const m = /^\*([^*\n]+)\*/.exec(text);
  if (!m) return { text };
  const heading = m[1]!;
  return {
    text: heading + text.slice(m[0].length),
    entities: [{ type: "bold", offset: 0, length: heading.length }],
  };
}

/**
 * The "still looking" notice — the waiting ladder (founder decision 2026-10-15).
 *
 * Runs after every drop (and on its fallback cron) over the `active` users the
 * matcher couldn't pair, but **silence is the default**: a person hears from us
 * only when they cross a step of `WAITING_NOTICE_MILESTONE_DAYS` (4, 7, 10,
 * 21, 45 days without a pair — dense in the first days, when a person decides
 * whether to stay; founder 2026-10-15), once per step, each step with its own
 * copy that says something new. Someone who skipped steps (paused, unreachable)
 * gets one notice for the latest step, never a catch-up burst; past day 45
 * nothing is sent automatically — the next message is a match. The tone holds
 * the position: no apology, no promised date or priority.
 *
 * It replaced a weekly tier ladder (tier = weeks since the last match) whose
 * first notice landed on the very first unpaired evening and whose tier-1 copy
 * repeated word for word a week later.
 *
 * **The notice cadence is deliberately decoupled from the batch cadence
 * (D4).** `CADENCE.famineNoticeIntervalMs` is 7 days in BOTH profiles: match
 * daily, apologise weekly (founder decision 2026-08-02). Under `daily` the
 * notice CRON still fires every evening, but the throttle is a query-level
 * filter, so a starved user simply isn't reconsidered until a week has passed
 * since their last notice — which means **a drop that finds them nobody sends
 * nothing at all**. That silence is the product: at small pool sizes most
 * evenings genuinely have nothing to report, and a nightly "sorry, no one
 * again" would turn a background search into a daily reminder of failure.
 * The waiting ladder replaces it: the query prefilter is the ladder's smallest
 * gap (`WAITING_NOTICE_MIN_GAP_MS`, 3 days); the 7-day throttle now applies
 * only to market-pending accounts, per person.
 *
 * The user-visible consequence of that silence — a pinned banner counting down
 * to a drop that will not announce itself — is handled separately by
 * `dropOutpacesNotices` (`@gennety/shared`), which the status banner reads to
 * drop its timer rather than let it reach zero into nothing.
 *
 * Steps are calendar days (`daysWaiting`), never batches, so the ladder reads
 * the same under any drop cadence.
 *
 * The query intentionally re-derives "who has no match this drop" from
 * the DB instead of being handed a list from `runDropBatch` — this keeps the
 * run safe to repeat / fire late without state coupling. "Has a match" means
 * ANY match still holding a live slot (A13-H10) — `proposed` whether or not
 * its pitch has gone out yet, `negotiating`, `negotiating_venue`, `scheduled` —
 * plus anything dispatched in this drop. It used to be only "dispatched in the
 * last hour", so a person mid-negotiation, on a scheduled date, or whose drop
 * pitch was still queued behind a slow dispatch was told nobody was found.
 */

/** Matches the client's `PushPayload` type strings. No `matchId` rides with
 *  it — this is the notification that there is no match. */
export const NO_MATCH_PUSH_TYPE = "match.none";

/**
 * Pause between two notices.
 *
 * It was two full seconds, which on a base of ten thousand is five and a half
 * hours of one cron invocation sending — long enough that `guardedTick`
 * swallows every subsequent firing, and long enough that a restart loses the
 * tail. Two seconds was never the limit anyway: Telegram allows one message per
 * second to the SAME chat and about thirty a second across different ones, and
 * every notice here goes to a different person.
 *
 * Since `api-limits.ts` the real guard is the global throttler, which queues
 * and paces every outbound call whatever this value says. What is left is a
 * politeness floor that keeps the throttler's queue short: ten notices a second
 * turns the same base into a quarter of an hour.
 */
export const DEFAULT_NOTIFY_DELAY_MS = 100;

/**
 * Candidates read per query, and how many such reads one invocation may make.
 *
 * Reads are keyset-paged by id (`candidateStream`): most people read are owed
 * no notice and get no claim, so the claim cannot be what moves the walk
 * forward. The loop also stops as soon as a read returns nobody it has not
 * already seen.
 */
const NOTICE_BATCH = 500;
const MAX_NOTICE_BATCHES = 40;

/**
 * DM copy per waiting-ladder step, in step order. Step 1 has an early-stage
 * variant (`waitingNotice1Early`, chosen while `EARLY_STAGE` is on) that says
 * plainly that Gennety has only just opened. Push copy is per step too — the
 * title is the DM's bold heading.
 */
const WAITING_NOTICE_KEYS = [
  "waitingNotice1",
  "waitingNotice2",
  "waitingNotice3",
  "waitingNotice4",
  "waitingNotice5",
] as const satisfies readonly TranslationKey[];
const WAITING_PUSH_KEYS = [
  ["waitingPush1Title", "waitingPush1Body"],
  ["waitingPush2Title", "waitingPush2Body"],
  ["waitingPush3Title", "waitingPush3Body"],
  ["waitingPush4Title", "waitingPush4Body"],
  ["waitingPush5Title", "waitingPush5Body"],
] as const satisfies ReadonlyArray<readonly [TranslationKey, TranslationKey]>;

/** DM copy key for a 1-based waiting-ladder step. */
export function waitingNoticeKey(step: number, earlyStage: boolean): TranslationKey {
  if (step <= 1) return earlyStage ? "waitingNotice1Early" : "waitingNotice1";
  return WAITING_NOTICE_KEYS[Math.min(step, WAITING_NOTICE_KEYS.length) - 1]!;
}

/** Push title/body keys for a 1-based waiting-ladder step. */
export function waitingPushKeys(step: number): readonly [TranslationKey, TranslationKey] {
  const i = Math.min(Math.max(step, 1), WAITING_PUSH_KEYS.length) - 1;
  return WAITING_PUSH_KEYS[i]!;
}

/**
 * Window (ms) used to decide whether a user "got matched in this drop" when the
 * run is close to the batch. The exclusion reaches back to whichever is
 * earlier, this window or the drop itself — so a run resumed the next morning
 * after quiet hours stopped it still recognises last evening's pitches.
 */
const RECENT_MATCH_WINDOW_MS = 60 * 60 * 1000;

export interface NoMatchNotifyResult {
  notified: number;
  skipped: number;
  failed: number;
  /** Waiting-ladder step 1 / step 2 / steps 3–6 sent this run. For a
   *  market-pending account the bucket is weeks waiting, as before. */
  tier1: number;
  tier2: number;
  tier3plus: number;
  /** Unpaired, reachable, and deliberately told nothing: no ladder step is due.
   *  Not claimed — silence is the default. */
  waiting: number;
  /** D10: users auto-paused this run because no candidate has existed for
   *  FAMINE_PAUSE_AFTER_DAYS days running. Counted separately from the tier
   *  buckets — a paused user gets a distinct message, not another tier DM. */
  paused: number;
  /** A13-M22: the run reached quiet hours and stopped with people left to tell.
   *  Nobody it stopped before was claimed, so the next run picks them up. */
  heldForQuietHours: boolean;
  errors: Array<{ userId: string; error: string }>;
}

/**
 * True when the user holds a match that still occupies their live slot.
 *
 * Checked again per person, right before the notice, because the candidate
 * page was read up to minutes earlier: a Rematch purchase, an event mutual or a
 * resumed dispatch can hand someone a match in between, and "we couldn't find
 * anyone" landing next to their pitch is precisely the contradiction this
 * exists to prevent. `db` is the transaction client inside the pause.
 */
async function holdsLiveMatch(
  db: Pick<Prisma.TransactionClient, "match">,
  userId: string,
): Promise<boolean> {
  const live = await db.match.count({
    where: {
      status: { in: [...ACTIVE_MATCH_STATUSES] },
      OR: [{ userAId: userId }, { userBId: userId }],
    },
  });
  return live > 0;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Floors `now` to UTC midnight of the same day. Used as the dedup key for
 * `NoMatchNotice` — the scheduled fallback fires once per day under `daily`, so day-granularity is
 * sufficient and `@@unique([userId, dropDate])` blocks accidental re-fires
 * within the same drop.
 */
export function getDropDate(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Smallest gap between two waiting-ladder steps — the candidate prefilter. */
export const WAITING_NOTICE_MIN_GAP_MS =
  Math.min(
    ...WAITING_NOTICE_MILESTONE_DAYS.slice(1).map((d, i) => d - WAITING_NOTICE_MILESTONE_DAYS[i]!),
  ) * DAY_MS;
const HOUR_MS = 60 * 60 * 1000;

/** What `resolveWaitingAnchor` needs from the candidate row. */
interface AnchorSource {
  id: string;
  createdAt?: Date | null;
  profile?: { calibrationUntil?: Date | null } | null;
}

/**
 * The moment a person's wait started — every waiting calculation (the ladder
 * step, D10's pause threshold) measures from here:
 *
 *   1. their most recent dispatched match;
 *   2. never matched → when they finished onboarding. There is no completion
 *      timestamp column, but the first-drop calibration window is armed at
 *      exactly that moment (`armFirstDropCalibration`), so it is
 *      `calibrationUntil − FIRST_DROP_CALIBRATION_HOURS`;
 *   3. a legacy account with no window → `createdAt`.
 *
 * It used to fall back to the person's FIRST `NoMatchNotice`, which made the
 * first notice its own anchor: it fired on the very first unpaired evening and
 * the streak was counted from there. Never anchored to a notice any more.
 */
export async function resolveWaitingAnchor(user: AnchorSource, fallback: Date): Promise<Date> {
  const lastMatch = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: user.id }, { userBId: user.id }],
      dispatchedAt: { not: null },
    },
    orderBy: { dispatchedAt: "desc" },
    select: { dispatchedAt: true },
  });
  if (lastMatch?.dispatchedAt) return lastMatch.dispatchedAt;

  const calibrationUntil = user.profile?.calibrationUntil;
  if (calibrationUntil) {
    return new Date(calibrationUntil.getTime() - env.FIRST_DROP_CALIBRATION_HOURS * HOUR_MS);
  }
  return user.createdAt ?? fallback;
}

/**
 * Whole calendar days (UTC dates, the same day key `NoMatchNotice.dropDate`
 * uses) from the anchor to the drop. Calendar days rather than elapsed hours
 * so a pitch dispatched at 18:40 a week ago still counts as seven days on an
 * 18:20 run.
 */
export function daysWaiting(anchor: Date, dropDate: Date): number {
  return Math.round((dropDate.getTime() - getDropDate(anchor).getTime()) / DAY_MS);
}

/**
 * The waiting-ladder step reached after `days` days: the 1-based index of the
 * largest `WAITING_NOTICE_MILESTONE_DAYS` entry ≤ `days`, or 0 before the first.
 */
export function waitingStepFor(days: number): number {
  let step = 0;
  WAITING_NOTICE_MILESTONE_DAYS.forEach((milestone, i) => {
    if (days >= milestone) step = i + 1;
  });
  return step;
}

/**
 * The step a notice is owed for right now, or 0 for silence.
 *
 * Owed iff a step has been reached AND no notice has gone out since that step
 * began (`lastNoticeAt` is the person's latest `NoMatchNotice.dropDate`). Only
 * the LATEST reached step is ever owed, so a person who skipped steps gets one
 * notice, not a burst; after the last step was told, nothing is owed ever again
 * within this wait. A new match moves the anchor and starts a new ladder.
 */
export function dueWaitingStep(
  anchor: Date,
  dropDate: Date,
  lastNoticeAt: Date | null | undefined,
): number {
  const step = waitingStepFor(daysWaiting(anchor, dropDate));
  if (step === 0) return 0;
  const stepBegan = getDropDate(anchor).getTime() + WAITING_NOTICE_MILESTONE_DAYS[step - 1]! * DAY_MS;
  if (lastNoticeAt && lastNoticeAt.getTime() >= stepBegan) return 0;
  return step;
}

/**
 * Weeks waiting, minimum 1 — the bucket a market-pending account's notice is
 * recorded under. Those accounts are outside the ladder (their notice is "we're
 * not in your city yet", on the plain `famineNoticeIntervalMs` throttle), so
 * this is analytics only.
 */
function weeksWaiting(anchor: Date, dropDate: Date): number {
  return Math.max(1, Math.floor(daysWaiting(anchor, dropDate) / 7));
}

/**
 * Find all `active` users without a live match or a pitch from this drop, tell
 * each of them on whichever rail(s) they own, and record a `NoMatchNotice` row
 * for analytics + idempotency.
 *
 * **Stops at quiet hours (A13-M22).** A large base paced out can run past
 * 23:00 Kyiv, and a consolation DM at midnight is worse than one at nine. The
 * check runs before each person, ahead of the claim, so whoever is left is
 * simply not claimed yet: `heldForQuietHours` tells the caller to run again
 * after the window (see `no-match-notice-job.ts`). The clock is the run's own
 * `now` advanced by elapsed wall time, so a caller that pins `now` gets a
 * deterministic answer.
 *
 * **The rail is `platform`, not the sign of `telegramId`.** This loop used to
 * drop every account with a synthetic negative id under a comment saying push
 * "goes via the Expo path" — a rail retired 2026-07-18 that had never carried
 * this notice even while it existed. An app-only user was simply never told
 * how their drop went: the same mechanic-on-one-surface-only hole as
 * `pitch.ts` (the drop itself) and `pre-date-safety.ts` (the brief).
 *
 * WHO is told and WHAT CARRIES it are two separate questions. The candidate
 * query answers the first ("the matcher found this person nobody"); the
 * `telegramReachable` / `pushReachable` pair answers the second, and a user on
 * `both` is told twice, once per rail. Only someone on NEITHER rail is
 * `skipped` — collapsing the two questions into one id test is the defect
 * §5.4 fixed and this is its tenth site.
 *
 * The push follows the DM it stands for — the ladder step's own title and
 * line, the pause's own, or the frozen market-pending line — but never names a
 * partner, quotes the discount or carries the city-switch button: those belong
 * to the DM, where their conditions are actually checked.
 */
export async function sendNoMatchNotices(
  api: Api<RawApi>,
  now: Date = new Date(),
  delayMs: number = DEFAULT_NOTIFY_DELAY_MS,
  // Injectable chunk streamer (mirrors the `streamImpl` seam in
  // `handlers/matching/pitch.ts`) so tests can inject a synchronous stub.
  streamImpl: typeof streamDraftsToChat = streamDraftsToChat,
): Promise<NoMatchNotifyResult> {
  const dropDate = getDropDate(now);
  // The drop this notice is about. A run can now finish the next morning (quiet
  // hours) or resume after a restart, so "this drop" is anchored to the batch
  // itself rather than to when the run happens to execute.
  const dropAt = getPreviousBatchDate(now);
  const recentSince = new Date(Math.min(now.getTime() - RECENT_MATCH_WINDOW_MS, dropAt.getTime()));
  const startedAtMs = Date.now();
  const inQuietHours = () => isQuietHours(new Date(now.getTime() + (Date.now() - startedAtMs)));
  // One clause per relation: a live slot of any kind, or a pitch from this drop
  // (which may already have been declined or expired — still not "nobody").
  const noLiveOrRecentMatch: Prisma.MatchListRelationFilter = {
    none: {
      OR: [
        { status: { in: [...ACTIVE_MATCH_STATUSES] } },
        { dispatchedAt: { gte: recentSince } },
      ],
    },
  };
  // D4: the throttle that decouples notice cadence from batch cadence. Under
  // `weekly` this equals the notice cron's own firing interval, so it's a
  // no-op beyond the exact-dropDate check it replaces. Under `daily` it's
  // wider than the (daily) cron interval, so most daily firings skip most
  // users — that gap is what makes "every 2-3 days" real. Strictly wider
  // than a same-day check, so it safely subsumes the old exact-`dropDate`
  // idempotency filter; the `@@unique([userId, dropDate])` constraint (via
  // `isUniqueViolation` below) remains the actual DB-level guarantee.
  //
  // Since the waiting ladder this is the cheap prefilter only, set to the
  // ladder's smallest gap — no two steps are closer, so nobody it hides could be
  // owed a notice. Who is actually told is decided per person (`dueWaitingStep`);
  // market-pending accounts keep `famineNoticeIntervalMs`, checked per person.
  const notifyCutoff = new Date(now.getTime() - WAITING_NOTICE_MIN_GAP_MS);

  const readCandidates = (afterId: string | null) =>
    prisma.user.findMany({
      take: NOTICE_BATCH,
      orderBy: { id: "asc" },
      where: {
        // Keyset cursor. Most candidates are now owed nothing and are passed over
        // WITHOUT a claim, so the claim alone can no longer move the read
        // forward — re-reading from the start would return the same page.
        ...(afterId ? { id: { gt: afterId } } : {}),
        status: "active",
        onboardingStep: "completed",
        // An account created after the drop was not in it, and must not be told
        // it found nobody — which a resumed run hours later would otherwise do.
        createdAt: { lt: dropAt },
        // Held out of this drop by the first-drop calibration window: it was not
        // searched against, so "found nobody" would be false.
        profile: calibrationOverWhere(dropAt),
        // Exclude users who hold a live match or got a pitch in this drop.
        AND: [
          { matchesAsA: noLiveOrRecentMatch },
          { matchesAsB: noLiveOrRecentMatch },
          // Prefilter: skip anyone notified within the ladder's smallest gap.
          {
            noMatchNotices: {
              none: { dropDate: { gte: notifyCutoff } },
            },
          },
        ],
      },
      select: {
        id: true,
        telegramId: true,
        // Load-bearing: the rail predicates read `platform`, and a row that
        // doesn't select it arrives as `undefined` — which `telegramReachable`
        // reads as "pre-column row, assume Telegram" and `pushReachable` reads
        // as "no app rail". The result is not an exception; it is a notice
        // addressed to a chat the user will never open.
        platform: true,
        language: true,
        createdAt: true,
        profile: { select: { homeCityKey: true, homeCity: true, calibrationUntil: true } },
        // The latest notice: what decides whether the current ladder step was
        // already told.
        noMatchNotices: { select: { dropDate: true }, orderBy: { dropDate: "desc" }, take: 1 },
      },
    });

  const result: NoMatchNotifyResult = {
    notified: 0,
    skipped: 0,
    failed: 0,
    tier1: 0,
    tier2: 0,
    tier3plus: 0,
    waiting: 0,
    paused: 0,
    heldForQuietHours: false,
    errors: [],
  };

  /**
   * Walk the candidates a page at a time instead of holding the whole active
   * base in memory.
   *
   * Keyset-paged by id: most people read are owed nothing this evening and
   * are passed over without a claim, as is anyone on no rail at all, so the
   * claim cannot be what moves the walk forward. `seen` stays as the backstop
   * against a page that hands the same person back.
   */
  async function* candidateStream() {
    const seen = new Set<string>();
    let afterId: string | null = null;
    for (let batch = 0; batch < MAX_NOTICE_BATCHES; batch += 1) {
      if (inQuietHours()) {
        result.heldForQuietHours = true;
        return;
      }
      const page = await readCandidates(afterId);
      if (page.length > 0) afterId = page[page.length - 1]!.id;
      // Filtered and recorded in the same pass, so a page that somehow repeats
      // a row cannot process the same person twice either.
      const fresh = page.filter((candidate) => {
        if (seen.has(candidate.id)) return false;
        seen.add(candidate.id);
        return true;
      });
      if (fresh.length === 0) return;
      for (const candidate of fresh) yield candidate;
      if (page.length < NOTICE_BATCH) return;
    }
    console.warn(
      `[no-match-notify] stopped at the ${MAX_NOTICE_BATCHES}-page cap — ` +
        "candidates remain and the next run will continue",
    );
  }

  let processed = 0;
  for await (const u of candidateStream()) {
    // Paced between notices rather than after the last one, so the run does not
    // end on a pointless sleep.
    if (processed > 0) await delay(delayMs);
    if (inQuietHours()) {
      result.heldForQuietHours = true;
      break;
    }
    processed += 1;

    const viaTelegram = telegramReachable(u);
    const viaPush = pushReachable(u);

    // Not "mobile-first" — unreachable, full stop. Someone on neither rail
    // (a legacy row with a synthetic negative id and no app rail claimed) is
    // the only person this service genuinely cannot tell anything, and is now
    // the only one it counts as `skipped`.
    //
    // Deliberately BEFORE the claim, so no `NoMatchNotice` row is written for
    // them. That row is both the analytics record of a notice and what marks a
    // ladder step as told, so claiming one for a notice nobody received would
    // silently use up a step they never heard.
    if (!viaTelegram && !viaPush) {
      result.skipped++;
      continue;
    }

    const anchor = await resolveWaitingAnchor(u, dropDate);
    const lang: Language = u.language ?? "en";
    const earlyStage = env.EARLY_STAGE;

    // An account registered in a city we haven't launched (PRODUCT_SPEC §1.1).
    // Matching is same-city, so the honest answer isn't "still looking" —
    // it's "we're not in your city yet", plus the one-tap move to a launched
    // market. The waiting ladder, a discount, or a paid Rematch would all sell
    // a drop they cannot be in. Outside the ladder: they keep the plain
    // `famineNoticeIntervalMs` throttle the candidate query applies.
    const marketPending = isMarketPending(u.profile?.homeCityKey);

    // D10: the pool has genuinely had nothing for this user for
    // FAMINE_PAUSE_AFTER_DAYS running — pause instead of another notice. Never
    // during the early stage (founder decision 2026-10-15): the base is still
    // gathering, so a long wait says nothing about the person, and the ladder
    // simply goes quiet after its last step. Not applicable to a market-pending
    // user either: their city switch, not a pause, is the honest fix.
    const days = daysWaiting(anchor, dropDate);
    const isPoolExhaustionPause =
      !earlyStage && !marketPending && days >= FAMINE_PAUSE_AFTER_DAYS;

    // The ladder step this notice is for. Silence is the default: no step owed
    // (and no pause to announce) means nothing is sent and nothing is claimed.
    const lastNoticeAt = u.noMatchNotices?.[0]?.dropDate;
    // Market-pending accounts stay on the plain weekly throttle (the query's
    // prefilter is now the ladder's 3-day gap, too short for them).
    if (
      marketPending &&
      lastNoticeAt &&
      lastNoticeAt.getTime() > now.getTime() - CADENCE.famineNoticeIntervalMs
    ) {
      result.waiting++;
      continue;
    }
    const dueStep = marketPending ? 0 : dueWaitingStep(anchor, dropDate, lastNoticeAt);
    if (!marketPending && !isPoolExhaustionPause && dueStep === 0) {
      result.waiting++;
      continue;
    }

    // The page is minutes old by now; someone may have been handed a match
    // since (see `holdsLiveMatch`). Not claimed, so nothing to undo.
    if (await holdsLiveMatch(prisma, u.id)) {
      result.skipped++;
      continue;
    }

    // `NoMatchNotice.tier`: the ladder step (1–5) — for a pause, the step the
    // wait has reached — or weeks waiting for a market-pending account.
    const tier = marketPending ? weeksWaiting(anchor, dropDate) : Math.max(1, waitingStepFor(days));

    let body = marketPending
      ? t(lang, "noMatchCityNotLaunched", {
          city: u.profile?.homeCity ?? u.profile?.homeCityKey ?? "",
        })
      : isPoolExhaustionPause
        ? t(lang, "poolExhaustedPauseNotice", {})
        : t(lang, waitingNoticeKey(dueStep, earlyStage), {});
    let pushKeys: readonly [TranslationKey, TranslationKey] = marketPending
      ? ["noMatchPushTitle", "noMatchPushBody"]
      : isPoolExhaustionPause
        ? ["poolExhaustedPausePushTitle", "poolExhaustedPausePushBody"]
        : waitingPushKeys(dueStep);

    // Ladder step 2+ (day 7 on) → grant the one-time single-ticket discount
    // and tell them in the same DM. Inert unless TICKET_FEATURE_ENABLED (the
    // grant self-gates), so the flag-off path keeps the plain step copy.
    // Skipped for a pause: that DM is a different message entirely, and
    // grafting a discount offer onto "we're pausing your search" reads oddly
    // — the discount (if already earned from an earlier step) is unaffected
    // and stays available for when they resume.
    if (!marketPending && !isPoolExhaustionPause && dueStep >= CADENCE.famineDiscountMinTier) {
      const grant = await grantFamineDiscountIfEligible(u.id);
      if (grant.granted && grant.pct) {
        body += `\n\n${t(lang, "noMatchDiscountOffer", { pct: grant.pct })}`;
      }
    }

    // Claim this dropDate for this user FIRST — this is what makes an
    // overlapping worker invocation's candidate query exclude them, so two
    // concurrent runs (e.g. a manual admin re-run overlapping the tail of the
    // scheduled cron) can never both send the same weekly notice.
    try {
      await prisma.noMatchNotice.create({
        data: { userId: u.id, tier, dropDate },
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // Another invocation already claimed (and is presumably sending)
        // this user's notice for this dropDate — not a failure, just skip.
        result.skipped++;
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ userId: u.id, error: message });
      result.failed++;
      console.error(
        `[no-match-notify] #${processed} userId=${u.id} claim FAILED: ${message}`,
      );
      continue;
    }

    // Hoisted out of the `try` so the catch below can undo a pause whose DM
    // never landed (see NOMATCH-2 there).
    let pausedNow = false;

    try {
      // Attempt the pause CAS FIRST when applicable — its outcome decides
      // which message actually goes out. A lost race (already not `active`
      // for some other reason — moderation, a manual pause/freeze between
      // candidate selection and here) falls back to the ladder step's DM when
      // one is owed, and to silence when not.
      //
      // NOMATCH-2: the status flip and the `starvationPausedAt` marker commit
      // TOGETHER. They are not two independent facts — the marker is the only
      // thing that makes this pause reversible, because `autoResumeStarvedUsers`
      // selects on `paused AND starvationPausedAt != null` while this notifier
      // only ever selects `active`. A user paused without the marker is
      // therefore invisible to both sweeps: silently, permanently out of the
      // pool with nothing in the product able to bring them back.
      if (isPoolExhaustionPause) {
        // A13-H10: "the pool has had nothing for you for two weeks" is only
        // true of someone who holds no match. Re-checked inside the same
        // transaction as the status flip, so a match that landed after the
        // check above cannot be paused out from under its holder.
        const transition = await prisma.$transaction(async (tx) => {
          if (await holdsLiveMatch(tx, u.id)) return { kind: "live-match" as const };
          const result = await transitionAccountStatus({ id: u.id }, "pause", tx);
          if (result.kind === "changed") {
            await tx.profile.updateMany({
              where: { userId: u.id },
              data: { starvationPausedAt: now },
            });
          }
          return result;
        });
        if (transition.kind === "live-match") {
          // Neither the pause nor any famine notice is true of them any more.
          await prisma.noMatchNotice.deleteMany({ where: { userId: u.id, dropDate } });
          result.skipped++;
          continue;
        }
        if (transition.kind === "changed") {
          pausedNow = true;
        } else if (dueStep > 0) {
          body = t(lang, waitingNoticeKey(dueStep, earlyStage), {});
          pushKeys = waitingPushKeys(dueStep);
        } else {
          // No pause, and no ladder step owed either: silence, as for anyone
          // else on an evening with nothing to say. Release the claim.
          await prisma.noMatchNotice.deleteMany({ where: { userId: u.id, dropDate } });
          result.waiting++;
          continue;
        }
      }

      // Each rail is attempted on its own and absorbs its own failure: a
      // blocked bot must not cost the push, and a dead APNs token must not
      // cost the DM — nor the claim, nor the pause.
      let delivered = false;
      let dmError: unknown;

      if (viaTelegram) {
        const lead = leadBoldEntity(body);
        try {
          if (marketPending) {
            // Plain send, not the rich "we really looked" stream — nothing was
            // searched for this user, so that beat would be a lie. It also carries
            // the switch button, which the draft-stream primitive cannot attach.
            await api.sendMessage(Number(u.telegramId), lead.text, {
              reply_markup: buildCitySwitchKeyboard(lang),
              ...(lead.entities ? { entities: lead.entities } : {}),
            });
          } else if (pausedNow) {
            // Plain send — this states a fact ("the pool is empty, you're
            // paused") rather than performing empathy for a search that, this
            // time, genuinely didn't run. Mirrors the market-pending treatment.
            await api.sendMessage(
              Number(u.telegramId),
              lead.text,
              lead.entities ? { entities: lead.entities } : undefined,
            );
          } else {
            // Deliberately SHORT stream (anti-drumroll): one "thinking" lead beat —
            // "we really looked" — then the full empathetic body as the persisted
            // send. We never spell out bad news slowly. Streams via the native rich
            // AI-compose path (`rich: true`): the lead beat (`thinkingIndex: 0`)
            // renders as a `<tg-thinking>` shimmer, the body is the plain final
            // `sendMessage`. No `parse_mode`: the only markup, the bold heading,
            // rides as an entity (`leadBoldEntity`). Degrades to the classic edited
            // stream on clients without rich-draft support.
            await streamImpl(
              api,
              Number(u.telegramId),
              [t(lang, "noMatchStreamStart"), lead.text],
              {
                rich: true,
                thinkingIndex: 0,
                thinkingEmojiId: AI_EMOJI.think,
                ...(lead.entities ? { entities: lead.entities } : {}),
              },
            );
          }
          delivered = true;
        } catch (err) {
          dmError = err;
        }
      }

      if (viaPush) {
        // The ladder step's own title and line (or the pause's, or the frozen
        // market-pending line) — never more than the DM. It cannot mention the city switch
        // (there is no button on a notification, §5.2) and it cannot quote the
        // famine discount, whose eligibility is decided per-user above and
        // whose offer lives in the DM. `sendPushToUser` resolves `false`
        // instead of throwing when there is no token / APNs is unconfigured /
        // APNs refused, so `false` here is a genuine "was not told" rather
        // than a swallowed exception.
        const pushed = await sendPushToUser(u.id, {
          title: t(lang, pushKeys[0]),
          body: t(lang, pushKeys[1]),
          data: { type: NO_MATCH_PUSH_TYPE },
        }).catch((err: unknown) => {
          console.warn(
            `[no-match-notify] push failed for ${u.id}:`,
            err instanceof Error ? err.message : err,
          );
          return false;
        });
        if (pushed) delivered = true;
      }

      // What "the notice failed" means now that there are two rails: NOTHING
      // arrived. One rail landing means a person who knows how their drop
      // went, so the claim stands, the pause stands, and they are counted
      // once — `notified` counts people, not messages. Zero rails landing is
      // precisely the event the single-rail version called a failed send, and
      // it takes the same two rollbacks below, both of which exist only to
      // undo state the user was never told about.
      if (!delivered) {
        throw (
          dmError ??
          new Error("push not delivered (no token, APNs unconfigured, or refused)")
        );
      }

      result.notified++;
      if (pausedNow) result.paused++;
      else if (tier === 1) result.tier1++;
      else if (tier === 2) result.tier2++;
      else result.tier3plus++;

      // Rematch offer (REMATCH_PRODUCT_SPEC.md, D4) — one of the two pain
      // moments the feature exists for. Sent as its OWN follow-up DM rather than
      // folded into the stream above: the no-match message is a deliberately
      // short, empathetic rich stream (§3.1) and bolting a price onto it would
      // undercut the empathy and complicate a carefully-tuned primitive.
      // Self-gating (flag, male-only, eligibility) lives in the sender, so this
      // is inert for everyone who can't or shouldn't buy. Skipped entirely for
      // a market-pending user (a paid re-run cannot find them anyone either)
      // and for a user just paused (same reason — the pool has nothing for
      // them, paid or not).
      // `viaTelegram` because the offer IS a Telegram DM carrying a Stars
      // button — Rematch has no app rail in v1 (`rematch.ts` self-gates on a
      // synthetic negative id for exactly that reason). Without this guard the
      // push-only branch would newly reach a send that can only fail: an
      // app-only account that signed in THROUGH Telegram carries a real
      // positive id the sender's own check waves through, on a chat the bot
      // cannot open. Nobody loses an offer they could have received.
      if (!marketPending && !pausedNow && viaTelegram) {
        await sendRematchOfferIfEligible(api, u.id, "famine", now).catch(() => {});
      }
    } catch (err) {
      // NOMATCH-1: the send failed after the claim landed. A famine discount
      // may already be durably granted and folded into `body` above (its own
      // idempotent columns on `User`, unaffected by this rollback), but the
      // notice row must not survive as a false "notified" record — that would
      // silently strand the discount announcement with no retry signal this
      // dropDate. Undo the claim so a same-week retry or next week's cron
      // (same-`dropDate` exclusion no longer applies) can find them again.
      await prisma.noMatchNotice
        .deleteMany({ where: { userId: u.id, dropDate } })
        .catch(() => {});
      // NOMATCH-2: same reasoning, one step further back. If we paused the
      // account and then failed to tell them, the pause is a state change the
      // user never consented to and was never informed of — and this notifier
      // only selects `active`, so it will never revisit them to try the DM
      // again. Undo it so the next run re-evaluates the whole decision and
      // re-sends. `resume` also clears `starvationPausedAt`, leaving no marker
      // behind to confuse the auto-resume sweep.
      if (pausedNow) {
        await transitionAccountStatus({ id: u.id }, "resume").catch(
          (undoErr: unknown) => {
            console.error(
              `[no-match-notify] userId=${u.id} left PAUSED after a failed notice — ` +
                `resume rollback also failed:`,
              undoErr,
            );
          },
        );
      }
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ userId: u.id, error: message });
      result.failed++;
      console.error(
        `[no-match-notify] #${processed} userId=${u.id} FAILED: ${message}`,
      );
    }

  }

  console.log(
    `[no-match-notify] ${result.heldForQuietHours ? "held for quiet hours" : "done"}: notified=${result.notified} tier1=${result.tier1} tier2=${result.tier2} tier3plus=${result.tier3plus} waiting=${result.waiting} skipped=${result.skipped} failed=${result.failed}`,
  );

  return result;
}
