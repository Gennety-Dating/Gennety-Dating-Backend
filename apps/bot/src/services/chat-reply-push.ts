import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { sendPushToUser } from "./push.js";

/**
 * «Gennety ответил» — the push for a chat reply nobody was there to receive
 * (app audit 2026-11-15, item 11).
 *
 * `POST /v1/chat/message` and `/v1/chat/voice` block until the reply. A turn
 * can outlive the phone's connection — the screen locks, the app goes to the
 * background, the request times out — and the server still finishes it and
 * stores the reply. Before this the person came back to «Не отправлено» for a
 * message that had in fact been answered. Now, when every request waiting on
 * that turn has gone, the reply is pushed with the chat to open.
 *
 * Transactional, so no quiet hours (`push.ts`: the person is waiting on this
 * very answer). No inbox row: `chat.reply` is not an inbox type, the reply
 * already lives in the chat's history.
 */

export const CHAT_REPLY_PUSH_TYPE = "chat.reply";

/** The lock screen shows a line, not the whole reply. */
const PUSH_BODY_MAX = 140;

/**
 * Requests waiting on one turn, keyed by person + `clientMessageId`. A retry
 * with the same id joins the first request's turn (`SendDedupe`), so "the
 * client is gone" means EVERY waiter is gone: one live request shows the reply
 * itself, and a push on top of it would announce what is already on screen.
 * The last waiter to settle decides, so a turn is pushed at most once.
 */
export class ChatReplyWaiters {
  private readonly entries = new Map<string, { waiters: Set<() => boolean>; delivered: boolean }>();

  /**
   * Register a request; `gone` says whether its client has disconnected. The
   * returned `settle` is called once the turn has an answer and tells whether
   * this request should push it: true only for the last waiter, and only when
   * none of the waiters was still there to receive it.
   */
  join(key: string, gone: () => boolean): () => boolean {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { waiters: new Set(), delivered: false };
      this.entries.set(key, entry);
    }
    const self = entry;
    self.waiters.add(gone);
    let settled = false;
    return () => {
      if (settled) return false;
      settled = true;
      if (!gone()) self.delivered = true;
      self.waiters.delete(gone);
      if (self.waiters.size > 0) return false;
      if (this.entries.get(key) === self) this.entries.delete(key);
      return !self.delivered;
    };
  }

  /** Tests only. */
  clear(): void {
    this.entries.clear();
  }
}

export const chatReplyWaiters = new ChatReplyWaiters();

/** The first bubble of the reply, cut to a lock-screen line. */
export function chatReplyPushBody(content: string): string {
  const first = content.split(/\n\s*\n/)[0]?.trim() ?? "";
  const line = first.replace(/\s+/g, " ");
  return line.length <= PUSH_BODY_MAX ? line : `${line.slice(0, PUSH_BODY_MAX - 1).trimEnd()}…`;
}

/** Push the stored reply to the person's phone. Never throws. */
export async function sendChatReplyPush(input: {
  userId: string;
  sessionId: string;
  content: string;
  send?: typeof sendPushToUser;
}): Promise<boolean> {
  try {
    const body = chatReplyPushBody(input.content);
    if (!body) return false;
    const user = await prisma.user.findUnique({ where: { id: input.userId }, select: { language: true } });
    const language = (user?.language ?? "en") as Language;
    return await (input.send ?? sendPushToUser)(input.userId, {
      title: t(language, "chatReplyPushTitle"),
      body,
      data: { type: CHAT_REPLY_PUSH_TYPE, sessionId: input.sessionId },
      // One notification per chat: a second late reply replaces the first.
      collapseId: `chat.reply.${input.sessionId}`,
    });
  } catch (err) {
    console.warn("[chat] reply push failed:", err instanceof Error ? err.message : err);
    return false;
  }
}
