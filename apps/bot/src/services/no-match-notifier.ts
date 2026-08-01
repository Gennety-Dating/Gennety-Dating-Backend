import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import {
  CADENCE,
  FAMINE_PAUSE_AFTER_DAYS,
  t,
  type Language,
  type TranslationKey,
} from "@gennety/shared";
import { streamDraftsToChat } from "./ai-stream.js";
import { AI_EMOJI } from "./ai-emoji.js";
import { grantFamineDiscountIfEligible } from "./ticket-discount.js";
import { isUniqueViolation } from "./ticket-wallet.js";
import { sendRematchOfferIfEligible } from "../handlers/matching/rematch.js";
import { transitionAccountStatus } from "./account-status-transitions.js";
import {
  buildCitySwitchKeyboard,
  isMarketPending,
} from "../handlers/menu/city-switch.js";

/**
 * Empathetic "no match" DM.
 *
 * Fires on its own cron (`CADENCE.noMatchNoticeCron` — 15 min after the
 * Thursday batch under `weekly`, daily under `daily`) for every `active`
 * user that the matcher couldn't pair. Replaces the old `notifyStarved` flow
 * — we send one well-crafted message instead of the curt "10/10 not found"
 * ping. Tone escalates with consecutive famine cycles (tier 1 → 2 → 3+).
 *
 * **The notice cadence is deliberately decoupled from the batch cadence
 * (D4).** Under `daily`, the notice CRON still fires once a day, but
 * `CADENCE.famineNoticeIntervalMs` (~2.5 days) throttles actual sends at the
 * query level — a starved user isn't reconsidered until that gap has passed
 * since their last notice, so daily drops don't mean daily bad-news DMs.
 * Under `weekly` this collapses back to exactly today's behavior: the
 * interval (7 days) and the cron's own weekly firing agree, so every drop
 * that leaves someone unpaired sends exactly one notice.
 *
 * `computeTier` is denominated in `CADENCE.intervalMs` units — weeks under
 * `weekly` (unchanged from the old `NoMatchNotice`-row-counting logic, which
 * produced the same number as long as the notice cron fired once per drop),
 * days under `daily`. This is what makes `FAMINE_DISCOUNT_MIN_TIER`-style
 * thresholds ("2nd week+", "7 days+") keep meaning the same thing in the
 * unit that's actually accruing.
 *
 * The query intentionally re-derives "who has no match this drop" from
 * the DB (active users without a `Match.dispatchedAt` in the last hour)
 * instead of being handed a list from `runDropBatch` — this keeps the
 * cron safe to re-run / fire late without state coupling.
 */

export const DEFAULT_NOTIFY_DELAY_MS = 2000;

/**
 * Window (ms) used to decide whether a user "got matched in this drop".
 * Cron fires 15 min after the batch; dispatch takes a few minutes — a
 * 1-hour window comfortably covers both while excluding any stale matches.
 */
const RECENT_MATCH_WINDOW_MS = 60 * 60 * 1000;

export interface NoMatchNotifyResult {
  notified: number;
  skipped: number;
  failed: number;
  tier1: number;
  tier2: number;
  tier3plus: number;
  /** D10: users auto-paused this run because no candidate has existed for
   *  FAMINE_PAUSE_AFTER_DAYS days running. Counted separately from the tier
   *  buckets — a paused user gets a distinct message, not another tier DM. */
  paused: number;
  errors: Array<{ userId: string; error: string }>;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Floors `now` to UTC midnight of the same day. Used as the dedup key for
 * `NoMatchNotice` — the cron fires once per Thursday so day-granularity is
 * sufficient and `@@unique([userId, dropDate])` blocks accidental re-fires
 * within the same drop.
 */
export function getDropDate(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The anchor every famine calculation (tier, and D10's pause threshold)
 * measures elapsed time from: the user's most recent dispatched match. For a
 * user who has NEVER been dispatched a match, anchoring to the Unix epoch
 * would produce an absurd result on their very first check (tens of
 * thousands of elapsed days) — so that case anchors to their EARLIEST
 * `NoMatchNotice` instead (the start of their very first famine streak),
 * falling back to `dropDate` itself when even that doesn't exist yet.
 */
async function resolveSinceDate(userId: string, dropDate: Date): Promise<Date> {
  const lastMatch = await prisma.match.findFirst({
    where: {
      OR: [{ userAId: userId }, { userBId: userId }],
      dispatchedAt: { not: null },
    },
    orderBy: { dispatchedAt: "desc" },
    select: { dispatchedAt: true },
  });
  if (lastMatch?.dispatchedAt) return lastMatch.dispatchedAt;

  const firstNotice = await prisma.noMatchNotice.findFirst({
    where: { userId },
    orderBy: { dropDate: "asc" },
    select: { dropDate: true },
  });
  return firstNotice?.dropDate ?? dropDate;
}

/**
 * Tier = consecutive batch intervals without a match, starting at 1 for the
 * current drop. Denominated in `CADENCE.intervalMs` — under `weekly` that's
 * weeks (unchanged from the historical row-counting logic: counting
 * `NoMatchNotice` rows since the last match produced the same number as long
 * as exactly one notice fired per drop, which weekly's unthrottled cadence
 * guarantees); under `daily` it's literally days, which is what makes
 * `FAMINE_DISCOUNT_MIN_TIER`-style day thresholds (D5) mean actual days
 * rather than "number of notices sent" once notices stop firing every drop
 * (D4's whole point).
 */
function computeTier(sinceDate: Date, dropDate: Date): number {
  const elapsedMs = dropDate.getTime() - sinceDate.getTime();
  return Math.max(1, Math.floor(elapsedMs / CADENCE.intervalMs));
}

/**
 * D10: raw elapsed CALENDAR DAYS without a match — deliberately NOT the same
 * unit as `computeTier` (which is cadence-relative: weeks under `weekly`).
 * `FAMINE_PAUSE_AFTER_DAYS` means 14 actual days regardless of how often the
 * batch runs, so the pause decision needs its own, cadence-independent
 * day-count rather than reusing `tier`.
 */
function daysWithoutMatch(sinceDate: Date, dropDate: Date): number {
  return Math.floor((dropDate.getTime() - sinceDate.getTime()) / DAY_MS);
}

function templateKeyForTier(tier: number): TranslationKey {
  if (tier <= 1) return "noMatchThisWeekTier1";
  if (tier === 2) return "noMatchThisWeekTier2";
  return "noMatchThisWeekTier3";
}

/**
 * Find all `active` users with no dispatched match in the last
 * `RECENT_MATCH_WINDOW_MS`, send each the tier-appropriate DM, and record
 * a `NoMatchNotice` row for analytics + idempotency.
 *
 * Mobile-only accounts (`telegramId <= 0`) are skipped — push goes via
 * the Expo path; not in scope for this service.
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
  const recentSince = new Date(now.getTime() - RECENT_MATCH_WINDOW_MS);
  // D4: the throttle that decouples notice cadence from batch cadence. Under
  // `weekly` this equals the notice cron's own firing interval, so it's a
  // no-op beyond the exact-dropDate check it replaces. Under `daily` it's
  // wider than the (daily) cron interval, so most daily firings skip most
  // users — that gap is what makes "every 2-3 days" real. Strictly wider
  // than a same-day check, so it safely subsumes the old exact-`dropDate`
  // idempotency filter; the `@@unique([userId, dropDate])` constraint (via
  // `isUniqueViolation` below) remains the actual DB-level guarantee.
  const notifyCutoff = new Date(now.getTime() - CADENCE.famineNoticeIntervalMs);

  const candidates = await prisma.user.findMany({
    where: {
      status: "active",
      onboardingStep: "completed",
      // Exclude users who got a match dispatched in this drop window
      AND: [
        {
          matchesAsA: {
            none: { dispatchedAt: { gte: recentSince } },
          },
        },
        {
          matchesAsB: {
            none: { dispatchedAt: { gte: recentSince } },
          },
        },
        // Throttle: skip anyone notified within the last famineNoticeIntervalMs.
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
      language: true,
      profile: { select: { homeCityKey: true, homeCity: true } },
    },
  });

  const result: NoMatchNotifyResult = {
    notified: 0,
    skipped: 0,
    failed: 0,
    tier1: 0,
    tier2: 0,
    tier3plus: 0,
    paused: 0,
    errors: [],
  };

  for (let i = 0; i < candidates.length; i++) {
    const u = candidates[i]!;

    // Mobile-first account — handled by the push path, not Telegram.
    if (u.telegramId <= 0n) {
      result.skipped++;
      continue;
    }

    const sinceDate = await resolveSinceDate(u.id, dropDate);
    const tier = computeTier(sinceDate, dropDate);
    const lang: Language = u.language ?? "en";

    // An account registered in a city we haven't launched (PRODUCT_SPEC §1.1).
    // Matching is same-city, so the honest answer isn't "no match this week" —
    // it's "we're not in your city yet", plus the one-tap move to a launched
    // market. Escalating famine tiers, granting a discount, or offering a paid
    // Rematch would all sell a drop they cannot be in.
    const marketPending = isMarketPending(u.profile?.homeCityKey);

    // D10: the pool has genuinely had nothing for this user for
    // FAMINE_PAUSE_AFTER_DAYS running — pause instead of another famine tier.
    // Not applicable to a market-pending user: their city switch, not a
    // pause, is the honest fix (and days-without-a-match there measures
    // nothing meaningful — they were never in a pool to begin with).
    const daysStarved = daysWithoutMatch(sinceDate, dropDate);
    const isPoolExhaustionPause = !marketPending && daysStarved >= FAMINE_PAUSE_AFTER_DAYS;

    let body = marketPending
      ? t(lang, "noMatchCityNotLaunched", {
          city: u.profile?.homeCity ?? u.profile?.homeCityKey ?? "",
        })
      : isPoolExhaustionPause
        ? t(lang, "poolExhaustedPauseNotice", {})
        : t(lang, templateKeyForTier(tier), {});

    // 2nd consecutive famine week+ → grant the one-time single-ticket discount
    // and tell them in the same DM. Inert unless TICKET_FEATURE_ENABLED (the
    // grant self-gates), so the flag-off path keeps the plain tier template.
    // Skipped for a pause: that DM is a different message entirely, and
    // grafting a discount offer onto "we're pausing your search" reads oddly
    // — the discount (if already earned from an earlier tier) is unaffected
    // and stays available for when they resume.
    if (!marketPending && !isPoolExhaustionPause && tier >= CADENCE.famineDiscountMinTier) {
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
        `[no-match-notify] ${i + 1}/${candidates.length} userId=${u.id} claim FAILED: ${message}`,
      );
      continue;
    }

    try {
      // Attempt the pause CAS FIRST when applicable — its outcome decides
      // which message actually goes out. A lost race (already not `active`
      // for some other reason — moderation, a manual pause/freeze between
      // candidate selection and here) falls back to the ordinary tier DM
      // rather than sending nothing.
      let pausedNow = false;
      if (isPoolExhaustionPause) {
        const transition = await transitionAccountStatus({ id: u.id }, "pause");
        if (transition.kind === "changed") {
          pausedNow = true;
          await prisma.profile.updateMany({
            where: { userId: u.id },
            data: { starvationPausedAt: now },
          });
        } else {
          body = t(lang, templateKeyForTier(tier), {});
        }
      }

      if (marketPending) {
        // Plain send, not the rich "we really looked" stream — nothing was
        // searched for this user, so that beat would be a lie. It also carries
        // the switch button, which the draft-stream primitive cannot attach.
        await api.sendMessage(Number(u.telegramId), body, {
          reply_markup: buildCitySwitchKeyboard(lang),
        });
      } else if (pausedNow) {
        // Plain send — this states a fact ("the pool is empty, you're
        // paused") rather than performing empathy for a search that, this
        // time, genuinely didn't run. Mirrors the market-pending treatment.
        await api.sendMessage(Number(u.telegramId), body);
      } else {
        // Deliberately SHORT stream (anti-drumroll): one "thinking" lead beat —
        // "we really looked" — then the full empathetic body as the persisted
        // send. We never spell out bad news slowly. Streams via the native rich
        // AI-compose path (`rich: true`): the lead beat (`thinkingIndex: 0`)
        // renders as a `<tg-thinking>` shimmer, the body is the plain final
        // `sendMessage`. The templates carry no Markdown (emoji + `•` bullets +
        // newlines only), so the plain final send renders identically —
        // `parse_mode` is intentionally dropped. Degrades to the classic edited
        // stream on clients without rich-draft support.
        await streamImpl(
          api,
          Number(u.telegramId),
          [t(lang, "noMatchStreamStart"), body],
          { rich: true, thinkingIndex: 0, thinkingEmojiId: AI_EMOJI.think },
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
      if (!marketPending && !pausedNow) {
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
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ userId: u.id, error: message });
      result.failed++;
      console.error(
        `[no-match-notify] ${i + 1}/${candidates.length} userId=${u.id} FAILED: ${message}`,
      );
    }

    if (i < candidates.length - 1) {
      await delay(delayMs);
    }
  }

  console.log(
    `[no-match-notify] done: notified=${result.notified} tier1=${result.tier1} tier2=${result.tier2} tier3plus=${result.tier3plus} skipped=${result.skipped} failed=${result.failed}`,
  );

  return result;
}
