import { prisma } from "@gennety/db";
import { MEMORY_REMINDER_MIN_GAP_MS, usableForOwnDates, type Language, type MemoryIntent, type MemoryReason } from "@gennety/shared";
import { env } from "../config.js";
import { dropScreenshotSources } from "../services/memory-ideas.js";
import { reconcilePlans } from "../services/memory-planning.js";
import { sendPushToUser } from "../services/push.js";
import { isQuietHours } from "./quiet-hours.js";

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

const REMINDER_COPY: Record<Language, { title: string; body: (title: string) => string }> = {
  en: { title: "Remember this idea?", body: (t) => `«${t}» is coming up. Check it's still on.` },
  ru: { title: "Помнишь эту идею?", body: (t) => `Скоро «${t}». Проверь, всё ли в силе.` },
  uk: { title: "Пам'ятаєш цю ідею?", body: (t) => `Незабаром «${t}». Перевір, чи все в силі.` },
  de: { title: "Denkst du noch an diese Idee?", body: (t) => `Bald ist «${t}». Prüf kurz, ob es noch stattfindet.` },
  pl: { title: "Pamiętasz ten pomysł?", body: (t) => `Niedługo «${t}». Sprawdź, czy wszystko aktualne.` },
};

export interface ReminderDeps {
  send?: typeof sendPushToUser;
  quiet?: (now: Date) => boolean;
}

/**
 * Sends what is due, each claimed once before the send: a crash loses one
 * reminder rather than repeating it. The idea is re-read at send time, so a
 * dropped wish, a moved date, a revoked use or a block ends it without a push.
 */
export async function sendDueReminders(now: Date = new Date(), deps: ReminderDeps = {}): Promise<number> {
  if ((deps.quiet ?? isQuietHours)(now)) return 0;
  const due = await prisma.memoryReminder.findMany({
    where: { state: "pending", dueAt: { lte: now } },
    include: { idea: true },
    orderBy: { dueAt: "asc" },
    take: 100,
  });
  let sent = 0;
  for (const reminder of due) {
    const idea = reminder.idea;
    const planMatch = idea.plannedMatchId
      ? await prisma.match.findUnique({ where: { id: idea.plannedMatchId }, select: { userAId: true, userBId: true } })
      : null;
    const blocked = planMatch
      ? (await prisma.userBlock.count({ where: { OR: [{ blockerId: planMatch.userAId, blockedId: planMatch.userBId }, { blockerId: planMatch.userBId, blockedId: planMatch.userAId }] } })) > 0
      : false;
    const usable = usableForOwnDates({ ...idea, intent: idea.intent as MemoryIntent, reason: idea.reason as MemoryReason | null });
    if (!usable || blocked || !idea.eventAt || idea.eventAt <= now || idea.eventCheck === "outdated") {
      await prisma.memoryReminder.updateMany({ where: { id: reminder.id, state: "pending" }, data: { state: "cancelled" } });
      continue;
    }
    // One a day per person. It stays pending and goes on a later tick.
    const recent = await prisma.memoryReminder.count({ where: { userId: reminder.userId, state: "sent", sentAt: { gt: new Date(now.getTime() - MEMORY_REMINDER_MIN_GAP_MS) } } });
    if (recent > 0) continue;
    const claimed = await prisma.memoryReminder.updateMany({ where: { id: reminder.id, state: "pending" }, data: { state: "sent", sentAt: now } });
    if (claimed.count === 0) continue;
    const account = await prisma.user.findUnique({ where: { id: reminder.userId }, select: { language: true } });
    const copy = REMINDER_COPY[(account?.language ?? "en") as Language] ?? REMINDER_COPY.en;
    await (deps.send ?? sendPushToUser)(reminder.userId, {
      title: copy.title,
      // A name on a lock screen is the person's own idea and names nobody else.
      body: copy.body(idea.title),
      collapseId: `memory-${idea.id}`,
      data: { type: "memory.reminder", ideaId: idea.id },
    });
    sent++;
  }
  return sent;
}

export async function memoryIdeasTick(): Promise<void> {
  await sweepOrphanSources();
  if (!env.MEMORY_IDEAS_ENABLED) return;
  await reconcilePlans();
  await sendDueReminders();
}
