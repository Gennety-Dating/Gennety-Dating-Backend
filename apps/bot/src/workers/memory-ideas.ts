import { prisma } from "@gennety/db";
import { dropScreenshotSources } from "../services/memory-ideas.js";

/**
 * Catches what the direct paths did not: a screenshot hidden by a path that
 * knows nothing about ideas (a re-import under a new hash, a refused upload)
 * still takes its source with it. Also runs with the feature off, because
 * deletion never waits on a flag.
 */
export async function sweepOrphanSources(limit = 200): Promise<number> {
  const orphans = await prisma.$queryRaw<Array<{ user_id: string; screenshot_item_id: string }>>`
    SELECT s.user_id, s.screenshot_item_id
    FROM memory_idea_sources s
    LEFT JOIN screenshot_items i ON i.id = s.screenshot_item_id AND i.user_id = s.user_id
    WHERE s.screenshot_item_id IS NOT NULL AND (i.id IS NULL OR i.deleted_at IS NOT NULL)
    LIMIT ${limit}
  `;
  for (const orphan of orphans) {
    await prisma.$transaction((tx) => dropScreenshotSources(tx, orphan.user_id, [orphan.screenshot_item_id]));
  }
  return orphans.length;
}

export async function memoryIdeasTick(): Promise<void> {
  await sweepOrphanSources();
}
