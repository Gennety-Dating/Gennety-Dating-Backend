import { prisma } from "@gennety/db";
import {
  AGENT_REACTIONS,
  AGENT_REACTIONS_CLIENT_TOKEN,
  CLOSING_EMOJI,
  agentReactionSensitiveHit,
  isLeavingTurn,
  normalizeReactionEmoji,
  type AgentReactionOccasion,
  type ReactionEmoji,
} from "@gennety/shared";
import { agentReactionsOn } from "./feature-preview.js";
import { readChangeOffer } from "./chat-offer.js";

/**
 * Emoji reactions in the app chat with Gennety (decision 2026-11-24, spec
 * `docs/product/domains/agent-reactions.md`).
 *
 * Two sides, one row each: the person reacts to Gennety's replies
 * (`messages.user_reaction` on `assistant` rows), Gennety reacts to the
 * person's message (`messages.agent_reaction` on `user` rows). One reaction
 * per side per message, from the proxy chat's closed set of five.
 *
 * The person's reaction never starts a turn: the next turn's prompt names it
 * (with a piece of the reply it landed on), and says that a reaction is not a
 * yes. Gennety's reaction is the `react` tool, offered only on a turn the
 * server's guard lets through ({@link agentReactionGate}); step 1 has one
 * occasion — the person closed the topic — and a turn that reacted and wrote
 * nothing has no assistant row at all.
 *
 * Gated twice: the `reactions` token in `X-Gennety-Chat-Cards` (a build that
 * draws them) and `AGENT_REACTIONS_ENABLED` / `AGENT_REACTIONS_USER_IDS`.
 */

export const REACT_TOOL_NAME = "react";

export interface ChatReactions {
  user: string | null;
  agent: string | null;
}

/** This build draws reactions and the feature is on for this person. */
export function chatReactionsDrawn(userId: string | null | undefined, chatCards: ReadonlySet<string> | undefined): boolean {
  return (chatCards?.has(AGENT_REACTIONS_CLIENT_TOKEN) ?? false) && agentReactionsOn(userId);
}

export function reactionsView(row: { userReaction?: string | null; agentReaction?: string | null }): ChatReactions {
  return { user: row.userReaction ?? null, agent: row.agentReaction ?? null };
}

/* ── the person's reaction ──────────────────────────────────────────────── */

export type PersonReactionResult =
  | { ok: true; reactions: ChatReactions }
  | { ok: false; error: "not-found" | "not-assistant" | "bad-reaction" };

/**
 * Set, replace or take off the person's reaction on one of Gennety's replies.
 * `null` takes it off, and so does the emoji already there — a second tap on
 * the same emoji un-reacts, as in every chat app. Someone else's message is
 * `not-found`, never a hint that it exists.
 */
export async function setPersonReaction(input: {
  userId: string;
  messageId: string;
  emoji: string | null;
  now?: Date;
}): Promise<PersonReactionResult> {
  const emoji = input.emoji === null ? null : normalizeReactionEmoji(input.emoji);
  if (input.emoji !== null && emoji === null) return { ok: false, error: "bad-reaction" };

  const row = await prisma.message.findUnique({
    where: { id: input.messageId },
    select: { id: true, userId: true, role: true, userReaction: true, agentReaction: true },
  });
  if (!row || row.userId !== input.userId) return { ok: false, error: "not-found" };
  if (row.role !== "assistant") return { ok: false, error: "not-assistant" };

  const next = emoji !== null && emoji === row.userReaction ? null : emoji;
  if (next === row.userReaction) return { ok: true, reactions: reactionsView(row) };
  const updated = await prisma.message.update({
    where: { id: row.id },
    data: { userReaction: next, reactedAt: input.now ?? new Date() },
    select: { userReaction: true, agentReaction: true },
  });
  return { ok: true, reactions: reactionsView(updated) };
}

/* ── Gennety's reaction: the guard ──────────────────────────────────────── */

/** A whole message that closes the topic: «ок, спасибо», «понял», «👍». */
export function isClosingTurn(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || [...trimmed].length > AGENT_REACTIONS.closingMaxChars) return false;
  if (trimmed.includes("?")) return false;
  if (isLeavingTurn(trimmed)) return true;
  // Emoji only: every grapheme one of the closing emoji.
  const folded = trimmed.replace(/[️‍\s]/g, "").replace(/\p{Emoji_Modifier}/gu, "");
  if (!folded) return false;
  const glyphs = [...folded];
  return glyphs.length <= 3 && glyphs.every((glyph) => CLOSING_EMOJI.includes(glyph));
}

export interface AgentReactionFacts {
  userText: string;
  imageCount: number;
  /** The turn was sent from a chip, a quote or an inbox item. */
  hasContext: boolean;
  /** The person's newest messages in this chat, newest first, THIS one included. */
  recentUser: ReadonlyArray<{ content: string; agentReaction: string | null }>;
  /** Gennety's newest message before this turn. */
  previousAssistant: { content: string; openOffer: boolean } | null;
  /** The suggested-replies safety latch is set in this chat (danger, crisis, a minor). */
  safetyLatched: boolean;
}

export type AgentReactionGate =
  | { ok: true; occasion: AgentReactionOccasion; emoji: readonly ReactionEmoji[] }
  | { ok: false; reason: string };

/**
 * May Gennety react to this turn? Decided by the server before the model is
 * called: the `react` tool exists only on a turn this lets through, so the
 * prompt is never the only rule.
 *
 * Conservative on purpose — when in doubt, words. Only a short closing
 * message qualifies; never with a photo or a context; never when Gennety's
 * last message asked something or holds an open offer (an «ок» there may be
 * a yes, and a reaction is not a yes); never after sad, anxious, complaint,
 * cancellation or danger words in the person's recent messages or with the
 * chat's safety latch set; at most one among the person's last
 * {@link AGENT_REACTIONS.everyUserMessages} messages, so never two in a row.
 */
export function agentReactionGate(f: AgentReactionFacts): AgentReactionGate {
  if (f.imageCount > 0) return { ok: false, reason: "photo" };
  if (f.hasContext) return { ok: false, reason: "context" };
  if (!isClosingTurn(f.userText)) return { ok: false, reason: "not_closing" };
  if (f.safetyLatched) return { ok: false, reason: "safety" };
  if (f.previousAssistant?.openOffer) return { ok: false, reason: "offer_open" };
  if (f.previousAssistant && f.previousAssistant.content.trim().endsWith("?")) return { ok: false, reason: "question_open" };
  const lookback = f.recentUser.slice(0, AGENT_REACTIONS.safetyLookback).map((row) => row.content);
  if (agentReactionSensitiveHit([f.userText, ...lookback])) return { ok: false, reason: "sensitive" };
  const earlier = f.recentUser.slice(1, AGENT_REACTIONS.everyUserMessages);
  if (earlier[0]?.agentReaction) return { ok: false, reason: "in_a_row" };
  if (earlier.some((row) => row.agentReaction)) return { ok: false, reason: "too_soon" };
  return { ok: true, occasion: "closing", emoji: AGENT_REACTIONS.occasionEmoji.closing };
}

/**
 * The emoji a reaction may carry. The occasion's list, and 🤣 never on a photo
 * or on what they tell about themselves — written out so step 2's wider lists
 * cannot let it through by accident.
 */
export function agentEmojiAllowed(
  emoji: ReactionEmoji,
  ctx: { allowed: readonly ReactionEmoji[]; onPhoto: boolean; aboutThemselves: boolean },
): boolean {
  if (emoji === "🤣" && (ctx.onPhoto || ctx.aboutThemselves)) return false;
  return ctx.allowed.includes(emoji);
}

/** Reads what the guard needs about this chat, after this turn's row is written. */
export async function loadAgentReactionFacts(sessionId: string): Promise<Pick<AgentReactionFacts, "recentUser" | "previousAssistant" | "safetyLatched">> {
  const rows = await prisma.message.findMany({
    where: { sessionId, role: { in: ["user", "assistant"] } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: Math.max(AGENT_REACTIONS.everyUserMessages, AGENT_REACTIONS.safetyLookback) * 2 + 4,
    select: { role: true, content: true, agentReaction: true, attachment: true },
  });
  const recentUser = rows
    .filter((row) => row.role === "user")
    .map((row) => ({ content: row.content ?? "", agentReaction: row.agentReaction ?? null }));
  const assistant = rows.find((row) => row.role === "assistant");
  return {
    recentUser,
    previousAssistant: assistant
      ? { content: assistant.content ?? "", openOffer: readChangeOffer(assistant.attachment)?.state === "open" }
      : null,
    // The chips' safety latch (`suggested-replies.ts`), read inline: that
    // module pulls the moderation client, and this guard needs one flag.
    safetyLatched: rows.some((row) => {
      const raw = row.attachment as { kind?: unknown; safety?: unknown } | null;
      return row.role === "assistant" && raw?.kind === "suggested_replies" && raw.safety === true;
    }),
  };
}

/* ── Gennety's reaction: the tool and its rules ─────────────────────────── */

/** `react`, with exactly the emoji the guard allowed this turn. */
export function reactTool(allowed: readonly ReactionEmoji[]) {
  return {
    type: "function" as const,
    function: {
      name: REACT_TOOL_NAME,
      description:
        "Put one emoji reaction on the person's message of THIS turn instead of replying in words. Then write nothing: an empty reply is the answer. Only when nothing is owed to them.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["emoji"],
        properties: {
          emoji: { type: "string", enum: [...allowed] },
        },
      },
    },
  };
}
export type ReactTool = ReturnType<typeof reactTool>;

/** The prompt block on a turn that offers `react` (step 1: a closing). */
export const AGENT_REACTION_ADDENDUM = `### Reacting instead of a reply (this turn)
Their message closes the topic («ок, спасибо», «понял», 👍). Here you may
answer the way a friend does in a messenger: call react — 🙏 for thanks, 👍
for «ok / got it», ❤ for warm thanks — and then write NOTHING (an empty
reply). Never write an empty «Пожалуйста! Обращайся» or «Рад помочь» after
it. Do it only when nothing is owed: no question of theirs unanswered, no step
or booking to confirm. If something is owed, answer in words and do not react.`;

export type AgentReactionCheck =
  | { ok: true; emoji: ReactionEmoji; result: string }
  | { ok: false; result: string };

/**
 * The model's `react` call, checked by the server. Refused → the model is told
 * to answer in words in the same loop: no second turn, no canned line.
 */
export function checkAgentReaction(
  rawArgs: string | undefined,
  ctx: { gate: AgentReactionGate | null; already: boolean; onPhoto: boolean },
): AgentReactionCheck {
  const refuse = (error: string): AgentReactionCheck => ({
    ok: false,
    result: JSON.stringify({ success: false, error, instruction: "NO reaction was set. Answer them in words now." }),
  });
  if (!ctx.gate?.ok) return refuse("not_allowed");
  if (ctx.already) return refuse("one_reaction_per_turn");
  let raw: unknown = null;
  try {
    raw = (JSON.parse(rawArgs || "{}") as { emoji?: unknown }).emoji;
  } catch {
    // refused below
  }
  const emoji = typeof raw === "string" ? normalizeReactionEmoji(raw) : null;
  if (!emoji || !agentEmojiAllowed(emoji, { allowed: ctx.gate.emoji, onPhoto: ctx.onPhoto, aboutThemselves: false })) {
    return refuse("emoji_not_allowed");
  }
  return {
    ok: true,
    emoji,
    result: JSON.stringify({ success: true, detail: `You reacted ${emoji} to their message. Write nothing more: an empty reply.` }),
  };
}

/* ── what the next turn's model reads ───────────────────────────────────── */

/** A piece of a reply for the prompt line, cut at a word. */
export function reactionExcerpt(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const chars = [...clean];
  if (chars.length <= AGENT_REACTIONS.excerptChars) return clean;
  const head = chars.slice(0, AGENT_REACTIONS.excerptChars).join("");
  const space = head.lastIndexOf(" ");
  return `${(space > AGENT_REACTIONS.excerptChars * 0.5 ? head.slice(0, space) : head).trimEnd()}…`;
}

type ReactionRow = {
  role: string;
  content: string | null;
  createdAt?: Date;
  userReaction?: string | null;
  agentReaction?: string | null;
  reactedAt?: Date | null;
};

/**
 * «They reacted ❤ to your message «…»» — the person's reactions set since
 * their previous message, for the turn answering their newest one. `rows` are
 * this chat's window, oldest first, the turn's own row last.
 */
export function personReactionsBlock(rows: readonly ReactionRow[]): string | null {
  const userRows = rows.filter((row) => row.role === "user");
  const since = userRows.length >= 2 ? userRows[userRows.length - 2]!.createdAt ?? null : null;
  const lines = rows
    .filter((row) => row.role === "assistant" && row.userReaction)
    .filter((row) => !since || !row.reactedAt || row.reactedAt > since)
    .map((row) => `- They reacted ${row.userReaction} to your message «${reactionExcerpt(row.content ?? "")}».`);
  if (lines.length === 0) return null;
  return `## Their reactions since your last reply
${lines.join("\n")}
A reaction is not a reply and not a yes: it books, saves, accepts or confirms
nothing — an offer or a card still waits for their tap or their words. It only
tells you what landed. Do not thank them for it or make it the topic.`;
}

/** The note after an earlier reply of Gennety's that the person reacted to. */
export function assistantReactionNote(row: ReactionRow): string | null {
  return row.role === "assistant" && row.userReaction ? `[They reacted ${row.userReaction} to this message.]` : null;
}

/** The note after a message of theirs Gennety answered with a reaction. */
export function userRowReactionNote(row: ReactionRow): string | null {
  return row.role === "user" && row.agentReaction ? `[You reacted ${row.agentReaction} to this message.]` : null;
}

/* ── the turn that ended in a reaction ──────────────────────────────────── */

/** A turn Gennety answered with a reaction and no words: no assistant row. */
export interface ChatReactionTurn {
  kind: "reaction";
  sessionId: string;
  userMessageId: string;
  /** The typed message stored before the note (decision 2026-11-26). */
  leadMessageId?: string;
  agentReaction: { messageId: string; emoji: string };
}

export function isReactionTurn(turn: object): turn is ChatReactionTurn {
  return (turn as { kind?: unknown }).kind === "reaction";
}
