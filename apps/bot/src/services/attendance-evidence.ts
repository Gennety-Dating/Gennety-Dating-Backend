/**
 * Did the date actually happen — собиратель улик.
 *
 * Отвечает ровно на один вопрос: КАК сформулировать вопрос о явке. Не на то,
 * состоялось ли свидание — это решает ответ человека (`attendance.ts`).
 * Разделение намеренное и несущее: ошибка здесь стоит неудачного предложения,
 * а не выдуманной метрики.
 *
 * ── Что вообще может служить уликой ──────────────────────────────────────
 *
 * Полный инвентарь сигналов, которые в продукте реально существуют, с честной
 * оценкой силы:
 *
 * | Сигнал                        | Что даёт                  | Сила        |
 * |-------------------------------|---------------------------|-------------|
 * | Экстренная отмена             | свидание отменено         | определённо |
 * | Ответ партнёра о явке         | человек от первого лица   | определённо |
 * | Что писал агенту после даты   | «было классно» / «не пришла» | сильный |
 * | Прокси-чат перед свиданием    | «я у входа», «опаздываю»  | НАМЁК      |
 * | Тишина                        | ничего                    | ноль       |
 *
 * Две верхние строки до сюда не доходят и не должны: отменённый матч уходит в
 * `cancelled` и до T+24h не доживает, а ответ партнёра — это уже факт, он
 * читается напрямую в `attendance.ts`, без модели.
 *
 * Значит модели достаются только две нижние. И прокси-чат — именно НАМЁК:
 * «искали друг друга» не равно «встретились», человек мог не дождаться и уйти.
 * Поэтому одного прокси-чата никогда не хватает на `likely_met`.
 *
 * ── Приватность: граница, которую здесь нельзя перейти ───────────────────
 *
 * `proxy_messages` содержат текст ВТОРОГО пользователя. Продукт намеренно не
 * пускает его в таймлайн агента (`withRedactedSummary` в
 * `services/outbound-recorder.ts`), потому что рядом с таймлайном лежат
 * инструменты, пишущие в профиль читателя.
 *
 * Классификатор читает эти сообщения на сервере — это допустимо. Но наружу он
 * отдаёт ТОЛЬКО enum из трёх значений, и ни одна строка чужого текста не
 * доезжает ни до промпта агента, ни до сообщения пользователю. Если когда-то
 * захочется процитировать в вопросе «ты писал, что стоишь у входа» — это будет
 * утечка одного пользователя другому, а не улучшение формулировки.
 */

import { prisma } from "@gennety/db";
import { callOpenAIJson } from "./openai.js";
import { MODELS } from "../models.js";
import type { AttendanceTone } from "./attendance.js";

/** Сколько последних реплик пользователя агенту смотрим. */
const MAX_CHAT_EVENTS = 12;
/** Сколько сообщений прокси-чата смотрим. */
const MAX_PROXY_MESSAGES = 20;
/** Обрезка одной реплики, чтобы промпт не раздувался. */
const MAX_SNIPPET_LEN = 200;

export interface AttendanceEvidence {
  /** Что пользователь писал боту после согласованного времени. */
  ownMessages: string[];
  /** Текст прокси-чата пары (обе стороны) — только для классификатора. */
  proxyMessages: string[];
}

/** Пусто ли — то есть можно ли вообще не звать модель. */
export function evidenceIsEmpty(evidence: AttendanceEvidence): boolean {
  return evidence.ownMessages.length === 0 && evidence.proxyMessages.length === 0;
}

function snippet(text: string): string {
  const flat = text.replace(/\s+/gu, " ").trim();
  return flat.length > MAX_SNIPPET_LEN ? `${flat.slice(0, MAX_SNIPPET_LEN)}…` : flat;
}

/**
 * Собрать улики для одной стороны одного матча.
 *
 * Никогда не бросает: любая ошибка чтения деградирует до пустых улик, то есть
 * до обычного вопроса. Улики — это украшение вопроса, и они не имеют права
 * уронить сам вопрос.
 */
export async function gatherAttendanceEvidence(input: {
  matchId: string;
  userId: string;
  agreedTime: Date;
}): Promise<AttendanceEvidence> {
  const empty: AttendanceEvidence = { ownMessages: [], proxyMessages: [] };
  try {
    const [events, proxy] = await Promise.all([
      // Только то, что писал сам пользователь, и только после времени свидания:
      // всё, что до него, — это планирование, а не отчёт о встрече.
      prisma.chatEvent.findMany({
        where: {
          userId: input.userId,
          direction: "in",
          createdAt: { gte: input.agreedTime },
        },
        select: { summary: true },
        orderBy: { createdAt: "desc" },
        take: MAX_CHAT_EVENTS,
      }),
      prisma.proxyMessage.findMany({
        where: { matchId: input.matchId },
        select: { body: true },
        orderBy: { createdAt: "asc" },
        take: MAX_PROXY_MESSAGES,
      }),
    ]);

    return {
      ownMessages: events
        .map((e) => (e.summary ?? "").trim())
        .filter((s) => s.length > 0)
        .map(snippet)
        .reverse(),
      proxyMessages: proxy
        .map((m) => m.body.trim())
        .filter((s) => s.length > 0)
        .map(snippet),
    };
  } catch (err) {
    console.warn(
      `[attendance] evidence read failed for match ${input.matchId}:`,
      err instanceof Error ? err.message : err,
    );
    return empty;
  }
}

const SYSTEM_PROMPT = `You decide ONLY how confident we are that a date physically happened, based on fragments of chat. You never decide whether it happened — a human will be asked directly either way. Your answer picks the wording of that question, nothing else.

Return ONLY a JSON object:
- "verdict": "met" | "not_met" | "unclear"
- "confidence": "high" | "low"

Rules, in order of importance:
1. Default to {"verdict":"unclear","confidence":"low"}. Silence, small talk, logistics and enthusiasm BEFORE the meeting time prove nothing.
2. "met" with "high" needs someone stating the meeting happened — talking about it in the past tense ("it was great", "she was lovely", "we walked for hours"). People arranging to meet, or saying they have arrived, is NOT enough: arriving is not meeting, and one of them may have left.
3. "not_met" with "high" needs someone stating it did not happen — "she never showed", "I waited an hour", "I had to cancel", "nobody came".
4. Anything ambiguous, hedged, or inferred is "unclear". Being wrong in the confident direction is much worse than being unsure: an unsure answer just asks a neutral question, a wrong confident answer tells a person something false about their own evening.
5. Judge only the fragments given. Do not imagine context.`;

interface RawVerdict {
  verdict?: unknown;
  confidence?: unknown;
}

/**
 * Улики → тон вопроса.
 *
 * Строгость выражена структурно, а не просьбой в промпте: всё, что не
 * `high`-уверенный однозначный вердикт, схлопывается в `unknown`. Промпт может
 * ошибиться; конструкция — нет.
 *
 * Модель не вызывается, если улик нет вовсе, — а это подавляющее большинство
 * пар, так что по токенам фича почти бесплатна.
 */
export async function resolveAttendanceTone(
  evidence: AttendanceEvidence,
  deps: { callJson?: typeof callOpenAIJson } = {},
): Promise<AttendanceTone> {
  if (evidenceIsEmpty(evidence)) return "unknown";

  const call = deps.callJson ?? callOpenAIJson;
  const lines: string[] = [];
  if (evidence.ownMessages.length > 0) {
    lines.push("What this person wrote to the bot after the meeting time:");
    lines.push(...evidence.ownMessages.map((m) => `- ${m}`));
  }
  if (evidence.proxyMessages.length > 0) {
    lines.push("Messages the pair relayed to each other around the meeting time:");
    lines.push(...evidence.proxyMessages.map((m) => `- ${m}`));
  }

  const raw = await call<RawVerdict>(SYSTEM_PROMPT, lines.join("\n"), {
    model: MODELS.fast,
    maxTokens: 40,
    temperature: 0,
  });

  if (!raw || raw.confidence !== "high") return "unknown";
  if (raw.verdict === "met") return "likely_met";
  if (raw.verdict === "not_met") return "likely_not_met";
  return "unknown";
}
