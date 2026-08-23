import type { Api, RawApi } from "grammy";
import type { ReactionType } from "grammy/types";
import type { OnboardingField } from "./onboarding-collector.js";

export type EmojiReaction = Extract<ReactionType, { type: "emoji" }>["emoji"];

export const MESSAGE_REACTION = {
  like: "👍",
  fire: "🔥",
  heart: "❤",
  // Marks a profile photo that failed validation, so the offending frame in an
  // album is identifiable at a glance — before the user even reads the reply.
  think: "🤔",
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

/**
 * Which reaction the bot gives a user's onboarding answer, keyed by the fields
 * the collector accepted from it. One rule for both rails: Telegram sets the
 * emoji on the message (`reactToMessage`), the native client gets the same
 * verdict in `InterviewState.reaction` and draws its own tapback.
 *
 * `vibe_focus` wins over `hobbies` when a single answer closes both — the
 * closing vibe question is the most personal answer of the interview, and the
 * warmer reaction belongs to it.
 */
export type OnboardingReaction = "like" | "heart";

export function onboardingReactionFor(
  acceptedFields: readonly OnboardingField[] | undefined,
): OnboardingReaction | null {
  if (!acceptedFields) return null;
  if (acceptedFields.includes("vibe_focus")) return "heart";
  if (acceptedFields.includes("hobbies")) return "like";
  return null;
}
