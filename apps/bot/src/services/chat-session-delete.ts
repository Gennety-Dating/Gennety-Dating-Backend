import { prisma } from "@gennety/db";
import { env } from "../config.js";
import { isUuid } from "../utils/uuid.js";
import { collectOwnedPaths } from "../utils/owned-paths.js";
import { withChatLock } from "./chat-turn-lock.js";
import { deleteStorageObject } from "./storage.js";

/**
 * Deleting a chat with the agent for good (founder decision 2026-11-22).
 *
 * Gone with the `chat_sessions` row: its messages (cascade), its title, its
 * summary and the summary's embedding — everything the agent's past-chat search
 * could still find it by — and the photos sent in it. `forget` also removes the
 * memory notes last written from this chat; without it they stay and only lose
 * the link. Kept on purpose: reminders the person set, wishlist items.
 *
 * Photos go FIRST and fail closed: a row erased before its photos would leave
 * objects nothing points at and nobody would retry. A photo another chat also
 * shows stays.
 *
 * Under the person's chat lock (`withChatLock`), so a reply in flight lands
 * before the deletion and goes with it. A turn queued behind it hits the foreign
 * key and fails; it cannot bring the chat back.
 */
export type DeleteChatOutcome = "deleted" | "unknown" | "storage";

export async function deleteChatSession(
  userId: string,
  sessionId: string,
  opts: { forget: boolean },
): Promise<DeleteChatOutcome> {
  if (!isUuid(sessionId)) return "unknown";
  return withChatLock(userId, async () => {
    const owned = await prisma.chatSession.findFirst({ where: { id: sessionId, userId }, select: { id: true } });
    if (!owned) return "unknown";
    return erase(userId, [sessionId], opts.forget);
  });
}

/** «Удалить все» in the archive: one pass over what is archived right now. */
export async function deleteArchivedChats(
  userId: string,
  opts: { forget: boolean },
): Promise<{ outcome: Exclude<DeleteChatOutcome, "unknown">; deleted: number }> {
  return withChatLock(userId, async () => {
    const rows = await prisma.chatSession.findMany({
      where: { userId, archivedAt: { not: null } },
      select: { id: true },
    });
    if (rows.length === 0) return { outcome: "deleted", deleted: 0 };
    const outcome = await erase(userId, rows.map((row) => row.id), opts.forget);
    return { outcome, deleted: outcome === "deleted" ? rows.length : 0 };
  });
}

async function erase(
  userId: string,
  sessionIds: string[],
  forget: boolean,
): Promise<"deleted" | "storage"> {
  const withPhotos = await prisma.message.findMany({
    where: {
      userId,
      sessionId: { in: sessionIds },
      OR: [{ imageUrl: { not: null } }, { imageUrls: { isEmpty: false } }],
    },
    select: { imageUrl: true, imageUrls: true },
  });
  for (const path of collectOwnedPaths(withPhotos, userId)) {
    const elsewhere = await prisma.message.count({
      where: {
        userId,
        OR: [{ imageUrl: path }, { imageUrls: { has: path } }],
        NOT: { sessionId: { in: sessionIds } },
      },
    });
    // A row with no chat at all is not matched by `NOT … in` — ask for it too.
    const unfiled = await prisma.message.count({
      where: { userId, sessionId: null, OR: [{ imageUrl: path }, { imageUrls: { has: path } }] },
    });
    if (elsewhere + unfiled > 0) continue;
    if (!(await deleteStorageObject(env.SUPABASE_CHAT_BUCKET, path))) {
      console.error("[chat] chat deletion stopped: a photo could not be erased", { userId });
      return "storage";
    }
  }

  await prisma.$transaction(async (tx) => {
    if (forget) await tx.agentMemory.deleteMany({ where: { userId, sourceSessionId: { in: sessionIds } } });
    await tx.agentReminder.updateMany({ where: { userId, sessionId: { in: sessionIds } }, data: { sessionId: null } });
    await tx.chatSession.deleteMany({ where: { userId, id: { in: sessionIds } } });
  });
  return "deleted";
}
