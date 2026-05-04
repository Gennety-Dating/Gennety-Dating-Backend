import type { Api, RawApi } from "grammy";
import { GrammyError } from "grammy";
import { prisma } from "@gennety/db";
import type { Language } from "@gennety/shared";
import {
  minutesLeftFromDispatch,
  renderCountdownPlate,
} from "../utils/countdown-plate.js";
import { buildMatchKeyboard } from "../handlers/matching/pitch.js";

/**
 * Live countdown worker for `proposed` match pitches.
 *
 * Runs every 5 minutes (see `PROPOSAL_COUNTDOWN_CRON_SCHEDULE` in
 * index.ts). For each open proposal:
 *   1. Compute the per-side rendered plate text using the shared helper
 *      in `countdown-plate.ts`. The ceil-hours / raw-minutes split there
 *      naturally produces the product cadence: hourly edits during the
 *      first 23 hours, then 5-minute edits in the final hour.
 *   2. Skip the edit when the rendered plate matches the in-memory cache
 *      (no-op on Telegram, no quota burned).
 *   3. `editMessageText` rebuilds the message body as `pitch + plate` and
 *      re-applies the Accept/Decline keyboard.
 *
 * Sides that already accepted are skipped — only the proposer's UI for
 * the other (still-pending) half keeps ticking. Sides whose pitch DM
 * never reached Telegram (`pitchMessageId{A,B} == null`, e.g. mobile-only
 * users) are also skipped — the Expo client gets the deadline via the
 * public API and renders its own real-time timer.
 *
 * Recovery: a 400 "message to edit not found" / 403 means the user wiped
 * the chat or blocked the bot. We null out the corresponding
 * `pitchMessageId{A,B}` so we stop retrying on subsequent ticks.
 */

const MAX_EDITS_PER_SECOND = 25;

export interface ProposalCountdownOptions {
  now?: Date;
  /** In-memory cache keyed by `${matchId}:${side}`. */
  renderCache?: Map<string, string>;
  sleep?: (ms: number) => Promise<void>;
}

export interface ProposalCountdownResult {
  scanned: number;
  edited: number;
  skippedSameText: number;
  cleared: number;
  errors: number;
}

const defaultCache = new Map<string, string>();
const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

interface PendingEdit {
  matchId: string;
  side: "A" | "B";
  telegramId: bigint;
  messageId: number;
  lang: Language;
  body: string;
  plate: string;
  cacheKey: string;
}

export async function proposalCountdownTick(
  api: Api<RawApi>,
  options: ProposalCountdownOptions = {},
): Promise<ProposalCountdownResult> {
  const now = options.now ?? new Date();
  const cache = options.renderCache ?? defaultCache;
  const sleep = options.sleep ?? defaultSleep;

  const matches = await prisma.match.findMany({
    where: {
      status: "proposed",
      dispatchedAt: { not: null },
      OR: [
        { pitchMessageIdA: { not: null } },
        { pitchMessageIdB: { not: null } },
      ],
      // If both already accepted, the decision handler is about to flip
      // status to `negotiating` — skip to avoid racing with that flip.
      NOT: {
        AND: [{ acceptedByA: true }, { acceptedByB: true }],
      },
    },
    select: {
      id: true,
      dispatchedAt: true,
      pitchForA: true,
      pitchForB: true,
      pitchMessageIdA: true,
      pitchMessageIdB: true,
      acceptedByA: true,
      acceptedByB: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });

  const result: ProposalCountdownResult = {
    scanned: matches.length,
    edited: 0,
    skippedSameText: 0,
    cleared: 0,
    errors: 0,
  };

  // Build the per-side edit list. Cache hits drop out here so the
  // rate-limiter only paces real network calls.
  const pending: PendingEdit[] = [];
  for (const match of matches) {
    const minutesLeft = minutesLeftFromDispatch(match.dispatchedAt!, now);
    // Past TTL — leave it to the expiry job, which overwrites the body
    // and clears the keyboard atomically with the `proposed → expired`
    // flip. Editing here would race that overwrite.
    if (minutesLeft <= 0) continue;

    for (const side of ["A", "B"] as const) {
      const messageId = side === "A" ? match.pitchMessageIdA : match.pitchMessageIdB;
      const accepted = side === "A" ? match.acceptedByA : match.acceptedByB;
      const pitch = side === "A" ? match.pitchForA : match.pitchForB;
      const user = side === "A" ? match.userA : match.userB;
      if (messageId == null) continue;
      if (accepted === true) continue;
      if (!pitch) continue;

      const lang: Language = (user.language as Language) ?? "en";
      const plate = renderCountdownPlate(lang, minutesLeft);
      const cacheKey = `${match.id}:${side}`;
      if (cache.get(cacheKey) === plate) {
        result.skippedSameText++;
        continue;
      }

      pending.push({
        matchId: match.id,
        side,
        telegramId: user.telegramId,
        messageId,
        lang,
        body: pitch,
        plate,
        cacheKey,
      });
    }
  }

  let editsThisSecond = 0;
  let windowStart = Date.now();

  for (const edit of pending) {
    if (editsThisSecond >= MAX_EDITS_PER_SECOND) {
      const elapsed = Date.now() - windowStart;
      if (elapsed < 1000) await sleep(1000 - elapsed);
      editsThisSecond = 0;
      windowStart = Date.now();
    }

    const finalText = `${edit.body}\n\n${edit.plate}`;
    try {
      await api.editMessageText(
        Number(edit.telegramId),
        edit.messageId,
        finalText,
        { reply_markup: buildMatchKeyboard(edit.matchId, edit.lang) },
      );
      cache.set(edit.cacheKey, edit.plate);
      result.edited++;
      editsThisSecond++;
    } catch (err) {
      if (
        err instanceof GrammyError &&
        err.description.toLowerCase().includes("message is not modified")
      ) {
        cache.set(edit.cacheKey, edit.plate);
        result.skippedSameText++;
        continue;
      }
      const outcome = await handleEditError(err, edit, cache);
      if (outcome === "cleared") result.cleared++;
      else result.errors++;
    }
  }

  return result;
}

type EditOutcome = "cleared" | "retry-skipped" | "unknown";

async function handleEditError(
  err: unknown,
  edit: PendingEdit,
  cache: Map<string, string>,
): Promise<EditOutcome> {
  if (err instanceof GrammyError) {
    const desc = err.description.toLowerCase();
    const unrecoverable =
      err.error_code === 403 ||
      desc.includes("message to edit not found") ||
      desc.includes("message can't be edited") ||
      desc.includes("chat not found") ||
      desc.includes("message_id_invalid");

    if (unrecoverable) {
      // Null out the per-side message id so we stop scanning this row
      // until a fresh dispatch (which won't happen — this match is dead
      // for editing). The match itself stays `proposed` until the TTL
      // tick flips it.
      await prisma.match.update({
        where: { id: edit.matchId },
        data:
          edit.side === "A"
            ? { pitchMessageIdA: null }
            : { pitchMessageIdB: null },
      });
      cache.delete(edit.cacheKey);
      return "cleared";
    }

    if (err.error_code === 429 || err.error_code >= 500) {
      console.warn(
        `[proposal-countdown] transient ${err.error_code} for ${edit.telegramId}: ${err.description}`,
      );
      return "retry-skipped";
    }
  }

  console.warn(
    `[proposal-countdown] unexpected edit failure matchId=${edit.matchId} side=${edit.side}:`,
    (err as Error).message,
  );
  return "unknown";
}
