/**
 * «Вы вообще встретились?» — сбор факта явки на T+24h (PRODUCT_SPEC §Phase 4).
 *
 * Стоит ПЕРЕД формой обратной связи, потому что вопросы формы — химия 1–10 и
 * второе свидание — это вопросы ПРО свидание, и человеку, которого не
 * дождались, они бессмысленны. Раньше форма приходила всем одинаково, и продукт
 * не знал, состоялась ли встреча, вообще никак: `Match.status = 'completed'`
 * ставится по таймеру, а не по факту.
 *
 * Ответ живого человека — единственное, что пишет `dateAttended*`. Улики
 * (`attendance-evidence.ts`) выбирают формулировку вопроса и ничего больше;
 * почему именно так — см. шапку `services/attendance.ts`.
 */

import { prisma, type Theme } from "@gennety/db";
import { t } from "@gennety/shared";
import type { BotContext } from "../../session.js";
import {
  classifyAttendanceReply,
  isAttendanceOutcome,
  type AttendanceOutcome,
} from "../../services/attendance.js";
import {
  buildAttendanceOutcomeKeyboard,
  buildFeedbackKeyboard,
} from "../../services/post-date-keyboards.js";
import {
  claimMatchFlow,
  matchFlowClaimIsLive,
  releaseMatchFlowClaim,
} from "../../services/match-flow-claim.js";

export const ATTENDANCE_PREFIX = "attend:";

type SideResolution =
  | { ok: true; isA: boolean; userId: string; theme: Theme }
  | { ok: false };

/**
 * Кто из участников это и можно ли ему сейчас отвечать.
 *
 * `status = 'completed'` — тот же гейт, что у формы: вопрос задаётся ровно в
 * момент этого перехода, поэтому матч в любом другом состоянии означает
 * протухшую кнопку из старого сообщения.
 */
async function resolveSide(ctx: BotContext, matchId: string): Promise<SideResolution> {
  const match = await prisma.match.findUnique({
    where: { id: matchId },
    select: { status: true, userAId: true, userBId: true },
  });
  if (!match || match.status !== "completed") return { ok: false };

  const from = ctx.from?.id;
  if (from == null) return { ok: false };
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(from) },
    // `theme` comes from the row rather than the session: the feedback Mini App
    // URL bakes it in, and a session written before the user changed it would
    // open the form in the wrong theme.
    select: { id: true, theme: true },
  });
  if (!user) return { ok: false };

  if (user.id === match.userAId)
    return { ok: true, isA: true, userId: user.id, theme: user.theme };
  if (user.id === match.userBId)
    return { ok: true, isA: false, userId: user.id, theme: user.theme };
  return { ok: false };
}

/**
 * Записать факт явки.
 *
 * Идемпотентно по колонке: повторный ответ просто перезаписывает свой же.
 * Ответ второй стороны НЕ трогается — расхождение это `disputed`, реальное
 * состояние, а не ошибка, которую надо схлопнуть (см. `resolvePairAttendance`).
 */
async function writeAttendance(
  matchId: string,
  isA: boolean,
  attended: boolean,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: isA ? { dateAttendedA: attended } : { dateAttendedB: attended },
  });
}

async function writeOutcome(
  matchId: string,
  isA: boolean,
  outcome: AttendanceOutcome,
): Promise<void> {
  await prisma.match.update({
    where: { id: matchId },
    data: isA ? { attendanceOutcomeA: outcome } : { attendanceOutcomeB: outcome },
  });
}

/**
 * Общий хвост ответа «да»: факт записан, дальше обычное приглашение в форму.
 *
 * Клейм при этом снимается — вопрос про явку закрыт, а следующий свободный
 * текст принадлежит уже обратной связи, у которой свой собственный клейм на
 * кнопке «записать голосом».
 */
async function handoverToFeedback(
  ctx: BotContext,
  matchId: string,
  theme: Theme,
): Promise<void> {
  releaseMatchFlowClaim(ctx.session);
  const lang = ctx.session.language;
  await ctx.reply(t(lang, "feedbackInvitation"), {
    reply_markup: buildFeedbackKeyboard(matchId, lang, theme),
  });
}

/** Ветка «нет»: спрашиваем, что произошло. */
async function askOutcome(ctx: BotContext, matchId: string): Promise<void> {
  const lang = ctx.session.language;
  await ctx.reply(t(lang, "attendanceNoIntro"), {
    reply_markup: buildAttendanceOutcomeKeyboard(matchId, lang),
  });
}

/** `attend:yes:<matchId>` / `attend:no:<matchId>` */
export async function handleAttendanceAnswer(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("attend:yes:") && !data?.startsWith("attend:no:")) return;

  const attended = data.startsWith("attend:yes:");
  const matchId = data.slice(attended ? "attend:yes:".length : "attend:no:".length);
  if (!matchId) return;

  await ctx.answerCallbackQuery();

  const side = await resolveSide(ctx, matchId);
  if (!side.ok) return;

  await writeAttendance(matchId, side.isA, attended);

  // Кнопки снимаются с самого вопроса: отвеченный вопрос не должен выглядеть
  // так, будто он всё ещё ждёт (то же правило, что у Profiler'а в §Phase 1b).
  await ctx.editMessageReplyMarkup().catch(() => undefined);

  if (attended) {
    await handoverToFeedback(ctx, matchId, side.theme);
    return;
  }

  // На «нет» клейм продлевается: следующий шаг — тоже ответ на наш вопрос.
  claimMatchFlow(ctx.session, "awaiting_attendance", matchId);
  await askOutcome(ctx, matchId);
}

/** `attend:out:<outcome>:<matchId>` */
export async function handleAttendanceOutcome(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data;
  if (!data?.startsWith("attend:out:")) return;

  const rest = data.slice("attend:out:".length);
  const sep = rest.indexOf(":");
  if (sep <= 0) return;
  const outcome = rest.slice(0, sep);
  const matchId = rest.slice(sep + 1);
  if (!matchId || !isAttendanceOutcome(outcome)) return;

  await ctx.answerCallbackQuery();

  const side = await resolveSide(ctx, matchId);
  if (!side.ok) return;

  await writeOutcome(matchId, side.isA, outcome);
  await ctx.editMessageReplyMarkup().catch(() => undefined);

  releaseMatchFlowClaim(ctx.session);
  // Ничего не обещаем: возврата билета и приоритетного буста на этом пути
  // сегодня нет, и поверхность не имеет права их выдумывать.
  await ctx.reply(t(ctx.session.language, "attendanceNoThanks"));
}

/**
 * Свободный текст, пока вопрос открыт.
 *
 * Вопрос задан обычной прозой, а проза провоцирует напечатать ответ. Без этой
 * ветки «да, всё супер» ушло бы консьержу, и единственный факт, ради которого
 * вопрос существует, потерялся бы — при том что человек на него ответил.
 *
 * Разбор детерминированный: неузнанный ответ деградирует до `unclear` и уходит
 * агенту, который переспросит, тогда как ложное срабатывание записало бы в
 * метрику неверный факт.
 */
export async function handleAttendanceText(ctx: BotContext): Promise<boolean> {
  const text = ctx.message?.text;
  if (!text) return false;
  if (!matchFlowClaimIsLive(ctx.session, "awaiting_attendance")) return false;

  const matchId = ctx.session.activeMatchId;
  if (!matchId) return false;

  const verdict = classifyAttendanceReply(text);
  if (verdict === "unclear") return false;

  const side = await resolveSide(ctx, matchId);
  if (!side.ok) return false;

  await writeAttendance(matchId, side.isA, verdict === "yes");

  if (verdict === "yes") {
    await handoverToFeedback(ctx, matchId, side.theme);
    return true;
  }

  claimMatchFlow(ctx.session, "awaiting_attendance", matchId);
  await askOutcome(ctx, matchId);
  return true;
}
