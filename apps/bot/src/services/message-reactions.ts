import type { Api, RawApi } from "grammy";
import type { ReactionType } from "grammy/types";

export type EmojiReaction = Extract<ReactionType, { type: "emoji" }>["emoji"];

export const MESSAGE_REACTION = {
  like: "👍",
  fire: "🔥",
} as const satisfies Record<string, EmojiReaction>;

export interface MessageReactionTarget {
  chatId: number | string | undefined;
  messageId: number | undefined;
}

/**
 * Best-effort Telegram reaction. Reactions are cosmetic, so they must never
 * block onboarding, photo validation, or Profiler progression.
 */
export async function reactToMessage(
  api: Api<RawApi>,
  target: MessageReactionTarget,
  emoji: EmojiReaction,
): Promise<void> {
  if (target.chatId === undefined || target.messageId === undefined) return;

  try {
    await api.setMessageReaction(
      target.chatId,
      target.messageId,
      [{ type: "emoji", emoji }],
      { is_big: false },
    );
  } catch (err) {
    console.warn(
      "[message-reactions] setMessageReaction failed:",
      err instanceof Error ? err.message : err,
    );
  }
}
