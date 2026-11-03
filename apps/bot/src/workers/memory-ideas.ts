import { prisma } from "@gennety/db";
import { MEMORY_REMINDER_MIN_GAP_MS, usableForOwnDates, type Language, type MemoryIntent, type MemoryReason } from "@gennety/shared";
import { memoryIdeasUsers } from "../services/feature-preview.js";
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

/**
 * The push says that something saved is coming up and nothing more: a lock screen
 * is not private, and an idea's title can be a wish the person keeps to
 * themselves (decision 2026-11-03). The title is shown in the app, from `ideaId`.
 */
export const REMINDER_COPY: Record<Language, { title: string; body: string }> = {
  en: { title: "Idea reminder", body: "Something you saved is coming up soon. Open to see it." },
  ru: { title: "Напоминание об идее", body: "Скоро то, что ты сохранял(а). Открой, чтобы посмотреть." },
  uk: { title: "Нагадування про ідею", body: "Незабаром те, що ти зберіг(ла). Відкрий, щоб подивитися." },
  de: { title: "Erinnerung an eine Idee", body: "Bald ist etwas, das du gespeichert hast. Öffne die App, um es zu sehen." },
  pl: { title: "Przypomnienie o pomyśle", body: "Wkrótce coś, co zapisałeś(-aś). Otwórz, żeby zobaczyć." },
};

export interface ReminderDeps {
  send?: typeof sendPushToUser;
  quiet?: (now: Date) => boolean;
  /** Only these people (a preview list); null or absent: everyone. */
  users?: readonly string[] | null;
}

/**
 * Sends what is due, each claimed once before the send: a crash loses one
 * reminder rather than repeating it. The idea is re-read at send time, so a
 * dropped wish, a moved date, a revoked use or a block ends it without a push.
 */
export async function sendDueReminders(now: Date = new Date(), deps: ReminderDeps = {}): Promise<number> {
  if ((deps.quiet ?? isQuietHours)(now)) return 0;
  if (deps.users && deps.users.length === 0) return 0;
  const due = await prisma.memoryReminder.findMany({
    where: { state: "pending", dueAt: { lte: now }, ...(deps.users ? { userId: { in: [...deps.users] } } : {}) },
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
    // The push budget for ideas: one a day per person, whatever the occasions
    // (`MEMORY_REMINDER_MIN_GAP_MS`). It stays pending and goes on a later tick.
    const recent = await prisma.memoryReminder.count({ where: { userId: reminder.userId, state: "sent", sentAt: { gt: new Date(now.getTime() - MEMORY_REMINDER_MIN_GAP_MS) } } });
    if (recent > 0) continue;
    const claimed = await prisma.memoryReminder.updateMany({ where: { id: reminder.id, state: "pending" }, data: { state: "sent", sentAt: now } });
    if (claimed.count === 0) continue;
    const account = await prisma.user.findUnique({ where: { id: reminder.userId }, select: { language: true } });
    const copy = REMINDER_COPY[(account?.language ?? "en") as Language] ?? REMINDER_COPY.en;
    await (deps.send ?? sendPushToUser)(reminder.userId, {
      title: copy.title,
      body: copy.body,
      collapseId: `memory-${idea.id}`,
      data: { type: "memory.reminder", ideaId: idea.id },
    });
    sent++;
  }
  return sent;
}

export async function memoryIdeasTick(): Promise<void> {
  await sweepOrphanSources();
  // Everyone with the flag on, else only the preview list (`services/feature-preview.ts`).
  const users = memoryIdeasUsers();
  if (users !== null && users.length === 0) return;
  await reconcilePlans(new Date(), 200, users);
  await sendDueReminders(new Date(), { users });
}
