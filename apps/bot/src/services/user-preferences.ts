import { prisma, type Theme } from "@gennety/db";
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
      where: { telegramId },
      data: { theme, themeChosenAt: new Date() },
      select: { id: true },
    });
    await clearOwnDateCardCache(tx, user.id);
    return user;
  });
}
