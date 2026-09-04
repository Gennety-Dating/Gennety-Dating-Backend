import { prisma, type Theme, type ThemeMode } from "@gennety/db";
import type { Language } from "@gennety/shared";

/**
 * Language and theme are read by the Settings menu flow AND the menu agent's
 * `set_language` / `set_theme` tools, so the write lives here once rather than
 * twice. Both share one invariant that is easy to drop by accident: a
 * scheduled date's PNG card bakes the recipient's language/theme into the
 * render, and its `file_id` is cached (`Match.dateCardFileIdA/B`) so re-opening
 * My Date doesn't re-render every time. A switch has to clear ONLY this user's
 * side of that cache, or the old-language/old-theme card keeps getting resent
 * from the cache after the setting changed (PRODUCT_SPEC §2.1).
 */

async function clearOwnDateCardCache(
  tx: Pick<typeof prisma, "match">,
  userId: string,
): Promise<void> {
  await tx.match.updateMany({
    where: { userAId: userId, status: "scheduled" },
    data: { dateCardFileIdA: null },
  });
  await tx.match.updateMany({
    where: { userBId: userId, status: "scheduled" },
    data: { dateCardFileIdB: null },
  });
}

export async function setUserLanguage(
  telegramId: bigint,
  language: Language,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { telegramId },
      data: { language },
      select: { id: true },
    });
    await clearOwnDateCardCache(tx, user.id);
    return user;
  });
}

export async function setUserTheme(
  telegramId: bigint,
  theme: Theme,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      // The bot toggle has two states, so the mode it records is the theme
      // itself: a Telegram user never asks to "follow the phone".
      where: { telegramId },
      data: { theme, themeMode: theme, themeChosenAt: new Date() },
      select: { id: true },
    });
    await clearOwnDateCardCache(tx, user.id);
    return user;
  });
}

/**
 * Same write from the native client, which addresses the user by its own id
 * (there is no Telegram id on a phone-registered account) and carries the
 * extra `mode`.
 *
 * `mode` and `theme` are two different facts and both are stored: `mode` is
 * what the person picked and what the iOS radio has to show back to them,
 * `theme` is what a PNG card paints. They coincide for an explicit pick and
 * diverge for `system`, where the client resolves the phone's appearance and
 * re-reports it whenever it flips — that re-report is the only reason a
 * Telegram card stays in step with an app set to follow the device.
 *
 * `themeChosenAt` is stamped here too: picking "follow the phone" IS a choice,
 * and leaving the marker unset would make the Mini App onboarding show its
 * theme picker to someone who has already answered the question on iOS.
 */
export async function setUserThemeById(
  userId: string,
  theme: Theme,
  mode: ThemeMode,
): Promise<{ id: string }> {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { theme, themeMode: mode, themeChosenAt: new Date() },
      select: { id: true },
    });
    await clearOwnDateCardCache(tx, user.id);
    return user;
  });
}
