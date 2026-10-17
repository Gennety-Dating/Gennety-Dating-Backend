import { prisma } from "@gennety/db";

/**
 * Согласие на продуктовую аналитику (Pulse, docs/product/domains/pulse-analytics.md §2).
 *
 * Отдельно от `researchOptIn` намеренно: тот разрешает исследовательское
 * использование данных, которые продукт и так держит, а это — СБОР нового
 * класса данных (экраны, время на них, касания). Согласие на новый сбор не
 * выводится из более широкой галочки — то же правило, что у
 * `biometricConsentAt`.
 */

/** Да / нет / человека нет (удалён между выдачей токена и запросом). */
export async function analyticsConsentOf(userId: string): Promise<boolean | null> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { analyticsOptIn: true },
  });
  return user ? user.analyticsOptIn : null;
}

/** Mini App опознаёт человека по Telegram id из подписанного initData. */
export async function userIdByTelegramId(telegramId: number): Promise<string | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(telegramId) },
    select: { id: true },
  });
  return user?.id ?? null;
}

/**
 * Поля для `prisma.user.update`, когда клиент прислал решение. `undefined` —
 * решения в теле нет, и значение не трогается: старый клиент без галочки не
 * должен молча отзывать согласие, данное в новом.
 */
export function analyticsConsentPatch(
  optIn: boolean | undefined,
): { analyticsOptIn: boolean; analyticsOptInAt: Date } | Record<string, never> {
  return optIn === undefined ? {} : { analyticsOptIn: optIn, analyticsOptInAt: new Date() };
}

/**
 * Дать или отозвать согласие из настроек.
 *
 * Отзыв стирает всё, что собрано по этому человеку: GDPR не требует удалять
 * обработанное законно до отзыва, но держать поведенческие следы того, кто
 * сказал «не надо», нам незачем, а удаление здесь дешёвое. Анонимные события
 * до входа (`user_id IS NULL`) с человеком не связаны и уходят по ретеншену.
 */
export async function setAnalyticsConsent(userId: string, optIn: boolean): Promise<boolean> {
  if (optIn) {
    await prisma.user.update({ where: { id: userId }, data: analyticsConsentPatch(true) });
    return true;
  }
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: analyticsConsentPatch(false) }),
    prisma.clientEvent.deleteMany({ where: { userId } }),
  ]);
  return false;
}
