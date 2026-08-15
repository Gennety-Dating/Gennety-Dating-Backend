/**
 * Клавиатуры двух шагов после свидания: «вы встретились?» и обратная связь.
 *
 * Живут отдельно от обоих вызывающих намеренно. Вопрос о явке отправляет крон
 * (`date-lifecycle.ts`), а отвечает на него хендлер
 * (`handlers/date/attendance.ts`), и на «да» хендлер отправляет ту же форму,
 * что раньше слал крон. Если оставить сборку клавиатур у любой из сторон,
 * получится цикл импортов.
 */

import { InlineKeyboard } from "grammy";
import { t, type Language } from "@gennety/shared";
import type { Theme } from "@gennety/db";
import { env } from "../config.js";
import { buildMiniAppUrl } from "./mini-app-url.js";
import { ATTENDANCE_OUTCOMES, type AttendanceOutcome } from "./attendance.js";

/**
 * Post-date feedback DM keyboard: two stacked buttons, form first.
 * The form opens the Mini App (signed POST to `/v1/feedback/post-date`); the
 * voice button drops the user into `awaiting_feedback` so the next voice
 * note (or typed text) is captured.
 *
 * Inline `web_app` button labels can't carry custom_emoji entities, so the
 * leading glyph in each label is plain Unicode — same constraint we hit on
 * the main menu keyboard (PRODUCT_SPEC.md §2.1).
 */
export function buildFeedbackKeyboard(
  matchId: string,
  lang: Language,
  theme: Theme,
): InlineKeyboard {
  const url = buildMiniAppUrl("feedback", {
    baseUrl: env.WEBAPP_FEEDBACK_URL,
    lang,
    theme,
    query: { match: matchId },
  });
  return new InlineKeyboard()
    .webApp(t(lang, "feedbackBtnForm"), url)
    .row()
    .text(t(lang, "feedbackBtnVoice"), `feedback:voice:${matchId}`);
}

/**
 * «Вы встретились?» — два ответа.
 *
 * Кнопки, а не только проза, потому что ответ идёт в метрику: тап
 * детерминирован, а разбор напечатанного — нет. Проза при этом остаётся:
 * свободный текст ловится отдельно (`handleAttendanceText`).
 */
export function buildAttendanceKeyboard(matchId: string, lang: Language): InlineKeyboard {
  return new InlineKeyboard()
    .text(t(lang, "attendanceBtnYes"), `attend:yes:${matchId}`)
    .row()
    .text(t(lang, "attendanceBtnNo"), `attend:no:${matchId}`);
}

/** Ветка «не встретились»: почему именно. */
export function buildAttendanceOutcomeKeyboard(
  matchId: string,
  lang: Language,
): InlineKeyboard {
  const labels: Record<AttendanceOutcome, string> = {
    no_show_partner: t(lang, "attendanceOutcomePartner"),
    no_show_self: t(lang, "attendanceOutcomeSelf"),
    both_rescheduled: t(lang, "attendanceOutcomeBoth"),
    other: t(lang, "attendanceOutcomeOther"),
  };
  const kb = new InlineKeyboard();
  for (const outcome of ATTENDANCE_OUTCOMES) {
    kb.text(labels[outcome], `attend:out:${outcome}:${matchId}`).row();
  }
  return kb;
}
