import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { startVenueNegotiation } from "./venue-negotiation.js";
import { isTelegramTarget } from "../../utils/telegram-target.js";

/**
 * Progressive scheduler.
 *
 * Iterations (PRODUCT_SPEC.md §3.3):
 *   1 & 2: Bot proposes a small set of AI-generated slots. Both users pick.
 *          If their picks overlap → `scheduled`. Otherwise → next iteration.
 *   3:     Telegram Web App Calendar (Mini App). The Mini App posts selected
 *          slots via `Telegram.WebApp.sendData` — consumed by `handleWebAppData`.
 *
 * Callback data formats:
 *   - `sched:pick:{matchId}:{slotIndex}` — iter 1/2 user picks a slot.
 *     We encode the slot's INDEX into `match.proposedTimes`, not the full ISO
 *     timestamp, because Telegram caps `callback_data` at 64 bytes and a
 *     UUIDv4 (36) + ISO-8601 (24) + prefixes (~13) overflows. See `handleSchedulePick`
 *     for the index → Date resolution.
 *
 * The scheduler is called in three places:
 *   - `startScheduling(api, matchId)` — by the decision handler once both
 *     users have accepted.
 *   - `handleSchedulePick(ctx)` — by the router for `sched:pick:*` callbacks.
 *   - `handleCalendarWebAppData(ctx)` — by the router for `web_app_data`
 *     messages coming back from the Mini App.
 */

export const MAX_AI_ITERATIONS = 2;
export const PROPOSALS_PER_ROUND = 3;

/**
 * Generate AI proposal timeslots. Deterministic local stub by default
 * (Friday & Saturday evenings, 2-day lookahead) — the orchestrator swaps
 * this with a live LLM call later. The function is exported so tests can
 * assert the slot shape.
 */
export function generateProposalSlots(
  now: Date = new Date(),
  count: number = PROPOSALS_PER_ROUND,
): Date[] {
  // Pick the next `count` weekday evenings starting tomorrow. 19:00 local.
  const out: Date[] = [];
  const cursor = new Date(now);
  cursor.setHours(19, 0, 0, 0);
  cursor.setDate(cursor.getDate() + 1);
  while (out.length < count) {
    const day = cursor.getDay(); // 0 Sun – 6 Sat
    if (day !== 0 && day !== 1) {
      // Skip Sunday & Monday so dates land on "weekend vibes" slots.
      out.push(new Date(cursor));
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

/**
 * Build the inline keyboard for iteration 1/2 proposals. One button per
 * slot, plus a "None of these work" button that forces next iteration.
 */
export function buildProposalKeyboard(
  matchId: string,
  slots: Date[],
  _lang: Language,
): InlineKeyboardMarkup {
  // Build one button per row; avoid the trailing `.row()` that would
  // leave an empty last row in `inline_keyboard`.
  const kb = new InlineKeyboard();
  slots.forEach((slot, i) => {
    const label = formatSlotLabel(slot, _lang);
    // `i` is the slot index in `match.proposedTimes`. Keeps callback_data
    // under Telegram's 64-byte limit (UUID 36 + idx 1-2 + prefix 11 ≈ 50).
    kb.text(label, `sched:pick:${matchId}:${i}`);
    if (i < slots.length - 1) kb.row();
  });
  return { inline_keyboard: kb.inline_keyboard };
}

/** Short, language-aware slot label used on buttons. */
export function formatSlotLabel(slot: Date, lang: Language): string {
  const locale = lang === "ru" ? "ru-RU" : lang === "uk" ? "uk-UA" : "en-US";
  return slot.toLocaleString(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Iteration 3 keyboard: open the Calendar Mini App. */
export function buildCalendarKeyboard(
  webAppUrl: string,
  lang: Language,
): InlineKeyboardMarkup {
  const kb = new InlineKeyboard().webApp(t(lang, "matchScheduleBtnCalendar"), webAppUrl);
  return { inline_keyboard: kb.inline_keyboard };
}

/**
 * Begin scheduling for a match that has just entered `negotiating`.
 * Iterates to the next round (1, 2, or 3) and sends the appropriate UI
 * to both users.
 */
export async function startScheduling(
  api: Api<RawApi>,
  matchId: string,
): Promise<void> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      schedulingIteration: true,
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;

  const nextIter = match.schedulingIteration + 1;

  if (nextIter <= MAX_AI_ITERATIONS) {
    await sendIterationProposals(api, matchId, nextIter);
    return;
  }

  await sendCalendarIteration(api, matchId);
}

/** Send iteration 1 or 2 proposal buttons to both users. */
async function sendIterationProposals(
  api: Api<RawApi>,
  matchId: string,
  iteration: number,
): Promise<void> {
  const slots = generateProposalSlots();
  await prisma.match.update({
    where: { id: matchId },
    data: {
      schedulingIteration: iteration,
      proposedTimes: slots,
      pickedTimeA: null,
      pickedTimeB: null,
    },
  });

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;

  // M-17: only DM Telegram-resident users. Mobile-only users see iter-1/2
  // proposals through the `/v1/matches/current` poll, not via Telegram.
  const sends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userA.telegramId), t(langA, "matchScheduleProposal"), {
        reply_markup: buildProposalKeyboard(matchId, slots, langA),
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "matchScheduleProposal"), {
        reply_markup: buildProposalKeyboard(matchId, slots, langB),
      }),
    );
  }
  await Promise.all(sends);
}

/** Send iteration 3 — Web App Calendar button to both users. */
async function sendCalendarIteration(
  api: Api<RawApi>,
  matchId: string,
): Promise<void> {
  const webAppUrl = env.WEBAPP_URL;

  await prisma.match.update({
    where: { id: matchId },
    data: { schedulingIteration: 3 },
  });

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      userA: { select: { telegramId: true, language: true } },
      userB: { select: { telegramId: true, language: true } },
    },
  });
  if (!match) return;

  const langA = (match.userA.language ?? "en") as Language;
  const langB = (match.userB.language ?? "en") as Language;
  const url = `${webAppUrl}?match=${matchId}`;

  const sends: Array<Promise<unknown>> = [];
  if (isTelegramTarget(match.userA.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userA.telegramId), t(langA, "matchScheduleIter3"), {
        reply_markup: buildCalendarKeyboard(url, langA),
      }),
    );
  }
  if (isTelegramTarget(match.userB.telegramId)) {
    sends.push(
      api.sendMessage(Number(match.userB.telegramId), t(langB, "matchScheduleIter3"), {
        reply_markup: buildCalendarKeyboard(url, langB),
      }),
    );
  }
  await Promise.all(sends);
}

/** Callback handler for `sched:pick:*`. */
export async function handleSchedulePick(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("sched:pick:")) return;

  const parts = data.split(":");
  const matchId = parts[2];
  const idxRaw = parts[3];
  if (!matchId || idxRaw === undefined) return;

  await ctx.answerCallbackQuery();

  const idx = Number(idxRaw);
  if (!Number.isInteger(idx) || idx < 0) return;

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      status: true,
      schedulingIteration: true,
      proposedTimes: true,
      pickedTimeA: true,
      pickedTimeB: true,
    },
  });
  if (!match || match.status !== "negotiating") return;

  // Resolve the index into the actual slot. Out-of-bounds = stale button
  // (e.g. a different iteration's keyboard tapped after `proposedTimes` was
  // overwritten); silently ignore.
  if (idx >= match.proposedTimes.length) return;
  const picked = match.proposedTimes[idx]!;

  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true },
  });
  if (!user) return;

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return;

  await prisma.match.update({
    where: { id: match.id },
    data: isA ? { pickedTimeA: picked } : { pickedTimeB: picked },
  });

  const lang = ctx.session.language;
  await ctx.reply(
    t(lang, "matchSchedulePickedPrefix") + formatSlotLabel(picked, lang),
  );

  // Reload and evaluate overlap
  const updated = await prisma.match.findUnique({
    where: { id: match.id },
    select: { pickedTimeA: true, pickedTimeB: true, schedulingIteration: true },
  });
  if (!updated?.pickedTimeA || !updated.pickedTimeB) {
    await ctx.reply(t(lang, "matchScheduleWaitingPeer"));
    return;
  }

  if (updated.pickedTimeA.getTime() === updated.pickedTimeB.getTime()) {
    await startVenueNegotiation(ctx.api, match.id, updated.pickedTimeA);
    return;
  }

  // No overlap → advance iteration.
  await ctx.api.sendMessage(ctx.chat!.id, t(lang, "matchScheduleNoOverlap"));
  await startScheduling(ctx.api, match.id);
}

export type CalendarPickResult =
  | {
      ok: false;
      reason:
        | "invalid-iso"
        | "match-not-found"
        | "wrong-state"
        | "invalid-slot"
        | "user-not-found"
        | "not-participant";
    }
  | { ok: true; awaitingPeer: boolean; bothPicked: boolean };

/**
 * Apply an iter-3 calendar slot pick. Shared between two callers:
 *   - The legacy `web_app_data` handler (Mini Apps opened via reply keyboard
 *     or inline mode — currently unused but kept for forward compatibility).
 *   - The `POST /v1/calendar/pick` HTTP endpoint, used when the Mini App is
 *     opened via inline keyboard button (the actual production path; Telegram's
 *     `WebApp.sendData` is silently a no-op for that launch context, hence the
 *     HTTP endpoint).
 *
 * Validates match state + slot allowlist, records the pick, and on overlap
 * advances to venue negotiation. On a single-side pick the user is DM'd a
 * "waiting on peer" hint via the bot api.
 */
export async function processCalendarSlotPick(
  api: Api<RawApi>,
  telegramId: bigint,
  matchId: string,
  pickedIso: string,
): Promise<CalendarPickResult> {
  const picked = new Date(pickedIso);
  if (Number.isNaN(picked.getTime())) return { ok: false, reason: "invalid-iso" };

  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      status: true,
      schedulingIteration: true,
      proposedTimes: true,
      pickedTimeA: true,
      pickedTimeB: true,
    },
  });
  if (!match) return { ok: false, reason: "match-not-found" };
  if (match.status !== "negotiating" || match.schedulingIteration !== 3) {
    return { ok: false, reason: "wrong-state" };
  }
  if (!match.proposedTimes.some((slot) => slot.getTime() === picked.getTime())) {
    return { ok: false, reason: "invalid-slot" };
  }

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, language: true },
  });
  if (!user) return { ok: false, reason: "user-not-found" };

  const isA = user.id === match.userAId;
  const isB = user.id === match.userBId;
  if (!isA && !isB) return { ok: false, reason: "not-participant" };

  await prisma.match.update({
    where: { id: match.id },
    data: isA ? { pickedTimeA: picked } : { pickedTimeB: picked },
  });

  const updated = await prisma.match.findUnique({
    where: { id: match.id },
    select: { pickedTimeA: true, pickedTimeB: true },
  });

  if (!updated?.pickedTimeA || !updated.pickedTimeB) {
    const lang = (user.language ?? "en") as Language;
    await api
      .sendMessage(Number(telegramId), t(lang, "matchScheduleWaitingPeer"))
      .catch(() => {});
    return { ok: true, awaitingPeer: true, bothPicked: false };
  }

  // In iter-3 we treat the *earliest common slot* as agreed — the Mini App
  // can refine the protocol later. For now, if both users submit the same
  // ISO timestamp we're done; otherwise we keep iteration 3 open.
  if (updated.pickedTimeA.getTime() === updated.pickedTimeB.getTime()) {
    await startVenueNegotiation(api, match.id, updated.pickedTimeA);
  }

  return { ok: true, awaitingPeer: false, bothPicked: true };
}

/**
 * Consume `web_app_data` from the Calendar Mini App (legacy path: only fires
 * for Mini Apps opened via reply keyboard / inline mode). Production path is
 * the HTTP `POST /v1/calendar/pick` endpoint — see `processCalendarSlotPick`.
 */
export async function handleCalendarWebAppData(ctx: BotContext): Promise<void> {
  const dataStr = ctx.message?.web_app_data?.data;
  if (!dataStr) return;

  let parsed: { matchId?: string; pickedIso?: string };
  try {
    parsed = JSON.parse(dataStr);
  } catch {
    return;
  }
  if (!parsed.matchId || !parsed.pickedIso) return;
  if (!ctx.from?.id) return;

  await processCalendarSlotPick(
    ctx.api,
    BigInt(ctx.from.id),
    parsed.matchId,
    parsed.pickedIso,
  );
}
