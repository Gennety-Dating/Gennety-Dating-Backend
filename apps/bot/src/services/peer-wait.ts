import type { Api, RawApi } from "grammy";
import { prisma } from "@gennety/db";
import { t, type Language } from "@gennety/shared";
import { isTelegramTarget, toTelegramChatId } from "../utils/telegram-target.js";
import { AI_EMOJI } from "./ai-emoji.js";
import { sendRichMessageDraft, thinkingHtml } from "./telegram-rich.js";

/**
 * The "waiting on your partner" shimmer (PRODUCT_SPEC §3.6b).
 *
 * The two-sided negotiation steps share a shape: one participant commits their
 * side, and the flow then blocks on the other. Those moments used to answer with
 * one flat line ("saved, we'll tell you when they reply") and then nothing —
 * open the chat an hour later and there is no sign the process is alive rather
 * than stuck. Instead of that line, a `<tg-thinking>` shimmer now plays for the
 * WHOLE wait, its text rotating, and disappears when the partner answers.
 *
 * A rich draft is ephemeral (~30s), so "for the whole wait" means it has to be
 * re-issued on a wall-clock interval. That is what `workers/peer-wait-shimmer.ts`
 * does; this module owns the two primitives it and the action handlers share:
 * which label to show, and how to put it on screen once.
 *
 * The handler that receives the user's action calls `issuePeerWaitDraft`
 * immediately — otherwise the chat would sit empty until the next worker tick.
 * From there the worker keeps the same `draft_id` alive.
 */

/** Distinct, stable draft id per (chat, match, side) so ticks animate as one draft. */
export function peerWaitDraftId(chatId: number, matchId: string, side: "A" | "B"): number {
  // Telegram wants a non-zero int32. Hash the triple so two different waits in
  // the same chat (impossible today — one live match per user — but cheap to be
  // safe) never share, and so the id is STABLE across ticks and restarts: an
  // unstable id would start a second draft instead of refreshing the first.
  let hash = 2166136261;
  for (const ch of `${chatId}:${matchId}:${side}`) {
    hash ^= ch.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const id = Math.abs(hash) % 0x7fffffff;
  return id === 0 ? 1 : id;
}

const ROTATION = ["peerWaitLoop1", "peerWaitLoop2", "peerWaitLoop3"] as const;

/**
 * The line to show on this tick. Rotates through three phrasings so a wait that
 * lasts hours does not read as one frozen string, and personalises with the
 * partner's first name.
 *
 * `firstName` is a required onboarding field and these waits only happen on a
 * live match, so the anonymous variant is defensive rather than expected — but
 * it exists because substituting a generic noun into the personalised templates
 * breaks case agreement in German and Polish.
 */
export function peerWaitLabel(
  lang: Language,
  partnerName: string | null | undefined,
  rotationIndex: number,
): string {
  const name = partnerName?.trim();
  if (!name) return t(lang, "peerWaitLoopAnon");
  const key = ROTATION[Math.abs(Math.trunc(rotationIndex)) % ROTATION.length]!;
  return t(lang, key, { name });
}

/**
 * Put (or refresh) the shimmer on screen once. Re-issuing the same `draft_id`
 * with new html is what both animates the rotation and resets the ~30s TTL.
 *
 * Throws on failure — callers decide what that means. For the worker it means
 * "this chat can't render rich drafts, use the fallback line"; for an action
 * handler it means the same, and the worker will set the fallback up on its next
 * tick rather than the handler duplicating that logic.
 */
export async function issuePeerWaitDraft(
  api: Api<RawApi>,
  chatId: number,
  matchId: string,
  side: "A" | "B",
  lang: Language,
  partnerName: string | null | undefined,
  rotationIndex = 0,
): Promise<void> {
  await sendRichMessageDraft(api, {
    chat_id: chatId,
    draft_id: peerWaitDraftId(chatId, matchId, side),
    rich_message: {
      html: thinkingHtml(peerWaitLabel(lang, partnerName, rotationIndex), AI_EMOJI.think),
    },
  });
}

/**
 * Fire-and-forget wrapper for the action handlers: start the shimmer the instant
 * the user commits, so the chat isn't empty until the next worker tick (up to
 * 20s later). From there `workers/peer-wait-shimmer.ts` keeps the same draft id
 * alive for the rest of the wait.
 *
 * Resolves the side, language and partner name itself so every call site is one
 * line — the callers are Mini App response paths and a callback handler, none of
 * which should be plumbing render data around for a cosmetic draft.
 *
 * Swallows everything. A chat that can't render rich drafts is picked up by the
 * worker's fallback path on its next tick; a chat we can't reach at all needs no
 * shimmer. Neither may break the flow this decorates.
 */
export function startPeerWaitShimmer(
  api: Api<RawApi>,
  matchId: string,
  userId: string,
): void {
  void (async () => {
    const match = await prisma.match.findUnique({
      where: { id: matchId },
      select: {
        userAId: true,
        userA: { select: { telegramId: true, language: true, firstName: true } },
        userB: { select: { telegramId: true, language: true, firstName: true } },
      },
    });
    if (!match) return;
    const isA = match.userAId === userId;
    const me = isA ? match.userA : match.userB;
    const peer = isA ? match.userB : match.userA;
    if (!isTelegramTarget(me.telegramId)) return;
    await issuePeerWaitDraft(
      api,
      toTelegramChatId(me.telegramId),
      matchId,
      isA ? "A" : "B",
      (me.language ?? "en") as Language,
      peer.firstName,
    );
  })().catch(() => {});
}
