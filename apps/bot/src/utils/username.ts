import { prisma } from "@gennety/db";

/**
 * Opportunistically persist a user's public Telegram username
 * (`ctx.from.username`, without the leading `@`) onto `User.telegramUsername`.
 *
 * Telegram never gives bots a phone number, so a `t.me/<username>` deep link is
 * the only reliable contact handle for the pre-date coordination contact-
 * exchange variants (`services/coordination.ts`). We capture it lazily on the
 * paths a matched user is guaranteed to hit before a date — `/start` and the
 * match-accept handler — rather than writing on every update.
 *
 * Idempotent: only issues a DB write when the value actually changed (handles
 * a freshly-set, changed, or removed username). Best-effort — a failure here
 * must never break the calling flow, so callers fire-and-forget.
 */
export async function syncTelegramUsername(
  telegramId: bigint,
  username: string | undefined,
): Promise<void> {
  // Mobile-only synthetic users carry a negative id and have no Telegram
  // username — nothing to sync.
  if (telegramId <= 0n) return;

  const normalized = username && username.length > 0 ? username : null;

  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { telegramUsername: true },
  });
  // No row yet (e.g. pre-create call) or unchanged → skip the write.
  if (!user || user.telegramUsername === normalized) return;

  await prisma.user.update({
    where: { telegramId },
    data: { telegramUsername: normalized },
  });
}
