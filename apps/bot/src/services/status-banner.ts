import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { formatStatusText, nextMatchDispatchAt } from "@gennety/shared";
import type { Language } from "@gennety/shared";

/**
 * Post the pinned status banner for a freshly-activated user.
 *
 * Idempotent: if the user already has a `statusMessageId`, we don't
 * re-pin — the status-timer cron will continue maintaining it.
 *
 * Failure modes: if the user blocked the bot, denied pin permission,
 * or the chat can't be pinned, we swallow the error and leave
 * `statusMessageId` null. Onboarding must not fail because of banner
 * issues.
 */
export async function pinStatusBanner(
  api: Api<RawApi>,
  telegramId: bigint,
  language: Language,
  now: Date = new Date(),
): Promise<void> {
  const existing = await prisma.user.findUnique({
    where: { telegramId },
    select: { statusMessageId: true },
  });
  if (existing?.statusMessageId) return;

  // M-17: mobile-first synthetic users have negative ids — they don't get
  // a pinned banner, the mobile app renders the equivalent in-app.
  if (telegramId <= 0n) return;

  const text = formatStatusText(
    { now, nextMatchAt: nextMatchDispatchAt(now) },
    language,
  );

  const chatId = Number(telegramId);
  try {
    const msg = await api.sendMessage(chatId, text);
    await api.pinChatMessage(chatId, msg.message_id, {
      disable_notification: true,
    });
    await prisma.user.update({
      where: { telegramId },
      data: { statusMessageId: msg.message_id },
    });
  } catch (err) {
    console.warn(
      `[status-banner] pin failed for ${telegramId}:`,
      (err as Error).message,
    );
  }
}
