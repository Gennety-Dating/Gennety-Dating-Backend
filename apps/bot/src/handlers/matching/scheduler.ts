import type { Api, RawApi } from "grammy";
import { InlineKeyboard } from "grammy";
import type { InlineKeyboardMarkup } from "grammy/types";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import { env } from "../../config.js";
import { startVenueNegotiation } from "./venue-negotiation.js";

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
 *   - `sched:pick:{matchId}:{isoTimestamp}` — iter 1/2 user picks a slot
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
    kb.text(label, `sched:pick:${matchId}:${slot.toISOString()}`);
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

  await Promise.all([
    api.sendMessage(Number(match.userA.telegramId), t(langA, "matchScheduleProposal"), {
      reply_markup: buildProposalKeyboard(matchId, slots, langA),
    }),
    api.sendMessage(Number(match.userB.telegramId), t(langB, "matchScheduleProposal"), {
      reply_markup: buildProposalKeyboard(matchId, slots, langB),
    }),
  ]);
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

  await Promise.all([
    api.sendMessage(Number(match.userA.telegramId), t(langA, "matchScheduleIter3"), {
      reply_markup: buildCalendarKeyboard(url, langA),
    }),
    api.sendMessage(Number(match.userB.telegramId), t(langB, "matchScheduleIter3"), {
      reply_markup: buildCalendarKeyboard(url, langB),
    }),
  ]);
}

/** Callback handler for `sched:pick:*`. */
export async function handleSchedulePick(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("sched:pick:")) return;

  const parts = data.split(":");
  const matchId = parts[2];
  const iso = parts.slice(3).join(":");
  if (!matchId || !iso) return;

  await ctx.answerCallbackQuery();

  const picked = new Date(iso);
  if (Number.isNaN(picked.getTime())) return;

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

  // Guard: only allow slots from the current proposal set.
  const valid = match.proposedTimes.some((t) => t.getTime() === picked.getTime());
  if (!valid) return;

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

/**
 * Consume `web_app_data` from the Calendar Mini App. The Mini App posts
 * a JSON string `{ matchId, pickedIso }` via `Telegram.WebApp.sendData`.
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

  const picked = new Date(parsed.pickedIso);
  if (Number.isNaN(picked.getTime())) return;

  const match = await prisma.match.findUnique({
    where: { id: parsed.matchId },
    select: {
      id: true,
      userAId: true,
      userBId: true,
      status: true,
      schedulingIteration: true,
      pickedTimeA: true,
      pickedTimeB: true,
    },
  });
  if (!match || match.status !== "negotiating" || match.schedulingIteration !== 3) return;

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

  const updated = await prisma.match.findUnique({
    where: { id: match.id },
    select: { pickedTimeA: true, pickedTimeB: true },
  });
  if (!updated?.pickedTimeA || !updated.pickedTimeB) {
    const lang = ctx.session.language;
    await ctx.reply(t(lang, "matchScheduleWaitingPeer"));
    return;
  }

  // In iter-3 we treat the *earliest common slot* as agreed — the Mini App
  // can refine the protocol later. For now, if both users submit the same
  // ISO timestamp we're done; otherwise we keep iteration 3 open.
  if (updated.pickedTimeA.getTime() === updated.pickedTimeB.getTime()) {
    await startVenueNegotiation(ctx.api, match.id, updated.pickedTimeA);
  }
}

