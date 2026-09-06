import { prisma } from "@gennety/db";
import type { ShortVideoCacheEntry } from "./analyze.js";
import type { ShortVideoRef } from "./links.js";

/**
 * Prisma-backed store for `ShortVideoAnalysis`, kept behind the narrow
 * `cacheGet` / `cacheSet` pair `analyze.ts` declares so the orchestrator stays
 * testable without a database.
 *
 * Both halves are best-effort by design. A cache is an optimisation: a read
 * that fails should cost one extra analysis, and a write that fails should cost
 * one extra analysis next time — neither should be able to take down the answer
 * the user is waiting on.
 */

/** A ref with no id cannot be cached — it has not been resolved yet. */
function keyOf(ref: ShortVideoRef): { platform: "tiktok" | "instagram"; externalId: string } | null {
  return ref.externalId
    ? { platform: ref.platform, externalId: ref.externalId }
    : null;
}

export async function readShortVideoCache(
  ref: ShortVideoRef,
): Promise<ShortVideoCacheEntry | null> {
  const key = keyOf(ref);
  if (!key) return null;
  try {
    const row = await prisma.shortVideoAnalysis.findUnique({
      where: { platform_externalId: key },
      select: { description: true, posterFileId: true },
    });
    return row ? { description: row.description, posterFileId: row.posterFileId } : null;
  } catch (err) {
    console.warn("[short-video] cache read failed", { ...key, err });
    return null;
  }
}

export async function writeShortVideoCache(
  ref: ShortVideoRef,
  entry: ShortVideoCacheEntry & { authorName: string | null; model: string },
): Promise<void> {
  const key = keyOf(ref);
  if (!key) return;
  try {
    await prisma.shortVideoAnalysis.upsert({
      where: { platform_externalId: key },
      // A re-analysis means the previous row was missing or being refreshed,
      // so the new description wins. `posterFileId` is the one field worth
      // keeping when the fresh mint failed: an old, working pointer beats null.
      update: {
        description: entry.description,
        authorName: entry.authorName,
        model: entry.model,
        canonicalUrl: ref.url,
        ...(entry.posterFileId ? { posterFileId: entry.posterFileId } : {}),
      },
      create: {
        ...key,
        canonicalUrl: ref.url,
        description: entry.description,
        authorName: entry.authorName,
        posterFileId: entry.posterFileId,
        model: entry.model,
      },
    });
  } catch (err) {
    console.warn("[short-video] cache write failed", { ...key, err });
  }
}
