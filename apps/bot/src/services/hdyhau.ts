import { prisma } from "@gennety/db";
import {
  HDYHAU_ANSWERS,
  HDYHAU_PROMPT_VERSION,
  hdyhauAnswerLabelKey,
  isHdyhauAnswer,
  isHdyhauSurface,
  t,
  type HdyhauAnswer,
  type HdyhauSurface,
  type Language,
} from "@gennety/shared";

/**
 * Приём ответа на онбординговый вопрос «откуда вы про нас узнали».
 *
 * Перечень вариантов и то, какие из них считаются устной рекомендацией, живут в
 * `@gennety/shared` (`hdyhau.ts`) — их читают и клиенты, и аналитический
 * движок, поэтому единственная копия обязана быть общей.
 *
 * Здесь — только запись и выдача вопроса. Вся математика калибровки `K_wom`
 * лежит в `admin/utils/virality.ts` и не знает про HTTP, как и остальная
 * аналитика в этом репозитории.
 */

export type SaveHdyhauResult =
  | { status: "saved"; answer: HdyhauAnswer; created: boolean }
  | { status: "invalid"; reason: "answer" | "surface" }
  | { status: "unknown-user" };

/**
 * Сохранить ответ. Идемпотентно по пользователю: повторная отправка ОБНОВЛЯЕТ
 * строку, а не создаёт вторую, потому что вопрос задаётся один раз и второго
 * ответа у человека нет — есть исправленный первый.
 *
 * `promptVersion` пишется из общей константы, а не приходит от клиента:
 * версию формулировки знает тот, кто её формулировал, а старое приложение
 * прислало бы версию, которую сервер уже не показывает.
 */
export async function saveHdyhauResponse(params: {
  userId: string;
  answer: unknown;
  surface: unknown;
}): Promise<SaveHdyhauResult> {
  const answer = typeof params.answer === "string" ? params.answer.trim() : "";
  if (!isHdyhauAnswer(answer)) return { status: "invalid", reason: "answer" };

  const surface = typeof params.surface === "string" ? params.surface.trim() : "";
  if (!isHdyhauSurface(surface)) return { status: "invalid", reason: "surface" };

  const existing = await prisma.hdyhauResponse.findUnique({
    where: { userId: params.userId },
    select: { userId: true },
  });

  try {
    await prisma.hdyhauResponse.upsert({
      where: { userId: params.userId },
      create: {
        userId: params.userId,
        answer,
        surface,
        promptVersion: HDYHAU_PROMPT_VERSION,
      },
      update: { answer, surface, promptVersion: HDYHAU_PROMPT_VERSION },
    });
  } catch {
    // Единственная ожидаемая причина — пользователь исчез между проверкой
    // авторизации и записью (удаление аккаунта по GDPR идёт каскадом).
    return { status: "unknown-user" };
  }

  return { status: "saved", answer, created: existing === null };
}

/** Уже отвеченный вариант, если он есть. */
export async function loadHdyhauResponse(userId: string): Promise<HdyhauAnswer | null> {
  const row = await prisma.hdyhauResponse.findUnique({
    where: { userId },
    select: { answer: true },
  });
  if (!row || !isHdyhauAnswer(row.answer)) return null;
  return row.answer;
}

export interface HdyhauPrompt {
  version: string;
  question: string;
  skipLabel: string;
  options: Array<{ value: HdyhauAnswer; label: string }>;
}

/**
 * Вопрос и подписи вариантов на языке пользователя.
 *
 * Отдаётся сервером, а не зашивается в клиент, по той же причине, по которой
 * `/v1/onboarding/interview` отдаёт текст шага: два клиента (Mini App и iOS)
 * обязаны предлагать ОДИН набор вариантов, иначе распределение ответов
 * складывается из двух разных анкет и не значит ничего.
 */
export function buildHdyhauPrompt(lang: Language): HdyhauPrompt {
  return {
    version: HDYHAU_PROMPT_VERSION,
    question: t(lang, "hdyhauQuestion"),
    skipLabel: t(lang, "hdyhauSkip"),
    options: HDYHAU_ANSWERS.map((value) => ({
      value,
      label: t(lang, hdyhauAnswerLabelKey(value)),
    })),
  };
}

/** Поверхности, с которых вопрос может прийти, — реэкспорт для маршрутов. */
export type { HdyhauSurface };
